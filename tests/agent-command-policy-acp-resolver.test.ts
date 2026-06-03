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

  it("selects allow_once for ACP file-edit permission requests without command classification", async () => {
    const classify = vi.fn((_input: AgentCommandPolicyInput) =>
      denyPolicyDecision({ reasonKind: "upstream_github", commandClass: "git_push" }),
    );
    const resolver = createAgentCommandPolicyAcpResolver({
      classify,
      environment: { GITHUB_TOKEN: "secret-token", PATH: "/usr/bin" },
    });
    const input = resolverInput(editPermissionRequest({ snakeCase: true }));

    const decision = await resolver(input);

    expect(decision).toEqual({ optionId: "allow_once", reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON });
    expect(classify).not.toHaveBeenCalled();
    expect(resolveHermesAcpPermissionDecision(input.request, decision)).toMatchObject({
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
      outcome: "selected",
      selectedOptionId: "allow_once",
      reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON,
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

function editPermissionRequest(options: { snakeCase?: boolean } = {}): Record<string, unknown> {
  const toolCall = {
    [options.snakeCase ? "tool_call_id" : "toolCallId"]: "edit-tool-1",
    kind: "edit",
    title: "Approve edit: README.md",
    [options.snakeCase ? "raw_input" : "rawInput"]: {
      tool: "write_file",
      arguments: { path: "README.md", content: "updated README" },
    },
    content: [{ path: "README.md", old_text: "old README", new_text: "updated README" }],
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
