import { describe, expect, it, vi } from "vitest";
import type { HostHermesAcpJsonRpcRequest } from "../hermes/src/HostHermesAcpFacade.js";
import type { HermesAcpPermissionResolverInput } from "../hermes/src/HermesAcpHarness.js";
import {
  parseHermesAcpPermissionRequest,
  resolveHermesAcpPermissionDecision,
} from "../hermes/src/HermesAcpPermissions.js";
import type { AgentCommandPolicyInput } from "../src/core/harness/AgentCommandPolicy.js";
import type { AgentRunContext } from "../src/core/harness/AgentHarness.js";
import {
  DEFAULT_AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_ID,
  DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_APPROVAL_BRIDGE_MISSING_REASON,
  DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_DENY_REASON,
  DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON,
  buildAgentCommandPolicyInputForAcpPermission,
  createAgentCommandPolicyAcpResolver,
  isAgentCommandPolicyAcpAllowOptionId,
  mapAgentCommandPolicyDecisionToAcpPermissionDecision,
  mapAgentCommandPolicyOutcomeToAcpPermissionDecision,
} from "../src/core/harness/AgentCommandPolicyAcpResolver.js";
import type { Issue } from "../src/core/types.js";
import { allowPolicyDecision, denyPolicyDecision } from "./agent-command-policy-fixtures.js";

describe("AgentCommandPolicyAcpResolver", () => {
  it("builds redacted terminal policy input from ACP permission requests", () => {
    const input = resolverInput(terminalPermissionRequest("git push origin HEAD"));

    const result = buildAgentCommandPolicyInputForAcpPermission(input, {
      environment: { GITHUB_TOKEN: "secret-token", PATH: "/usr/bin", HOME: "/tmp/home" },
    });

    expect(result).toEqual({
      status: "ok",
      input: expect.objectContaining({
        attemptId: "perm-tool-1",
        runId: "run-acp-policy-1",
        issueId: "issue-acp-policy-1",
        role: "worker",
        phase: "implementation",
        surface: "terminal_execute",
        workingDirectory: "/workspace/symphony",
        rawInput: expect.objectContaining({
          kind: "command",
          command: "git push origin HEAD",
        }),
        environment: { keysOnly: ["GITHUB_TOKEN", "HOME", "PATH"] },
      }),
    });
  });

  it("normalizes ACP cmd and script terminal fields before policy classification", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      allowPolicyDecision({ reasonKind: "local_only_inspection", commandClass: "local_git_inspection" }),
    );
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      environment: { PATH: "/usr/bin" },
    });

    await expect(resolver(resolverInput(terminalPermissionRequest("git status --short", { field: "cmd" })))).resolves.toEqual({
      optionId: "allow_once",
      reason: "local_only_inspection",
    });
    await expect(resolver(resolverInput(terminalPermissionRequest("git status --short", { field: "script" })))).resolves.toEqual({
      optionId: "allow_once",
      reason: "local_only_inspection",
    });

    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls.map(([policyInput]) => policyInput.rawInput)).toEqual([
      expect.objectContaining({ kind: "command", command: "git status --short" }),
      expect.objectContaining({ kind: "command", command: "git status --short" }),
    ]);
  });

  it("uses the raw input command from real ACP terminal permission payloads with display content", async () => {
    const input = resolverInput(terminalPermissionRequest("git status --short", { realAcpDisplayContent: true, snakeCase: true }));
    const resolver = createAgentCommandPolicyAcpResolver({ environment: { PATH: "/usr/bin" } });

    const result = buildAgentCommandPolicyInputForAcpPermission(input, {
      environment: { PATH: "/usr/bin" },
    });

    expect(result).toEqual({
      status: "ok",
      input: expect.objectContaining({
        attemptId: "perm-tool-1",
        surface: "terminal_execute",
        rawInput: expect.objectContaining({
          kind: "command",
          command: "git status --short",
        }),
      }),
    });
    await expect(resolver(input)).resolves.toEqual({ optionId: "allow_once", reason: "local_only_inspection" });
  });

  it("validates and approves ACP file-edit permission requests without command classification", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const fileEditApproval = vi.fn(() => ({ outcome: "approve" as const, reason: "file_edit_operator_approved" }));
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      fileEditApproval,
      environment: { GITHUB_TOKEN: "secret-token", PATH: "/usr/bin" },
    });
    const input = resolverInput(editPermissionRequest({ snakeCase: true }));

    const decision = await resolver(input);

    expect(decision).toEqual({ optionId: "allow_once", reason: "file_edit_operator_approved" });
    expect(classify).not.toHaveBeenCalled();
    expect(fileEditApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "edit-tool-1",
        toolName: "write_file",
        title: "Approve edit: README.md",
        summary: "Approve edit: README.md",
        workspacePath: "/workspace/symphony",
        affectedPaths: ["README.md"],
        diffs: [
          expect.objectContaining({
            path: "README.md",
            oldText: "old README",
            newText: "updated README",
          }),
        ],
        rawInput: expect.objectContaining({ tool: "write_file" }),
      }),
      input,
    );
    expect(resolveHermesAcpPermissionDecision(input.request, decision)).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
      outcome: "selected",
      selectedOptionId: "allow_once",
      reason: "file_edit_operator_approved",
    });
  });

  it("validates and approves multi-file ACP file-edit permission requests", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const fileEditApproval = vi.fn(() => ({ outcome: "approve" as const }));
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      fileEditApproval,
      environment: { GITHUB_TOKEN: "secret-token", PATH: "/usr/bin" },
    });
    const input = resolverInput(
      editPermissionRequest({
        snakeCase: true,
        rawInputPath: null,
        content: [
          { path: "README.md", old_text: "old README", new_text: "updated README" },
          { path: "src/index.ts", old_text: "export {};", new_text: "export const ok = true;" },
        ],
      }),
    );

    const decision = await resolver(input);

    expect(decision).toEqual({ optionId: "allow_once", reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON });
    expect(classify).not.toHaveBeenCalled();
    expect(fileEditApproval).toHaveBeenCalledTimes(1);
    expect(fileEditApproval).toHaveBeenCalledWith(
      expect.objectContaining({ affectedPaths: ["README.md", "src/index.ts"] }),
      input,
    );
    expect(resolveHermesAcpPermissionDecision(input.request, decision)).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
      outcome: "selected",
      selectedOptionId: "allow_once",
      reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON,
    });
  });

  it("fails closed for valid ACP file-edit permission requests when no file-edit approval hook is configured", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      environment: { PATH: "/usr/bin" },
    });
    const input = resolverInput(editPermissionRequest({ snakeCase: true }));

    const decision = await resolver(input);

    expect(decision).toEqual({
      optionId: "deny",
      reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_APPROVAL_BRIDGE_MISSING_REASON,
    });
    expect(classify).not.toHaveBeenCalled();
    expect(resolveHermesAcpPermissionDecision(input.request, decision)).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "deny" } },
      outcome: "selected",
      selectedOptionId: "deny",
      reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_APPROVAL_BRIDGE_MISSING_REASON,
    });
  });

  it("fails closed when the file-edit approval hook fails", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      fileEditApproval: () => {
        throw new Error("approval unavailable");
      },
      environment: { PATH: "/usr/bin" },
    });
    const input = resolverInput(editPermissionRequest({ snakeCase: true }));

    const decision = await resolver(input);

    expect(decision).toEqual({ optionId: "deny", reason: "file_edit_approval_error" });
    expect(classify).not.toHaveBeenCalled();
    expect(resolveHermesAcpPermissionDecision(input.request, decision)).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "deny" } },
      outcome: "selected",
      selectedOptionId: "deny",
      reason: "file_edit_approval_error",
    });
  });

  it("selects the ACP deny option when file-edit approval rejects the request", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      fileEditApproval: () => ({ outcome: "reject", reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_DENY_REASON }),
      environment: { PATH: "/usr/bin" },
    });
    const input = resolverInput(editPermissionRequest({ snakeCase: true }));

    const decision = await resolver(input);

    expect(decision).toEqual({ optionId: "deny", reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_DENY_REASON });
    expect(classify).not.toHaveBeenCalled();
    expect(resolveHermesAcpPermissionDecision(input.request, decision)).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "deny" } },
      outcome: "selected",
      selectedOptionId: "deny",
      reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_DENY_REASON,
    });
  });

  it.each([
    {
      name: "missing diff",
      params: () => {
        const params = editPermissionRequest({ snakeCase: true });
        delete (params.tool_call as Record<string, unknown>).content;
        return params;
      },
      reason: "missing_file_edit_diff",
    },
    {
      name: "malformed diff",
      params: () => editPermissionRequest({ snakeCase: true, content: [{ path: "README.md", old_text: "old README" }] }),
      reason: "malformed_file_edit_diff",
    },
    {
      name: "too-large diff",
      params: () => editPermissionRequest({ snakeCase: true }),
      reason: "file_edit_diff_too_large",
      maxFileEditDiffBytes: 8,
    },
    {
      name: "outside-workspace path",
      params: () =>
        editPermissionRequest({
          snakeCase: true,
          path: "../outside.txt",
          rawInputPath: "../outside.txt",
          content: [{ path: "../outside.txt", old_text: "old", new_text: "new" }],
        }),
      reason: "file_edit_path_outside_workspace",
    },
    {
      name: "raw input target differs from displayed diff path inside workspace",
      params: () =>
        editPermissionRequest({
          snakeCase: true,
          path: "README.md",
          rawInputPath: "src/index.ts",
          content: [{ path: "README.md", old_text: "old README", new_text: "updated README" }],
        }),
      reason: "file_edit_target_path_mismatch",
    },
    {
      name: "raw input target outside workspace while displayed diff path is inside",
      params: () =>
        editPermissionRequest({
          snakeCase: true,
          path: "README.md",
          rawInputPath: "../outside.txt",
          content: [{ path: "README.md", old_text: "old README", new_text: "updated README" }],
        }),
      reason: "file_edit_path_outside_workspace",
    },
  ])("fails closed for $name ACP file-edit permission requests", async ({ params, reason, maxFileEditDiffBytes }) => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const fileEditApproval = vi.fn(() => ({ outcome: "approve" as const }));
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      fileEditApproval,
      maxFileEditDiffBytes,
      environment: { PATH: "/usr/bin" },
    });
    const input = resolverInput(params());

    const decision = await resolver(input);

    expect(decision).toEqual({ optionId: "deny", reason });
    expect(classify).not.toHaveBeenCalled();
    expect(fileEditApproval).not.toHaveBeenCalled();
    expect(resolveHermesAcpPermissionDecision(input.request, decision)).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "deny" } },
      outcome: "selected",
      selectedOptionId: "deny",
      reason,
    });
  });

  it("fails closed for unsupported ACP permission kinds without command classification", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      allowPolicyDecision({ reasonKind: "local_only_inspection", commandClass: "local_git_inspection" }),
    );
    const resolver = createAgentCommandPolicyAcpResolver({ classify, environment: { PATH: "/usr/bin" } });
    const baseInput = resolverInput(terminalPermissionRequest("git status --short"));

    await expect(
      resolver({
        ...baseInput,
        request: { ...baseInput.request, requestKind: "unknown" },
      }),
    ).resolves.toEqual({ optionId: null, reason: "unsupported_agent_command_policy_permission_kind" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("fails closed when ACP terminal permission command sources conflict", async () => {
    const params = terminalPermissionRequest("git status --short", {
      displayCommand: "git push origin HEAD",
      realAcpDisplayContent: true,
    });
    const input = resolverInput(params);
    const resolver = createAgentCommandPolicyAcpResolver({ environment: { PATH: "/usr/bin" } });

    expect(buildAgentCommandPolicyInputForAcpPermission(input, { environment: { PATH: "/usr/bin" } })).toEqual({
      status: "ok",
      input: expect.objectContaining({
        rawInput: { command: "git status --short", cmd: "git push origin HEAD" },
      }),
    });
    await expect(resolver(input)).resolves.toEqual({ optionId: null, reason: "ambiguous_command" });
  });

  it("returns cancelled policy decisions for denied upstream terminal commands", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      environment: { GITHUB_TOKEN: "secret-token", PATH: "/usr/bin" },
    });

    const decision = await resolver(resolverInput(terminalPermissionRequest("git push origin HEAD")));

    expect(decision).toEqual({ optionId: null, reason: "upstream_github" });
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "terminal_execute",
        rawInput: expect.objectContaining({ command: "git push origin HEAD" }),
        environment: { keysOnly: ["GITHUB_TOKEN", "PATH"] },
      }),
    );
  });

  it("preserves policy reasons in ACP permission resolution outcomes", () => {
    const request = parseHermesAcpPermissionRequest(terminalPermissionRequest("git status --short"));

    expect(resolveHermesAcpPermissionDecision(request, { optionId: null, reason: "upstream_github" })).toMatchObject({
      response: { outcome: { outcome: "cancelled" } },
      outcome: "cancelled",
      selectedOptionId: null,
      reason: "upstream_github",
    });
    expect(resolveHermesAcpPermissionDecision(request, { optionId: "allow_once", reason: "local_only_inspection" })).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
      outcome: "selected",
      selectedOptionId: "allow_once",
      reason: "local_only_inspection",
    });
  });

  it.each([
    {
      name: "malformed option payload",
      params: () => ({
        ...terminalPermissionRequest("git status --short"),
        options: [...terminalPermissionOptions(), { kind: "allow_once", name: "Missing option id" }],
      }),
      reason: "malformed_permission_options",
      requestedOptionIds: ["allow_once", "allow_session", "allow_always", "deny", "deny_always"],
    },
    {
      name: "duplicate option id",
      params: () => ({
        ...terminalPermissionRequest("git status --short"),
        options: [...terminalPermissionOptions(), { optionId: "allow_once", kind: "allow_once", name: "Duplicate allow once" }],
      }),
      reason: "duplicate_permission_options",
      requestedOptionIds: ["allow_once", "allow_session", "allow_always", "deny", "deny_always", "allow_once"],
    },
  ])("fails closed for $name permission requests", ({ params, reason, requestedOptionIds }) => {
    const request = parseHermesAcpPermissionRequest(params());

    expect(request.malformedReason).toBe(reason);
    expect(request.options.map((option) => option.optionId)).toEqual(requestedOptionIds);
    expect(resolveHermesAcpPermissionDecision(request, { optionId: "allow_once" })).toMatchObject({
      response: { outcome: { outcome: "cancelled" } },
      outcome: "cancelled",
      selectedOptionId: null,
      reason,
    });
  });

  it("fails closed before resolver approval for unsupported ACP file-edit options", () => {
    const request = parseHermesAcpPermissionRequest({
      ...editPermissionRequest({ snakeCase: true }),
      permission_options: [
        ...editPermissionOptions(true),
        { option_id: "allow_session", kind: "allow_always", name: "Allow for session" },
      ],
    });

    expect(request.requestKind).toBe("file_edit");
    expect(request.malformedReason).toBe("unsupported_permission_options");
    expect(request.options.map((option) => option.optionId)).toEqual(["allow_once", "deny", "allow_session"]);
    expect(resolveHermesAcpPermissionDecision(request, { optionId: "allow_once" })).toMatchObject({
      response: { outcome: { outcome: "cancelled" } },
      outcome: "cancelled",
      selectedOptionId: null,
      reason: "unsupported_permission_options",
    });
  });

  it("maps command-policy outcomes to ACP permission decisions", () => {
    const allowDecision = allowPolicyDecision({ reasonKind: "local_only_inspection", commandClass: "local_git_inspection" });
    const denyDecision = denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" });

    expect(mapAgentCommandPolicyDecisionToAcpPermissionDecision(allowDecision)).toEqual({
      optionId: DEFAULT_AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_ID,
      reason: "local_only_inspection",
    });
    expect(mapAgentCommandPolicyOutcomeToAcpPermissionDecision(allowDecision, { allowOptionId: "allow_session" })).toEqual({
      optionId: "allow_session",
      reason: "local_only_inspection",
    });
    expect(mapAgentCommandPolicyDecisionToAcpPermissionDecision(denyDecision, { allowOptionId: "allow_session" })).toEqual({
      optionId: null,
      reason: "upstream_github",
    });
    expect(mapAgentCommandPolicyDecisionToAcpPermissionDecision(allowDecision, { allowOptionId: "deny" as never })).toEqual({
      optionId: null,
      reason: "unsupported_agent_command_policy_acp_allow_option",
    });
    expect(mapAgentCommandPolicyDecisionToAcpPermissionDecision(allowDecision, { allowOptionId: "allow_always" as never })).toEqual({
      optionId: null,
      reason: "unsupported_agent_command_policy_acp_allow_option",
    });

    expect(isAgentCommandPolicyAcpAllowOptionId("allow_session")).toBe(true);
    expect(isAgentCommandPolicyAcpAllowOptionId("allow_always")).toBe(false);
    expect(isAgentCommandPolicyAcpAllowOptionId("deny")).toBe(false);
  });

  it.each(["allow_once", "allow_session"] as const)(
    "selects configured ACP allow option %s for allowed local terminal inspection",
    async (allowOptionId) => {
      const classify = vi.fn((_input: AgentCommandPolicyInput) =>
        allowPolicyDecision({ reasonKind: "local_only_inspection", commandClass: "local_git_inspection" }),
      );
      const resolver = createAgentCommandPolicyAcpResolver({
        classify,
        allowOptionId,
        environment: { PATH: "/usr/bin" },
      });

      await expect(resolver(resolverInput(terminalPermissionRequest("git status --short")))).resolves.toEqual({
        optionId: allowOptionId,
        reason: "local_only_inspection",
      });
    },
  );

  it("selects only allow_once for allowed local terminal inspection by default", async () => {
    const resolver = createAgentCommandPolicyAcpResolver({ environment: { HOME: "/tmp/home", PATH: "/usr/bin" } });

    await expect(resolver(resolverInput(terminalPermissionRequest("git status --short")))).resolves.toEqual({
      optionId: "allow_once",
      reason: "local_only_inspection",
    });
  });

  it("fails closed when ACP policy context or classification is unavailable", async () => {
    const { runPhase, ...ctxWithoutPhase } = agentRunContext();
    expect(runPhase).toBe("implementation");
    const missingPhaseInput = resolverInput(terminalPermissionRequest("git status --short"), {
      ctx: ctxWithoutPhase,
    });
    const throwingResolver = createAgentCommandPolicyAcpResolver({
      classify: () => {
        throw new Error("classifier unavailable");
      },
    });

    await expect(createAgentCommandPolicyAcpResolver()(missingPhaseInput)).resolves.toEqual({
      optionId: null,
      reason: "missing_agent_command_policy_context",
    });
    await expect(throwingResolver(resolverInput(terminalPermissionRequest("git status --short")))).resolves.toEqual({
      optionId: null,
      reason: "classifier_error",
    });
  });
});

function resolverInput(
  params: Record<string, unknown>,
  overrides: Partial<HermesAcpPermissionResolverInput> = {},
): HermesAcpPermissionResolverInput {
  const request = parseHermesAcpPermissionRequest(params);
  expect(request.malformedReason).toBeNull();
  return {
    ctx: agentRunContext(),
    runId: "run-acp-policy-1",
    request,
    jsonRpcRequest: { jsonrpc: "2.0", id: 1, method: "session/request_permission", params } satisfies HostHermesAcpJsonRpcRequest,
    acpSessionId: "acp-session-1",
    symphonySessionId: "symphony-session-1",
    ...overrides,
  };
}

function terminalPermissionRequest(
  command: string,
  options: {
    field?: "command" | "cmd" | "script";
    displayCommand?: string;
    realAcpDisplayContent?: boolean;
    snakeCase?: boolean;
  } = {},
): Record<string, unknown> {
  const field = options.field ?? "command";
  const toolCall = {
    toolCallId: "perm-tool-1",
    kind: "execute",
    title: "terminal command",
    [options.snakeCase ? "raw_input" : "rawInput"]: {
      [field]: command,
      ...(options.realAcpDisplayContent ? { description: "terminal command" } : {}),
    },
    ...(options.realAcpDisplayContent
      ? {
          content: [
            {
              type: "text",
              text: `terminal command\n$ ${options.displayCommand ?? command}`,
            },
          ],
        }
      : {}),
  };
  return {
    [options.snakeCase ? "session_id" : "sessionId"]: "acp-session-1",
    [options.snakeCase ? "tool_call" : "toolCall"]: toolCall,
    [options.snakeCase ? "permission_options" : "options"]: terminalPermissionOptions(options.snakeCase),
  };
}

function terminalPermissionOptions(snakeCase = false): Array<Record<string, unknown>> {
  const optionIdKey = snakeCase ? "option_id" : "optionId";
  return [
    { [optionIdKey]: "allow_once", kind: "allow_once", name: "Allow once" },
    { [optionIdKey]: "allow_session", kind: "allow_always", name: "Allow for session" },
    { [optionIdKey]: "allow_always", kind: "allow_always", name: "Allow always" },
    { [optionIdKey]: "deny", kind: "reject_once", name: "Deny" },
    { [optionIdKey]: "deny_always", kind: "reject_always", name: "Deny always" },
  ];
}

function editPermissionRequest(
  options: { snakeCase?: boolean; path?: string; rawInputPath?: string | null; content?: unknown } = {},
): Record<string, unknown> {
  const diffPath = options.path ?? "README.md";
  const rawInputPath = Object.prototype.hasOwnProperty.call(options, "rawInputPath") ? options.rawInputPath : diffPath;
  const rawInputArguments: Record<string, unknown> = { content: "updated README" };
  if (rawInputPath !== null && rawInputPath !== undefined) rawInputArguments.path = rawInputPath;
  const content = Object.prototype.hasOwnProperty.call(options, "content")
    ? options.content
    : [{ path: diffPath, old_text: "old README", new_text: "updated README" }];
  const toolCall: Record<string, unknown> = {
    [options.snakeCase ? "tool_call_id" : "toolCallId"]: "edit-tool-1",
    kind: "edit",
    title: `Approve edit: ${diffPath}`,
    [options.snakeCase ? "raw_input" : "rawInput"]: {
      tool: "write_file",
      arguments: rawInputArguments,
    },
    content,
  };
  return {
    [options.snakeCase ? "session_id" : "sessionId"]: "acp-session-1",
    [options.snakeCase ? "tool_call" : "toolCall"]: toolCall,
    [options.snakeCase ? "permission_options" : "options"]: editPermissionOptions(options.snakeCase),
  };
}

function editPermissionOptions(snakeCase = false): Array<Record<string, unknown>> {
  const optionIdKey = snakeCase ? "option_id" : "optionId";
  return [
    { [optionIdKey]: "allow_once", kind: "allow_once", name: "Allow edit" },
    { [optionIdKey]: "deny", kind: "reject_once", name: "Deny" },
  ];
}

function agentRunContext(): AgentRunContext {
  return {
    issue: issue(),
    role: "worker",
    runPhase: "implementation",
    attempt: 1,
    workspace: {
      path: "/workspace/symphony",
      workspaceKey: "ENG-263",
      createdNow: false,
      issueId: "issue-acp-policy-1",
      issueIdentifier: "ENG-263",
      sourceKind: "git_worktree",
      gitBranchName: "sinfonista/eng-263-eng-24307-hermes-acp-permission-resolver-enforcement",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    },
    config: {} as AgentRunContext["config"],
    turnNumber: 1,
    abortSignal: new AbortController().signal,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function issue(): Issue {
  return {
    id: "issue-acp-policy-1",
    identifier: "ENG-263",
    title: "Hermes ACP permission resolver enforcement",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: "sinfonista/eng-263-eng-24307-hermes-acp-permission-resolver-enforcement",
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: ["dogfood-ready"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}
