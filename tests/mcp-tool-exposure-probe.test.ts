import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifySdkDiagnosticsForSpec,
  classifySdkRoleFailureCode,
  classifySdkRoleObservation,
  classifyToolListResult,
  deriveSdkPerSpecResult,
  extractHermesToolNames,
  extractSdkSystemToolNames,
  MCP_TOOL_EXPOSURE_SPECS,
  normalizeMcpToolName,
  observeSdkRoleRun,
  redactSensitiveText,
  runHermesGatewayMcpToolExposureProbe,
  runSdkMcpToolExposureProbe,
  type SdkRoleRunResult,
  type SdkToolDiagnostics,
} from "../src/core/harness/McpToolExposureProbe.js";
import { parseServiceConfig, type CursorSettingSource } from "../src/core/config/Config.js";
import { testConfig } from "./helpers.js";
import type { GatewayEvent, HermesGatewayClient, HermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";

describe("MCP tool exposure probe helpers", () => {
  it("normalizes only bare and known server-prefixed Symphony MCP tool names", () => {
    expect(normalizeMcpToolName("submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("symphony.submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("mcp_symphony_submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("symphony_conflicts.submit_merge_conflict_resolution")).toBeNull();
    expect(normalizeMcpToolName("merge-conflict-resolution-mcp:submit_merge_conflict_resolution")).toBeNull();
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

  it("extracts Hermes gateway tool names from toolset responses", () => {
    expect(
      extractHermesToolNames({
        toolsets: [
          {
            name: "mcp-symphony",
            tools: ["mcp_symphony_submit_completion_report", { name: "mcp_symphony_review_verdict_submit_review_verdict" }],
          },
          {
            name: "mcp-symphony-review-feedback",
            tools: [{ schema: { name: "mcp_symphony_review_feedback_submit_pull_request_review_feedback" } }],
          },
        ],
      }),
    ).toEqual([
      "mcp_symphony_submit_completion_report",
      "mcp-symphony.mcp_symphony_submit_completion_report",
      "mcp_symphony_review_verdict_submit_review_verdict",
      "mcp-symphony.mcp_symphony_review_verdict_submit_review_verdict",
      "mcp_symphony_review_feedback_submit_pull_request_review_feedback",
      "mcp-symphony-review-feedback.mcp_symphony_review_feedback_submit_pull_request_review_feedback",
    ]);
  });

  it("verifies expected Symphony tools through a live Hermes gateway facade", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-mcp-probe-"));
    try {
      await writeHermesTemplates(root);
      const clients: FakeHermesGatewayClient[] = [];
      const hookVerifications: unknown[] = [];
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          workspace: { root: path.join(root, "workspaces"), state_dir: path.join(root, "state") },
          agent: { harness: "hermes" },
          hermes: {
            upstream_root: path.join(root, "upstream"),
            templates_dir: path.join(root, "templates"),
            state_dir: path.join(root, "state", "hermes"),
            provider: "openai-codex",
            model: "gpt-5-test",
            auth: { managed_root: path.join(root, "auth") },
          },
        },
        path.join(root, "WORKFLOW.md"),
        { LINEAR_API_KEY: "linear-secret" },
      );

      await expect(
        runHermesGatewayMcpToolExposureProbe(config, {
          cliPath: path.join(root, "cli.ts"),
          roles: ["worker", "reviewer"],
          enabled: true,
          cwd: path.join(root, "workspace"),
          commandPolicyHookVerifier: async (verification) => {
            hookVerifications.push(verification);
          },
          gatewayFactory: (env) => {
            const client = new FakeHermesGatewayClient(env);
            clients.push(client);
            return client;
          },
        }),
      ).resolves.toMatchObject({
        stage: "hermes_gateway",
        status: "success",
        failureCode: null,
        results: [
          { status: "success", expectedTool: "submit_completion_report" },
          { status: "success", expectedTool: "submit_review_verdict" },
          { status: "success", expectedTool: "submit_pull_request_review_feedback" },
        ],
      });
      expect(clients).toHaveLength(2);
      expect(hookVerifications).toHaveLength(2);
      expect(clients.map((client) => client.env.model)).toEqual(["gpt-5-test", "gpt-5-test"]);
      expect(clients.every((client) => client.env.provider === "openai-codex")).toBe(true);
      expect(clients.flatMap((client) => client.requests.map((request) => request.method))).toContain("tools.list");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails Hermes gateway exposure before session/tools when command-policy hook validation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-mcp-probe-"));
    try {
      await writeHermesTemplates(root);
      const clients: FakeHermesGatewayClient[] = [];
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          workspace: { root: path.join(root, "workspaces"), state_dir: path.join(root, "state") },
          agent: { harness: "hermes" },
          hermes: {
            upstream_root: path.join(root, "upstream"),
            templates_dir: path.join(root, "templates"),
            state_dir: path.join(root, "state", "hermes"),
          },
        },
        path.join(root, "WORKFLOW.md"),
        { LINEAR_API_KEY: "linear-secret" },
      );

      const result = await runHermesGatewayMcpToolExposureProbe(config, {
        cliPath: path.join(root, "cli.ts"),
        roles: ["worker"],
        enabled: true,
        cwd: path.join(root, "workspace"),
        commandPolicyHookVerifier: async () => {
          throw new Error("hook registration unavailable");
        },
        gatewayFactory: (env) => {
          const client = new FakeHermesGatewayClient(env);
          clients.push(client);
          return client;
        },
      });

      expect(result).toMatchObject({
        stage: "hermes_gateway",
        status: "failure",
        failureCode: "hermes_gateway_startup_failure",
        results: [{ status: "failure", failureCode: "hermes_gateway_startup_failure" }],
      });
      expect(result.message).toContain("hook registration unavailable");
      expect(clients).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
        { role: "worker", runPhase: "implementation", roleStatus: "skipped", primaryFailureCode: null },
        { role: "reviewer", runPhase: "review", roleStatus: "skipped", primaryFailureCode: null },
      ],
      results: [
        { status: "skipped", sdkRoleRunRole: "worker", sdkRoleRunPhase: "implementation", sdkRoleRunIndex: 0 },
        { status: "skipped", sdkRoleRunRole: "reviewer", sdkRoleRunPhase: "review", sdkRoleRunIndex: 1 },
        { status: "skipped", sdkRoleRunRole: "reviewer", sdkRoleRunPhase: "review", sdkRoleRunIndex: 1 },
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
        { role: "worker", runPhase: "implementation", roleStatus: "failure", primaryFailureCode: "sdk_credentials_missing" },
        { role: "reviewer", runPhase: "review", roleStatus: "failure", primaryFailureCode: "sdk_credentials_missing" },
      ],
      results: [
        {
          status: "failure",
          failureCode: "sdk_credentials_missing",
          sdkRoleRunRole: "worker",
          sdkRoleRunPhase: "implementation",
          sdkRoleRunIndex: 0,
        },
        {
          status: "failure",
          failureCode: "sdk_credentials_missing",
          sdkRoleRunRole: "reviewer",
          sdkRoleRunPhase: "review",
          sdkRoleRunIndex: 1,
        },
        {
          status: "failure",
          failureCode: "sdk_credentials_missing",
          sdkRoleRunRole: "reviewer",
          sdkRoleRunPhase: "review",
          sdkRoleRunIndex: 1,
        },
      ],
    });
    vi.unstubAllEnvs();
  });

  it("disposes a created SDK agent when send fails during startup", async () => {
    vi.resetModules();
    const dispose = vi.fn(async () => undefined);
    const createOptions: unknown[] = [];
    const sendOptions: unknown[] = [];
    const send = vi.fn(async (_prompt: string, options: unknown) => {
      sendOptions.push(options);
      throw new Error("send failed after create");
    });
    vi.doMock("@cursor/sdk", () => ({
      Agent: {
        create: vi.fn(async (options: unknown) => {
          createOptions.push(options);
          return {
            agentId: "agent-after-create",
            send,
            [Symbol.asyncDispose]: dispose,
          };
        }),
      },
    }));
    vi.stubEnv("CURSOR_API_KEY", "cursor_test_key_for_send_failure");
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-mcp-send-failure-"));
    try {
      const { runSdkMcpToolExposureProbe: runProbeWithMockedSdk } = await import(
        "../src/core/harness/McpToolExposureProbe.js"
      );
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          workspace: { root: path.join(root, "workspaces") },
          cursor: { mode: "plan" },
        },
        path.join(root, "WORKFLOW.md"),
        {
          LINEAR_API_KEY: "linear-secret",
          CURSOR_API_KEY: "cursor_test_key_for_send_failure",
        },
      );
      await expect(
        runProbeWithMockedSdk(config, {
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
            runPhase: "implementation",
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
            sdkRoleRunPhase: "implementation",
            sdkRoleRunIndex: 0,
          },
        ],
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(createOptions[0]).toMatchObject({ mode: "plan" });
      expect(sendOptions[0]).toMatchObject({ mode: "plan" });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("@cursor/sdk");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses role-resolved runtime.cursor profiles for live SDK probe startup", async () => {
    vi.resetModules();
    const apiKeys: Array<string | undefined> = [];
    const dispose = vi.fn(async () => undefined);
    const send = vi.fn(async () => {
      throw new Error("send failed after create");
    });
    vi.doMock("@cursor/sdk", () => ({
      Agent: {
        create: vi.fn(async (options: { apiKey?: string }) => {
          apiKeys.push(options.apiKey);
          return {
            agentId: `agent-${apiKeys.length}`,
            send,
            [Symbol.asyncDispose]: dispose,
          };
        }),
      },
    }));
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-mcp-profile-cursor-"));
    try {
      const { runSdkMcpToolExposureProbe: runProbeWithMockedSdk } = await import(
        "../src/core/harness/McpToolExposureProbe.js"
      );
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          workspace: { root: path.join(root, "workspaces") },
          credential_profiles: {
            profiles: {
              workerCursor: { value: "$WORKER_CURSOR_TOKEN", capabilities: ["runtime.cursor"] },
              reviewerCursor: { value: "$REVIEWER_CURSOR_TOKEN", capabilities: ["runtime.cursor"] },
            },
            roles: {
              worker: { "runtime.cursor": "workerCursor" },
              reviewer: { "runtime.cursor": "reviewerCursor" },
            },
          },
        },
        path.join(root, "WORKFLOW.md"),
        {
          LINEAR_API_KEY: "linear-secret",
          CURSOR_API_KEY: "decoy-cursor-secret",
          WORKER_CURSOR_TOKEN: "worker-cursor-secret",
          REVIEWER_CURSOR_TOKEN: "reviewer-cursor-secret",
        },
      );

      await runProbeWithMockedSdk(config, {
        cliPath: "/repo/src/cli.ts",
        roles: ["worker", "reviewer"],
        enabled: true,
        timeoutMs: 45_000,
      });

      expect(apiKeys).toEqual(["worker-cursor-secret", "reviewer-cursor-secret"]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally {
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

class FakeHermesGatewayClient extends EventEmitter implements HermesGatewayClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly killed: string[] = [];

  constructor(readonly env: HermesGatewayEnvironment) {
    super();
  }

  on(event: "event", listener: (event: GatewayEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.on(event, listener);
  }

  off(event: "event", listener: (event: GatewayEvent) => void): this;
  off(event: "exit", listener: (code: number | null) => void): this;
  off(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.off(event, listener);
  }

  drain(): void {
    return;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });
    if (method === "session.create") return { session_id: `session-${this.requests.length}` } as T;
    if (method === "tools.list") {
      return {
        toolsets: [
          {
            name: "mcp-symphony",
            tools: [
              "mcp_symphony_submit_completion_report",
              "mcp_symphony_conflicts_submit_merge_conflict_resolution",
              "mcp_symphony_review_verdict_submit_review_verdict",
              "mcp_symphony_review_feedback_submit_pull_request_review_feedback",
            ],
          },
        ],
      } as T;
    }
    return { ok: true } as T;
  }

  kill(reason?: string): void {
    this.killed.push(reason ?? "");
  }

  getLogTail(): string {
    return "";
  }
}

async function writeHermesTemplates(root: string): Promise<void> {
  for (const template of ["worker", "reviewer", "planner"]) {
    const templateDir = path.join(root, "templates", template);
    await mkdir(templateDir, { recursive: true });
    await writeFile(path.join(templateDir, "SOUL.md"), `${template} soul\n`, "utf8");
    await writeFile(path.join(templateDir, "config.yaml"), "memory_enabled: false\n", "utf8");
  }
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
    cursorMode: overrides.cursorMode ?? null,
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
