import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifySdkDiagnosticsForSpec,
  classifySdkRoleFailureCode,
  classifySdkRoleObservation,
  classifyToolListResult,
  deriveSdkPerSpecResult,
  extractSdkSystemToolNames,
  MCP_TOOL_EXPOSURE_SPECS,
  normalizeMcpToolName,
  observeSdkRoleRun,
  redactSensitiveText,
  runSdkMcpToolExposureProbe,
  type SdkRoleRunResult,
  type SdkToolDiagnostics,
} from "../src/core/harness/McpToolExposureProbe.js";
import type { CursorSettingSource } from "../src/core/config/Config.js";
import { testConfig } from "./helpers.js";

describe("MCP tool exposure probe helpers", () => {
  it("normalizes only bare and known server-prefixed Symphony MCP tool names", () => {
    expect(normalizeMcpToolName("submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("symphony.submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("mcp_symphony_submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("review-verdict-mcp:submit_review_verdict")).toBe("submit_review_verdict");
    expect(normalizeMcpToolName("mcp_symphony_review_feedback_submit_pull_request_review_feedback")).toBe(
      "submit_pull_request_review_feedback",
    );
    expect(normalizeMcpToolName("evil_symphony_submit_completion_report")).toBeNull();
    expect(normalizeMcpToolName("mcp_unknown_submit_completion_report")).toBeNull();
    expect(normalizeMcpToolName("symphony.submit_completion_report_extra")).toBeNull();
  });

  it("classifies subprocess empty and mismatch results separately from success", () => {
    const workerSpec = MCP_TOOL_EXPOSURE_SPECS[0];
    expect(workerSpec).toBeDefined();
    if (!workerSpec) throw new Error("missing worker spec");

    expect(classifyToolListResult("subprocess", workerSpec, [], ["LINEAR_API_KEY"])).toMatchObject({
      status: "failure",
      failureCode: "subprocess_missing_empty_name_mismatch",
      envKeyNames: ["LINEAR_API_KEY"],
    });
    expect(classifyToolListResult("subprocess", workerSpec, ["unexpected"], ["B_KEY", "A_KEY"])).toMatchObject({
      status: "failure",
      failureCode: "subprocess_missing_empty_name_mismatch",
      rawToolNames: ["unexpected"],
      envKeyNames: ["A_KEY", "B_KEY"],
    });
    expect(classifySdkDiagnosticsForSpec(workerSpec, sdkObservation({ rawToolNames: ["mcp_symphony_submit_completion_report"] }))).toMatchObject(
      {
        status: "success",
        failureCode: null,
        normalizedToolNames: ["submit_completion_report"],
      },
    );
  });

  it("extracts SDK system tool names and counts unnamed or malformed entries", () => {
    expect(
      extractSdkSystemToolNames([
        "mcp_symphony_submit_completion_report",
        { name: "symphony_review_verdict.submit_review_verdict" },
        { name: "" },
        { description: "missing a name" },
        42,
      ]),
    ).toMatchObject({
      rawToolNames: ["mcp_symphony_submit_completion_report", "symphony_review_verdict.submit_review_verdict"],
      normalizedToolNames: ["submit_completion_report", "submit_review_verdict"],
      systemToolsCount: 5,
      namedToolCount: 2,
      unnamedToolObjectCount: 2,
      malformedToolObjectCount: 1,
    });
  });

  it("aggregates SDK tools across multiple system messages before classifying reviewer success", async () => {
    const roleRun = await observeSdkRoleRun({
      role: "reviewer",
      agentId: "agent-1",
      runId: "run-1",
      roleSpecs: MCP_TOOL_EXPOSURE_SPECS.filter((spec) => spec.role === "reviewer"),
      run: fakeRun([
        { type: "system", tools: [{ name: "symphony_review_verdict.submit_review_verdict" }] },
        { type: "assistant", message: { content: [{ type: "text", text: "checking" }] } },
        { type: "system", tools: [{ name: "symphony_review_feedback.submit_pull_request_review_feedback" }] },
      ]),
      ...sdkObserveOptions("reviewer"),
    });

    expect(roleRun).toMatchObject({
      roleStatus: "success",
      primaryFailureCode: null,
      sdkObservation: {
        systemMessageCount: 2,
        systemToolPayloadCount: 2,
        rawToolNames: [
          "symphony_review_verdict.submit_review_verdict",
          "symphony_review_feedback.submit_pull_request_review_feedback",
        ],
        normalizedToolNames: ["submit_review_verdict", "submit_pull_request_review_feedback"],
      },
    });
  });

  it("distinguishes unsupported stream, timeout, unexpected tool call, and unsupported wait", async () => {
    await expect(
      observeSdkRoleRun({
        role: "worker",
        agentId: "agent-1",
        runId: "run-1",
        run: { wait: async () => ({ status: "finished" }), cancel: async () => undefined } as never,
        ...sdkObserveOptions("worker"),
      }),
    ).resolves.toMatchObject({
      primaryFailureCode: "sdk_stream_unsupported",
      roleStatus: "failure",
      sdkObservation: { supportsStream: false, streamStatus: "unsupported" },
    });

    let cancelled = false;
    await expect(
      observeSdkRoleRun({
        role: "worker",
        agentId: "agent-1",
        runId: "run-2",
        run: {
          stream: async function* () {
            await new Promise(() => undefined);
          },
          wait: async () => ({ status: "cancelled" }),
          cancel: async () => {
            cancelled = true;
          },
        } as never,
        ...sdkObserveOptions("worker", { sdkTimeoutMs: 5, postCancelWaitMs: 5 }),
      }),
    ).resolves.toMatchObject({
      primaryFailureCode: "sdk_stream_timeout",
      roleStatus: "failure",
      sdkObservation: { timedOut: true, cancelledAfterTimeout: true, streamStatus: "timeout" },
    });
    expect(cancelled).toBe(true);

    await expect(
      observeSdkRoleRun({
        role: "worker",
        agentId: "agent-1",
        runId: "run-3",
        run: fakeRun([{ type: "tool_call", name: "dangerous_tool" }]),
        ...sdkObserveOptions("worker"),
      }),
    ).resolves.toMatchObject({
      primaryFailureCode: "unexpected_tool_call",
      roleStatus: "failure",
      sdkObservation: { unexpectedToolCall: "dangerous_tool", streamStatus: "unexpected_tool_call" },
    });

    await expect(
      observeSdkRoleRun({
        role: "worker",
        agentId: "agent-1",
        runId: "run-4",
        run: fakeRun([{ type: "system", tools: [{ name: "mcp_symphony_submit_completion_report" }] }], { wait: undefined }),
        ...sdkObserveOptions("worker"),
      }),
    ).resolves.toMatchObject({
      primaryFailureCode: null,
      roleStatus: "success",
      sdkObservation: { supportsWait: false, waitStatus: "unsupported" },
    });
  });

  it("classifies SDK no-system, absent, empty, unnamed, mismatch, and wait failure diagnostics", () => {
    const workerSpec = MCP_TOOL_EXPOSURE_SPECS[0];
    expect(workerSpec).toBeDefined();
    if (!workerSpec) throw new Error("missing worker spec");

    expect(classifySdkRoleFailureCode(sdkObservation())).toBe("sdk_no_system_messages");
    expect(
      classifySdkDiagnosticsForSpec(
        workerSpec,
        sdkObservation({
          mcpTraceMethodsByServer: { "symphony-completion-report": ["notifications/initialized", "tools/list"] },
        }),
      ),
    ).toMatchObject({ status: "success", failureCode: null, normalizedToolNames: [workerSpec.expectedTool] });
    expect(classifySdkRoleFailureCode(sdkObservation({ systemMessageCount: 1 }))).toBe("sdk_system_tools_absent");
    expect(classifySdkRoleFailureCode(sdkObservation({ systemMessageCount: 1, systemToolPayloadCount: 1 }))).toBe(
      "sdk_system_tools_empty",
    );
    expect(
      classifySdkRoleFailureCode(
        sdkObservation({
          systemMessageCount: 1,
          systemToolPayloadCount: 1,
          systemToolsCount: 2,
          unnamedToolObjectCount: 1,
          malformedToolObjectCount: 1,
        }),
      ),
    ).toBe("sdk_system_tools_unnamed");
    expect(
      classifySdkDiagnosticsForSpec(
        workerSpec,
        sdkObservation({ rawToolNames: ["unrelated"], systemMessageCount: 1, systemToolPayloadCount: 1, systemToolsCount: 1 }),
      ),
    ).toMatchObject({ status: "failure", failureCode: "sdk_system_tools_name_mismatch" });
    expect(
      classifySdkDiagnosticsForSpec(
        workerSpec,
        sdkObservation({
          rawToolNames: ["mcp_symphony_submit_completion_report"],
          systemMessageCount: 1,
          systemToolPayloadCount: 1,
          systemToolsCount: 1,
          waitStatus: "error",
          waitError: "boom",
        }),
      ),
    ).toMatchObject({ status: "failure", failureCode: "sdk_wait_failure" });
  });

  it("derives startup role runs, reviewer partial rows, and SDK row backrefs without subprocess classification", () => {
    const reviewerSpecs = MCP_TOOL_EXPOSURE_SPECS.filter((spec) => spec.role === "reviewer");
    const partialObservation = sdkObservation({
      role: "reviewer",
      rawToolNames: ["symphony_review_verdict.submit_review_verdict"],
      systemMessageCount: 1,
      systemToolPayloadCount: 1,
      systemToolsCount: 1,
    });
    expect(classifySdkRoleObservation(partialObservation, reviewerSpecs)).toMatchObject({
      primaryFailureCode: "sdk_system_tools_name_mismatch",
      roleStatus: "partial",
    });
    const roleRun: SdkRoleRunResult = {
      role: "reviewer",
      agentId: "agent-1",
      runId: "run-1",
      primaryFailureCode: "sdk_system_tools_name_mismatch",
      roleStatus: "partial",
      sdkObservation: partialObservation,
    };
    expect(reviewerSpecs.map((spec) => deriveSdkPerSpecResult(spec, roleRun, 2))).toMatchObject([
      { status: "success", failureCode: null, sdkRoleRunRole: "reviewer", sdkRoleRunIndex: 2 },
      { status: "failure", failureCode: "sdk_system_tools_name_mismatch", sdkRoleRunRole: "reviewer", sdkRoleRunIndex: 2 },
    ]);

    const partialTraceObservation = sdkObservation({
      role: "reviewer",
      mcpTraceMethodsByServer: { "symphony-review-verdict": ["tools/list"] },
    });
    const partialTraceRun: SdkRoleRunResult = {
      role: "reviewer",
      agentId: "agent-2",
      runId: "run-2",
      ...classifySdkRoleObservation(partialTraceObservation, reviewerSpecs),
      sdkObservation: partialTraceObservation,
    };
    expect(partialTraceRun).toMatchObject({ primaryFailureCode: "sdk_no_system_messages", roleStatus: "partial" });
    expect(reviewerSpecs.map((spec) => deriveSdkPerSpecResult(spec, partialTraceRun, 3))).toMatchObject([
      { status: "success", failureCode: null, sdkRoleRunIndex: 3 },
      { status: "failure", failureCode: "sdk_no_system_messages", sdkRoleRunIndex: 3 },
    ]);

    const startupObservation = sdkObservation({ startupSendError: "Cursor SDK startup/send failed" });
    expect(classifySdkRoleObservation(startupObservation, [MCP_TOOL_EXPOSURE_SPECS[0]!])).toMatchObject({
      primaryFailureCode: "sdk_startup_send_failure",
      roleStatus: "failure",
    });
  });

  it("summarizes skipped and missing-credential SDK stages with role runs and deterministic backrefs", async () => {
    const config = testConfig("/tmp/symphony-workspaces");
    await expect(
      runSdkMcpToolExposureProbe(config, {
        cliPath: "/repo/src/cli.ts",
        enabled: false,
        timeoutMs: 45_000,
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      sdkRoleRuns: [
        { role: "worker", roleStatus: "skipped", primaryFailureCode: null },
        { role: "reviewer", roleStatus: "skipped", primaryFailureCode: null },
      ],
      results: [
        { status: "skipped", sdkRoleRunRole: "worker", sdkRoleRunIndex: 0 },
        { status: "skipped", sdkRoleRunRole: "reviewer", sdkRoleRunIndex: 1 },
        { status: "skipped", sdkRoleRunRole: "reviewer", sdkRoleRunIndex: 1 },
      ],
    });

    vi.stubEnv("CURSOR_API_KEY", "");
    await expect(
      runSdkMcpToolExposureProbe(config, {
        cliPath: "/repo/src/cli.ts",
        enabled: true,
        timeoutMs: 45_000,
      }),
    ).resolves.toMatchObject({
      status: "failure",
      failureCode: "sdk_credentials_missing",
      sdkRoleRuns: [
        { role: "worker", roleStatus: "failure", primaryFailureCode: "sdk_credentials_missing" },
        { role: "reviewer", roleStatus: "failure", primaryFailureCode: "sdk_credentials_missing" },
      ],
      results: [
        { status: "failure", failureCode: "sdk_credentials_missing", sdkRoleRunRole: "worker", sdkRoleRunIndex: 0 },
        { status: "failure", failureCode: "sdk_credentials_missing", sdkRoleRunRole: "reviewer", sdkRoleRunIndex: 1 },
        { status: "failure", failureCode: "sdk_credentials_missing", sdkRoleRunRole: "reviewer", sdkRoleRunIndex: 1 },
      ],
    });
    vi.unstubAllEnvs();
  });

  it("disposes a created SDK agent when send fails during startup", async () => {
    vi.resetModules();
    const dispose = vi.fn(async () => undefined);
    const send = vi.fn(async () => {
      throw new Error("send failed after create");
    });
    vi.doMock("@cursor/sdk", () => ({
      Agent: {
        create: vi.fn(async () => ({
          agentId: "agent-after-create",
          send,
          [Symbol.asyncDispose]: dispose,
        })),
      },
    }));
    vi.stubEnv("CURSOR_API_KEY", "cursor_test_key_for_send_failure");
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-mcp-send-failure-"));
    try {
      const { runSdkMcpToolExposureProbe: runProbeWithMockedSdk } = await import(
        "../src/core/harness/McpToolExposureProbe.js"
      );
      await expect(
        runProbeWithMockedSdk(testConfig(path.join(root, "workspaces")), {
          cliPath: "/repo/src/cli.ts",
          roles: ["worker"],
          enabled: true,
          timeoutMs: 45_000,
        }),
      ).resolves.toMatchObject({
        status: "failure",
        failureCode: "sdk_startup_send_failure",
        sdkRoleRuns: [
          {
            role: "worker",
            agentId: "agent-after-create",
            runId: null,
            primaryFailureCode: "sdk_startup_send_failure",
            roleStatus: "failure",
          },
        ],
        results: [
          {
            failureCode: "sdk_startup_send_failure",
            sdkRoleRunRole: "worker",
            sdkRoleRunIndex: 0,
          },
        ],
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("@cursor/sdk");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts common token forms and configured secret values", () => {
    vi.stubEnv("CURSOR_API_KEY", "cursor_secret_from_env");
    expect(
      redactSensitiveText(
        "Authorization: Bearer cursor_secret_from_env GITHUB_TOKEN=ghp_1234567890abcdef token: \"github_pat_1234567890abcdef\"",
      ),
    ).toBe('Authorization: Bearer [REDACTED] GITHUB_TOKEN=[REDACTED] token: "[REDACTED]"');
    expect(redactSensitiveText("failed with value custom-secret", ["custom-secret"])).toBe("failed with value [REDACTED]");
    vi.unstubAllEnvs();
  });
});

function sdkObserveOptions(_role: "worker" | "reviewer", overrides: Partial<SdkToolDiagnostics> = {}) {
  return {
    agentCwd: "/repo",
    mcpCwd: "/repo",
    settingSources: ["project", "user"] as CursorSettingSource[],
    sdkTimeoutMs: overrides.sdkTimeoutMs ?? 100,
    waitTimeoutMs: overrides.waitTimeoutMs ?? 100,
    postCancelWaitMs: overrides.postCancelWaitMs ?? 100,
  };
}

function sdkObservation(overrides: Partial<SdkToolDiagnostics> = {}): SdkToolDiagnostics {
  const rawToolNames = overrides.rawToolNames ?? [];
  const normalizedToolNames =
    overrides.normalizedToolNames ??
    rawToolNames.map((name) => normalizeMcpToolName(name)).filter((name): name is string => name !== null);
  return {
    role: overrides.role ?? "worker",
    agentCwd: overrides.agentCwd ?? "/repo",
    mcpCwd: overrides.mcpCwd ?? "/repo",
    settingSources: overrides.settingSources ?? ["project", "user"],
    sdkTimeoutMs: overrides.sdkTimeoutMs ?? 45_000,
    waitTimeoutMs: overrides.waitTimeoutMs ?? 5_000,
    postCancelWaitMs: overrides.postCancelWaitMs ?? 1_500,
    supportsStream: overrides.supportsStream ?? true,
    supportsWait: overrides.supportsWait ?? true,
    streamStatus: overrides.streamStatus ?? "drained",
    waitStatus: overrides.waitStatus ?? "finished",
    waitError: overrides.waitError ?? null,
    timedOut: overrides.timedOut ?? false,
    cancelledAfterTimeout: overrides.cancelledAfterTimeout ?? false,
    startupSendError: overrides.startupSendError ?? null,
    unexpectedToolCall: overrides.unexpectedToolCall ?? null,
    systemMessageCount: overrides.systemMessageCount ?? (rawToolNames.length > 0 ? 1 : 0),
    systemToolPayloadCount: overrides.systemToolPayloadCount ?? (rawToolNames.length > 0 ? 1 : 0),
    systemToolsCount: overrides.systemToolsCount ?? rawToolNames.length,
    namedToolCount: overrides.namedToolCount ?? rawToolNames.length,
    unnamedToolObjectCount: overrides.unnamedToolObjectCount ?? 0,
    malformedToolObjectCount: overrides.malformedToolObjectCount ?? 0,
    rawSystemToolPayloads: overrides.rawSystemToolPayloads ?? [],
    rawToolNames,
    normalizedToolNames,
    mcpTraceFile: overrides.mcpTraceFile ?? null,
    mcpTraceMethodsByServer: overrides.mcpTraceMethodsByServer ?? {},
    observedMessageTypes: overrides.observedMessageTypes ?? [],
    messageTypeCounts: overrides.messageTypeCounts ?? {},
    streamError: overrides.streamError ?? null,
  };
}

function fakeRun(messages: unknown[], options: { wait?: (() => Promise<unknown>) | undefined } = {}) {
  const wait = Object.prototype.hasOwnProperty.call(options, "wait") ? options.wait : async () => ({ status: "finished" });
  return {
    stream: async function* () {
      for (const message of messages) yield message;
    },
    ...(wait === undefined ? {} : { wait }),
    cancel: async () => undefined,
  } as never;
}
