import { describe, expect, it } from "vitest";
import type { HostHermesAcpJsonRpcRequest } from "../hermes/src/HostHermesAcpFacade.js";
import { CursorHarness } from "../cursor/src/CursorHarness.js";
import { HermesAcpHarness } from "../hermes/src/HermesAcpHarness.js";
import type { HermesAcpPermissionResolver, HermesAcpPermissionResolverInput } from "../hermes/src/HermesAcpHarness.js";
import { parseHermesAcpPermissionRequest } from "../hermes/src/HermesAcpPermissions.js";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_APPROVAL_BRIDGE_MISSING_REASON } from "../src/core/harness/AgentCommandPolicyAcpResolver.js";
import { createAgentHarness } from "../src/core/harness/HarnessFactory.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";

describe("createAgentHarness", () => {
  it("creates the Cursor harness from config", () => {
    expect(createAgentHarness(config())).toBeInstanceOf(CursorHarness);
  });

  it("creates the Hermes harness from the built-in registry", () => {
    expect(createAgentHarness(config("hermes"))).toBeInstanceOf(HermesHarness);
  });

  it("creates the Hermes ACP harness from the built-in registry with a default permission resolver without changing Hermes TUI registration", () => {
    const harness = createAgentHarness(config("hermes_acp"));

    expect(harness).toBeInstanceOf(HermesAcpHarness);
    expect(harness.id).toBe("hermes_acp");
    expect(harness.capabilities).toMatchObject({
      continuation: true,
      mcpHandoff: true,
      runStatus: false,
      liveDiagnostics: true,
    });
    expect((harness as unknown as { options: { permissionResolver?: unknown } }).options.permissionResolver).toEqual(expect.any(Function));
    expect(createAgentHarness(config("hermes"))).toBeInstanceOf(HermesHarness);
  });

  it("keeps the Hermes TUI harness registered when Hermes ACP config coexists in the same workflow", () => {
    const hermesHarness = createAgentHarness(configWithHermesAndAcp("hermes"));
    const acpHarness = createAgentHarness(configWithHermesAndAcp("hermes_acp"));

    expect(hermesHarness).toBeInstanceOf(HermesHarness);
    expect(hermesHarness.id).toBe("hermes");
    expect(acpHarness).toBeInstanceOf(HermesAcpHarness);
    expect(acpHarness.id).toBe("hermes_acp");
  });

  it("wires the Hermes ACP default permission resolver to fail closed for valid file-edit requests", async () => {
    const harness = createAgentHarness(config("hermes_acp"));
    const permissionResolver = (harness as unknown as { options: { permissionResolver?: HermesAcpPermissionResolver } }).options
      .permissionResolver;

    expect(permissionResolver).toEqual(expect.any(Function));
    if (!permissionResolver) throw new Error("missing Hermes ACP permission resolver");

    const input = permissionResolverInput(editPermissionRequest());

    await expect(permissionResolver(input)).resolves.toEqual({
      optionId: "deny",
      reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_APPROVAL_BRIDGE_MISSING_REASON,
    });
  });

  it("parses unknown harness ids but fails clearly when no provider is registered", () => {
    const openclaw = config("openclaw");

    expect(openclaw.agent.harness).toBe("openclaw");
    expect(() => createAgentHarness(openclaw)).toThrow(/No runtime harness registered for openclaw/);
  });

  it("creates a non-Cursor harness from an injected registry", () => {
    const harness = createAgentHarness(config("hermes"), {
      registry: {
        hermes: () => new RegistryHarness(),
      },
    });

    expect(harness).toBeInstanceOf(RegistryHarness);
    expect(harness.id).toBe("hermes");
  });
});

class RegistryHarness implements AgentHarness {
  readonly id = "hermes";
  readonly capabilities = { continuation: true, mcpHandoff: true };

  async *run(_ctx: AgentRunContext, _prompt: string): AsyncIterable<AgentEvent> {
    yield { type: "completed" };
  }
}

function config(harness = "cursor") {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      agent: { harness, max_turns: 2 },
    },
    "/repo/WORKFLOW.md",
    { LINEAR_API_KEY: "secret" },
  );
}

function configWithHermesAndAcp(harness: "hermes" | "hermes_acp") {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      agent: { harness, max_turns: 2 },
      hermes: {
        state_dir: "/runtime/tui-hermes-home",
        provider: "openai-codex",
        model: "gpt-5.5-tui",
      },
      hermes_acp: {
        binary_path: "/host/bin/hermes",
        source_profile: "dogfood-host",
        profile_prefix: "symphony-host",
        worker_session_lifecycle: "fresh_per_run",
      },
    },
    "/repo/WORKFLOW.md",
    { LINEAR_API_KEY: "secret" },
  );
}

function permissionResolverInput(params: Record<string, unknown>): HermesAcpPermissionResolverInput {
  const request = parseHermesAcpPermissionRequest(params);
  expect(request.malformedReason).toBeNull();
  return {
    ctx: agentRunContext(),
    runId: "run-harness-factory-acp-1",
    request,
    jsonRpcRequest: { jsonrpc: "2.0", id: 1, method: "session/request_permission", params } satisfies HostHermesAcpJsonRpcRequest,
    acpSessionId: "acp-session-factory-1",
    symphonySessionId: "symphony-session-factory-1",
  };
}

function editPermissionRequest(): Record<string, unknown> {
  return {
    session_id: "acp-session-factory-1",
    tool_call: {
      tool_call_id: "edit-tool-factory-1",
      kind: "edit",
      title: "Approve edit: README.md",
      raw_input: {
        tool: "write_file",
        arguments: { path: "README.md", content: "updated README" },
      },
      content: [{ path: "README.md", old_text: "old README", new_text: "updated README" }],
    },
    permission_options: [
      { option_id: "allow_once", kind: "allow_once", name: "Allow edit" },
      { option_id: "deny", kind: "reject_once", name: "Deny" },
    ],
  };
}

function agentRunContext(): AgentRunContext {
  return {
    issue: {
      id: "issue-harness-factory-acp-1",
      identifier: "ENG-163",
      title: "Implement file edit permission handler",
      description: null,
      priority: null,
      state: "In Progress",
      branchName: "sinfonista/eng-163-eng-141c-implement-file-edit-permission-handler",
      url: null,
      assigneeId: null,
      delegateId: null,
      assignedToWorker: true,
      labels: ["dogfood-ready"],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    role: "worker",
    runPhase: "implementation",
    attempt: 1,
    workspace: {
      path: "/workspace/symphony",
      workspaceKey: "ENG-163",
      createdNow: false,
      issueId: "issue-harness-factory-acp-1",
      issueIdentifier: "ENG-163",
      sourceKind: "git_worktree",
      gitBranchName: "sinfonista/eng-163-eng-141c-implement-file-edit-permission-handler",
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
