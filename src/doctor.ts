import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LinearWorkflowTeamStates } from "./integrations/linear/LinearTrackerClient.js";
import { createLinearTrackerClientForCapability } from "./integrations/linear/LinearCredentialResolver.js";
import {
  createGitHubPullRequestClientForCapability,
  resolveGitHubClientConfig,
  type GitHubCredentialCapability,
} from "./integrations/github/GitHubCredentialResolver.js";
import { WorkflowLoader } from "./core/workflow/WorkflowLoader.js";
import { errorMessage } from "./core/errors.js";
import type { ServiceConfig } from "./core/config/Config.js";
import type { Issue } from "./core/types.js";
import {
  AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS,
  lintAgentEligibleIssueContracts,
} from "./core/IssueContractLint.js";
import { resolveCursorRuntimeApiKey, resolveRuntimeApiKey } from "./app/RuntimeDependencies.js";
import { COMPLETION_REPORT_TOOL_NAME } from "./core/harness/CompletionReportMcpServer.js";
import {
  runHermesGatewayMcpToolExposureProbe,
  runSubprocessMcpToolExposureProbe,
} from "./core/harness/McpToolExposureProbe.js";
import { REVIEW_FEEDBACK_TOOL_NAME } from "./core/harness/ReviewFeedbackMcpServer.js";
import { REVIEW_VERDICT_TOOL_NAME } from "./core/harness/ReviewVerdictMcpServer.js";
import { CONTINUATION_CONTEXT_ROADMAP } from "./core/summarization/ContinuationContextRoadmap.js";
import type { HermesGatewayClient, HermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";
import {
  HermesAuthManager,
  type HermesAuthManagerOptions,
  hermesManagedAuthMissingMessage,
  hermesOwnedAuthProvidersForRuntime,
  isHermesOwnedAuthProvider,
  normalizeHermesAuthProvider,
  redactHermesAuthMessage,
} from "../hermes/src/HermesAuthManager.js";
import type { HermesAgentCommandPolicyHookVerifier } from "../hermes/src/HermesMcpConfig.js";
import {
  discoverHostHermes,
  hostHermesCommandEnvironment,
  type HostHermesCommandRunner,
  type HostHermesDiagnostic,
} from "../hermes/src/HostHermesDiscovery.js";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  workflowPath: string;
  strict?: boolean | undefined;
  liveRuntime?: boolean | undefined;
  cliPath?: string | undefined;
}

export interface ReviewLoopDoctorCheckOptions {
  workflowPath: string;
  cliPath?: string | undefined;
  mcpToolLister?: McpToolLister;
  linearStateLister?: LinearStateLister;
}

export interface RuntimeHarnessDependencyDoctorCheckOptions {
  strict?: boolean | undefined;
  liveRuntime?: boolean | undefined;
  cliPath?: string | undefined;
  hermesGatewayFactory?: ((env: HermesGatewayEnvironment) => HermesGatewayClient) | undefined;
  commandPolicyHookVerifier?: HermesAgentCommandPolicyHookVerifier | undefined;
  hermesAuthManagerFactory?: ((options: HermesAuthManagerOptions) => Pick<HermesAuthManager, "prepare" | "validateOpenAiCodex">) | undefined;
  hostHermesCommandRunner?: HostHermesCommandRunner | undefined;
}

export type McpToolServerCommand = "completion-report-mcp" | "review-verdict-mcp" | "review-feedback-mcp";

export type McpToolLister = (input: {
  command: McpToolServerCommand;
  config: ServiceConfig;
  workflowPath: string;
  cliPath: string;
}) => Promise<string[]>;

export type LinearStateLister = (input: { config: ServiceConfig }) => Promise<LinearWorkflowTeamStates[]>;

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const workflowPath = path.resolve(options.workflowPath);
  const loader = new WorkflowLoader(workflowPath);

  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    checks.push({ id: "workflow.parse", status: "ok", message: `Loaded ${workflowPath}` });
    checks.push(...runtimeHarnessDoctorChecks(config));
    checks.push(
      ...(await runtimeHarnessDependencyDoctorChecks(config, {
        strict: options.strict ?? false,
        liveRuntime: options.liveRuntime ?? false,
        cliPath: options.cliPath,
      })),
    );
    checks.push({
      id: "agent.concurrency",
      status: config.agent.maxConcurrentAgents === 1 ? "ok" : "warn",
      message: `max_concurrent_agents is ${config.agent.maxConcurrentAgents}`,
    });
    checks.push(trackerHandoffDoctorCheck(config));
    checks.push(...(await reviewLoopDoctorChecks(config, { workflowPath, cliPath: options.cliPath })));
    checks.push(...continuationContextDoctorChecks(config));

    await checkWritable(checks, "workspace.root", config.workspace.root);
    await checkWritable(checks, "workspace.state_dir", config.workspace.stateDir);
    await checkGit(checks);
    checks.push(await githubPublicationDoctorCheck(config));
    checks.push(await githubReviewFeedbackDoctorCheck(config));

    checks.push(runtimeCredentialDoctorCheck(config));

    const tracker = createLinearTrackerClientForCapability(config, "linear.tracker");
    try {
      const candidates = await tracker.fetchCandidateIssues();
      checks.push({
        id: "linear.candidates",
        status: candidates.length === 0 ? "ok" : "warn",
        message: `${candidates.length} candidate issue(s) currently match active states and assignee routing`,
      });
      checks.push(issueContractDoctorCheck(config, candidates));
    } catch (error) {
      checks.push({ id: "linear.candidates", status: "error", message: errorMessage(error) });
    }
  } catch (error) {
    checks.push({ id: "workflow.parse", status: "error", message: errorMessage(error) });
  } finally {
    await loader.close();
  }

  const hasError = checks.some((check) => check.status === "error");
  const hasWarning = checks.some((check) => check.status === "warn");
  return { ok: !hasError && !(options.strict && hasWarning), checks };
}

export function formatDoctorResult(result: DoctorResult): string {
  return result.checks
    .map((check) => `[${check.status.toUpperCase()}] ${check.id}: ${check.message}`)
    .join("\n");
}

export function issueContractDoctorCheck(config: ServiceConfig, issues: readonly Issue[]): DoctorCheck {
  const results = lintAgentEligibleIssueContracts(issues, config);
  const failures = results.filter((result) => result.missingSections.length > 0);
  if (failures.length === 0) {
    return {
      id: "linear.issue_contract",
      status: "ok",
      message:
        results.length === 0
          ? "No agent-eligible candidate issues require the authoring contract check"
          : `${results.length} agent-eligible candidate issue(s) include required authoring sections: ${AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS.join(", ")}`,
    };
  }

  return {
    id: "linear.issue_contract",
    status: "warn",
    message: `Agent-eligible issue(s) are missing required authoring sections: ${failures
      .map((failure) => `${failure.issue.identifier} missing ${failure.missingSections.join(", ")}`)
      .join("; ")}`,
  };
}

export function trackerHandoffDoctorCheck(config: ServiceConfig): DoctorCheck {
  if (config.tracker.handoffStates.length > 0) {
    return {
      id: "tracker.handoff",
      status: "ok",
      message: `handoff_states: ${config.tracker.handoffStates.join(", ")}`,
    };
  }

  if (!config.github.prHandoff.enabled && config.reviewLoop.reviewStates.length > 0) {
    return {
      id: "tracker.handoff",
      status: "ok",
      message: `No handoff_states configured; PR handoff is disabled and review_states route directly to ${config.reviewLoop.reviewStates.join(", ")}`,
    };
  }

  return {
    id: "tracker.handoff",
    status: "warn",
    message: config.github.prHandoff.enabled
      ? "No handoff_states configured; PR handoff requires github.pr_handoff.target_state to resolve to tracker.handoff_states"
      : "No handoff_states configured",
  };
}

export function continuationContextDoctorChecks(config: ServiceConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const enabled = [
    { configKey: "searchEnabled" as const, roadmap: CONTINUATION_CONTEXT_ROADMAP.search },
    { configKey: "summarizationEnabled" as const, roadmap: CONTINUATION_CONTEXT_ROADMAP.summarization },
  ];

  for (const item of enabled) {
    if (!config.continuationContext[item.configKey]) continue;
    if (item.roadmap.implementationStatus === "implemented") {
      checks.push({
        id: `continuation_context.${item.roadmap.capability}`,
        status: "ok",
        message: `${item.roadmap.flag} is enabled and ${item.roadmap.capability} is implemented`,
      });
      continue;
    }
    checks.push({
      id: `continuation_context.${item.roadmap.capability}`,
      status: "warn",
      message:
        `${item.roadmap.flag} is enabled, but ${item.roadmap.capability} is ${item.roadmap.implementationStatus}; ` +
        "keep roadmap issues in Backlog with dogfood-blocked and without dogfood-ready until a concrete implementation lands",
    });
  }

  return checks;
}

export function cursorPolicyDoctorChecks(config: ServiceConfig): DoctorCheck[] {
  const context = config.cursor.modelParams.find((param) => param.id === "context")?.value ?? "none";
  return [
    {
      id: "cursor.model",
      status: hasBaselineCursorModel(config.cursor.model, config.cursor.modelParams, config.cursor.allowLargeContext) ? "ok" : "warn",
      message:
        `Cursor model is ${config.cursor.model} with params ${formatModelParams(config.cursor.modelParams)}; ` +
        `large context opt-in is ${config.cursor.allowLargeContext ? "enabled" : "disabled"}`,
    },
    {
      id: "cursor.context",
      status: config.cursor.model === "gpt-5.5" && context === "272k" && !config.cursor.allowLargeContext ? "ok" : "warn",
      message:
        config.cursor.model === "gpt-5.5" && context === "272k" && !config.cursor.allowLargeContext
          ? "Managed Cursor runs are bounded to context=272k"
          : `Managed Cursor context policy is non-default: context=${context}, allow_large_context=${config.cursor.allowLargeContext}`,
    },
    {
      id: "cursor.setting_sources",
      status: config.cursor.settingSources.length === 0 ? "ok" : "warn",
      message:
        config.cursor.settingSources.length === 0
          ? "Managed Cursor runs do not load project/user setting sources by default"
          : `Managed Cursor runs load setting sources: ${config.cursor.settingSources.join(", ")}`,
    },
    {
      id: "cursor.mode",
      status: config.cursor.mode === null || config.cursor.mode === "agent" ? "ok" : "warn",
      message:
        config.cursor.mode === null
          ? "Managed Cursor runs use the SDK default conversation mode"
          : `Managed Cursor runs request ${config.cursor.mode} conversation mode`,
    },
  ];
}

export function runtimeHarnessDoctorChecks(config: ServiceConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    {
      id: "runtime.harness",
      status: "ok",
      message: `Runtime harness is ${config.agent.harness}`,
    },
  ];
  if (config.agent.harness === "cursor") return [...checks, ...cursorPolicyDoctorChecks(config)];
  if (config.agent.harness === "hermes") return [...checks, ...hermesRuntimeDoctorChecks(config)];
  if (config.agent.harness === "hermes_acp") return [...checks, ...hermesAcpRuntimeDoctorChecks(config)];
  return [
    ...checks,
    {
      id: "runtime.provider_checks",
      status: "warn",
      message: `No provider-specific doctor checks are registered for runtime harness ${config.agent.harness}`,
    },
  ];
}

export function hermesRuntimeDoctorChecks(config: ServiceConfig): DoctorCheck[] {
  const provider = config.hermes.provider ?? "profile/default";
  const model = config.hermes.model ?? "";
  return [
    {
      id: "hermes.runtime",
      status: model.length > 0 ? "ok" : "error",
      message:
        model.length > 0
          ? `Hermes provider is ${provider}; model is ${model}`
          : "hermes.model is required when agent.harness is hermes so the upstream gateway cannot fall back to an unrelated default model",
    },
    {
      id: "hermes.profiles",
      status: "ok",
      message:
        `state_dir: ${config.hermes.stateDir}; templates: worker=${config.hermes.roleTemplates.worker}, ` +
        `reviewer=${config.hermes.roleTemplates.reviewer}, planner=${config.hermes.roleTemplates.planner}; ` +
        `worker lifecycle is ${config.hermes.workerSessionLifecycle}; profile retention is ${config.hermes.keepProfiles}`,
    },
  ];
}

export function hermesAcpRuntimeDoctorChecks(config: ServiceConfig): DoctorCheck[] {
  const binary = config.hermesAcp.binaryPath ?? "hermes (PATH)";
  const sourceProfile = config.hermesAcp.sourceProfile ?? "active host Hermes profile";
  const prefix = config.hermesAcp.profilePrefix;
  return [
    {
      id: "hermes_acp.runtime",
      status: "ok",
      message: `Hermes ACP uses host Hermes binary ${binary}; source profile is ${sourceProfile}; host installation/profile store are used without Symphony-managed HERMES_HOME or HERMES_AUTH_HOME overrides`,
    },
    {
      id: "hermes_acp.profiles",
      status: "ok",
      message:
        `ACP managed profile prefix is ${prefix}; worker lifecycle is ${config.hermesAcp.workerSessionLifecycle}; ` +
        `profile retention is ${config.hermesAcp.keepProfiles}`,
    },
  ];
}

export async function runtimeHarnessDependencyDoctorChecks(
  config: ServiceConfig,
  options: RuntimeHarnessDependencyDoctorCheckOptions = {},
): Promise<DoctorCheck[]> {
  if (config.agent.harness === "hermes_acp") return hostHermesAcpDoctorChecks(config, options);
  if (config.agent.harness !== "hermes") return [];
  const checks: DoctorCheck[] = [];
  checks.push(await hermesPathDoctorCheck("hermes.upstream_root", config.hermes.upstreamRoot, [
    path.join("tui_gateway", "entry.py"),
    path.join("ui-tui", "src", "gatewayClient.ts"),
  ]));
  checks.push(
    await hermesPathDoctorCheck("hermes.templates", config.hermes.templatesDir, [
      config.hermes.roleTemplates.worker,
      config.hermes.roleTemplates.reviewer,
      config.hermes.roleTemplates.planner,
    ]),
  );
  const pythonCheck = await hermesPythonImportDoctorCheck(config);
  checks.push(pythonCheck);
  checks.push(...(await hermesAuthDoctorChecks(config, options)));
  if (options.liveRuntime) {
    checks.push(
      pythonCheck.status === "error"
        ? {
            id: "hermes.live_runtime",
            status: "error",
            message: "Hermes live runtime check requires hermes.python to import the gateway and Python MCP SDK",
          }
        : await hermesLiveRuntimeDoctorCheck(config, options),
    );
  }
  return checks;
}

export async function hostHermesAcpDoctorChecks(
  config: ServiceConfig,
  options: Pick<RuntimeHarnessDependencyDoctorCheckOptions, "hostHermesCommandRunner"> = {},
): Promise<DoctorCheck[]> {
  const cwd = config.workspace.root;
  const timeoutMs = config.hermesAcp.startupTimeoutMs;
  const env = hostHermesCommandEnvironment(process.env);
  const discovery = await discoverHostHermes({
    binaryPath: config.hermesAcp.binaryPath,
    sourceProfile: config.hermesAcp.sourceProfile,
    cwd,
    env,
    timeoutMs,
    ...(options.hostHermesCommandRunner === undefined ? {} : { runner: options.hostHermesCommandRunner }),
  });

  const checks: DoctorCheck[] = [];
  if (discovery.binary) {
    checks.push({
      id: "hermes_acp.host_hermes",
      status: "ok",
      message:
        `Host Hermes binary resolved from ${discovery.binary.source} at ${discovery.binary.path}` +
        (discovery.binary.versionText ? `; ${discovery.binary.versionText}` : ""),
    });
  }
  checks.push(...discovery.diagnostics.map(hostHermesDiagnosticDoctorCheck));
  if (!discovery.binary) return checks;

  checks.push(
    await hostHermesAcpCommandDoctorCheck({
      id: "hermes_acp.acp_check",
      successMessage: "Host Hermes `hermes acp --check` completed successfully",
      file: discovery.binary.path,
      args: ["acp", "--check"],
      cwd,
      env,
      timeoutMs,
      runner: options.hostHermesCommandRunner,
    }),
  );

  if (!discovery.sourceProfile) {
    checks.push({
      id: "hermes_acp.source_profile",
      status: "error",
      message: "Host Hermes ACP source profile could not be resolved from config or the active host Hermes profile",
    });
    return checks;
  }

  checks.push({
    id: "hermes_acp.source_profile",
    status: "ok",
    message: `Hermes ACP source profile is ${discovery.sourceProfile.name} (${discovery.sourceProfile.source})`,
  });
  checks.push(
    await hostHermesAcpCommandDoctorCheck({
      id: "hermes_acp.source_profile_check",
      successMessage: `Host Hermes ACP source profile ${discovery.sourceProfile.name} passed \`hermes -p ${discovery.sourceProfile.name} acp --check\``,
      file: discovery.binary.path,
      args: ["-p", discovery.sourceProfile.name, "acp", "--check"],
      cwd,
      env,
      timeoutMs,
      runner: options.hostHermesCommandRunner,
    }),
  );
  return checks;
}

async function hostHermesAcpCommandDoctorCheck(input: {
  id: string;
  successMessage: string;
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  runner?: HostHermesCommandRunner | undefined;
}): Promise<DoctorCheck> {
  try {
    const result = input.runner
      ? await input.runner(input.file, input.args, { cwd: input.cwd, env: input.env, timeoutMs: input.timeoutMs })
      : await defaultHostHermesDoctorCommandRunner(input.file, input.args, {
          cwd: input.cwd,
          env: input.env,
          timeoutMs: input.timeoutMs,
        });
    const exitCode = result.exitCode ?? 0;
    if (exitCode === 0) return { id: input.id, status: "ok", message: input.successMessage };
    return {
      id: input.id,
      status: "error",
      message: redactDoctorDiagnosticMessage(
        `Host Hermes ACP command failed with exit code ${exitCode}: ${input.file} ${input.args.join(" ")}${hostHermesCommandOutputSummary(result.stdout, result.stderr)}`,
      ),
    };
  } catch (error) {
    return {
      id: input.id,
      status: "error",
      message: redactDoctorDiagnosticMessage(
        `Host Hermes ACP command failed: ${input.file} ${input.args.join(" ")}: ${errorMessage(error)}${hostHermesCommandOutputSummary(
          commandErrorOutput(error, "stdout"),
          commandErrorOutput(error, "stderr"),
        )}`,
      ),
    };
  }
}

async function defaultHostHermesDoctorCommandRunner(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode?: number | null }> {
  const result = await execFileAsync(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return { stdout: commandOutputToString(result.stdout), stderr: commandOutputToString(result.stderr), exitCode: 0 };
}

function hostHermesDiagnosticDoctorCheck(diagnostic: HostHermesDiagnostic): DoctorCheck {
  return {
    id: `hermes_acp.${diagnostic.code}`,
    status: hostHermesDiagnosticStatus(diagnostic),
    message: redactDoctorDiagnosticMessage(diagnostic.message),
  };
}

function hostHermesDiagnosticStatus(diagnostic: HostHermesDiagnostic): DoctorStatus {
  if (diagnostic.severity === "error") return "error";
  if (diagnostic.severity === "warning") return "warn";
  return "ok";
}

function hostHermesCommandOutputSummary(stdout: string, stderr: string): string {
  const output = [stdout, stderr]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  if (output.length === 0) return "";
  return `\n${output.slice(0, 800)}`;
}

function commandOutputToString(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function commandErrorOutput(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null) return "";
  const value = (error as Record<string, unknown>)[field];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function redactDoctorDiagnosticMessage(message: string): string {
  return redactHermesAuthMessage(message)
    .replace(/\[redacted\]/gi, "[REDACTED]")
    .replace(/("(?:api[_-]?key|token|authorization|password|secret)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[=:]\s*)[^\s,)]+/gi, "$1[REDACTED]");
}

export async function hermesLiveRuntimeDoctorCheck(
  config: ServiceConfig,
  options: Pick<RuntimeHarnessDependencyDoctorCheckOptions, "cliPath" | "hermesGatewayFactory" | "commandPolicyHookVerifier"> = {},
): Promise<DoctorCheck> {
  if (!config.hermes.model) {
    return {
      id: "hermes.live_runtime",
      status: "error",
      message: "Hermes live runtime check requires hermes.model before starting the gateway",
    };
  }
  if (!options.cliPath) {
    return {
      id: "hermes.live_runtime",
      status: "error",
      message: "Hermes live runtime check requires an explicit cliPath",
    };
  }
  try {
    const stage = await runHermesGatewayMcpToolExposureProbe(config, {
      cliPath: options.cliPath,
      roles: ["worker", "reviewer"],
      enabled: true,
      ...(options.hermesGatewayFactory === undefined ? {} : { gatewayFactory: options.hermesGatewayFactory }),
      ...(options.commandPolicyHookVerifier === undefined
        ? {}
        : { commandPolicyHookVerifier: options.commandPolicyHookVerifier }),
    });
    if (stage.status === "success") {
      return {
        id: "hermes.live_runtime",
        status: "ok",
        message: "Hermes gateway session exposes required Symphony MCP tools for worker and reviewer profiles",
      };
    }
    return {
      id: "hermes.live_runtime",
      status: "error",
      message: `Hermes gateway live runtime check failed (${stage.failureCode ?? stage.status}): ${redactHermesAuthMessage(stage.message)}`,
    };
  } catch (error) {
    return {
      id: "hermes.live_runtime",
      status: "error",
      message: `Hermes gateway live runtime check failed: ${redactHermesAuthMessage(errorMessage(error))}`,
    };
  }
}

async function hermesPathDoctorCheck(id: string, root: string, entries: string[]): Promise<DoctorCheck> {
  const missing: string[] = [];
  for (const entry of [...new Set(entries)]) {
    try {
      await fs.access(path.join(root, entry));
    } catch {
      missing.push(entry);
    }
  }
  if (missing.length === 0) return { id, status: "ok", message: `${root} contains ${entries.length} required path(s)` };
  return { id, status: "error", message: `${root} is missing required path(s): ${missing.join(", ")}` };
}

async function hermesPythonImportDoctorCheck(config: ServiceConfig): Promise<DoctorCheck> {
  const python = config.hermes.python ?? (process.platform === "win32" ? "python" : "python3");
  const script = [
    "import importlib",
    "import pathlib",
    "import sys",
    "root = pathlib.Path(sys.argv[1]).resolve()",
    "sys.path.insert(0, str(root))",
    "importlib.import_module('tui_gateway.entry')",
    "importlib.import_module('mcp')",
    "print('ok')",
  ].join("; ");
  try {
    await execFileAsync(python, ["-c", script, config.hermes.upstreamRoot], {
      cwd: config.hermes.upstreamRoot,
      env: {
        ...process.env,
        HERMES_HOME: config.hermes.stateDir,
        HERMES_PYTHON_SRC_ROOT: config.hermes.upstreamRoot,
      },
      timeout: config.hermes.startupTimeoutMs,
    });
    return { id: "hermes.python", status: "ok", message: `${python} can import tui_gateway.entry and mcp` };
  } catch (error) {
    return {
      id: "hermes.python",
      status: "error",
      message:
        `${python} could not import Hermes gateway dependencies (${hermesPythonDependencyError(error)}). ` +
        `Install them with python -m pip install -e "${config.hermes.upstreamRoot}[mcp]"`,
    };
  }
}

function hermesPythonDependencyError(error: unknown): string {
  const message = errorMessage(error);
  if (/No module named ['"]mcp['"]/.test(message)) return "Python package mcp is not installed";
  if (/No module named ['"]tui_gateway/.test(message)) return "tui_gateway.entry is not importable";
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 240) ?? "unknown import error";
}

export async function hermesAuthDoctorChecks(
  config: ServiceConfig,
  options: RuntimeHarnessDependencyDoctorCheckOptions = {},
): Promise<DoctorCheck[]> {
  if (!isHermesOwnedAuthProvider(config.hermes.provider)) return [];
  const provider = normalizeHermesAuthProvider(config.hermes.provider ?? "");
  const requiredProviders = hermesOwnedAuthProvidersForRuntime(config.hermes.provider, config.hermes.auth.providers);
  if (requiredProviders.length === 0) {
    return [
      {
        id: "hermes.auth",
        status: "error",
        message: `Hermes provider ${provider} requires hermes.auth.providers to include openai-codex`,
      },
    ];
  }

  const managerOptions: HermesAuthManagerOptions = {
    managedRoot: config.hermes.auth.managedRoot,
    bootstrapFrom: config.hermes.auth.bootstrapFrom,
    providers: config.hermes.auth.providers,
    upstreamRoot: config.hermes.upstreamRoot,
    python: config.hermes.python,
    timeoutMs: config.hermes.startupTimeoutMs,
  };
  const manager = options.hermesAuthManagerFactory?.(managerOptions) ?? new HermesAuthManager(managerOptions);

  try {
    const preparation = await manager.prepare(requiredProviders);
    const checks: DoctorCheck[] = [
      {
        id: "hermes.auth_root",
        status: "ok",
        message: `Hermes managed auth root is ready at ${preparation.managedRoot}; bootstrap source is ${preparation.bootstrapFrom}`,
      },
    ];

    if (preparation.missingProviders.length > 0) {
      return [
        ...checks,
        ...preparation.missingProviders.map((missingProvider) => ({
          id: `hermes.auth.${missingProvider}`,
          status: "error" as const,
          message: hermesManagedAuthMissingMessage(missingProvider, preparation.managedRoot, preparation.bootstrapFrom),
        })),
      ];
    }

    for (const authProvider of requiredProviders) {
      const source = preparation.copiedProviders.includes(authProvider) ? "bootstrapped" : "managed store";
      checks.push({
        id: `hermes.auth.${authProvider}`,
        status: "ok",
        message: `Hermes managed auth for ${authProvider} is available from ${source}`,
      });
    }

    if (requiredProviders.includes("openai-codex")) {
      const validation = await manager.validateOpenAiCodex({ refreshIfExpiring: options.strict === true });
      checks.push({
        id: "hermes.auth.openai-codex.resolve",
        status: "ok",
        message: `Hermes Python resolved openai-codex auth via ${validation.source ?? "unknown source"}`,
      });
    }

    return checks;
  } catch (error) {
    return [
      {
        id: "hermes.auth",
        status: "error",
        message: redactHermesAuthMessage(errorMessage(error)),
      },
    ];
  }
}

function hasBaselineCursorModel(
  model: string,
  modelParams: Array<{ id: string; value: string }>,
  allowLargeContext: boolean,
): boolean {
  return (
    model === "gpt-5.5" &&
    !allowLargeContext &&
    modelParams.some((param) => param.id === "context" && param.value === "272k") &&
    modelParams.some((param) => param.id === "reasoning" && param.value === "extra-high")
  );
}

function formatModelParams(modelParams: Array<{ id: string; value: string }>): string {
  if (modelParams.length === 0) return "none";
  return modelParams.map((param) => `${param.id}=${param.value}`).join(", ");
}

async function checkWritable(checks: DoctorCheck[], id: string, directory: string): Promise<void> {
  const probe = path.join(directory, `.doctor-${randomUUID()}`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    checks.push({ id, status: "ok", message: `${directory} is writable` });
  } catch (error) {
    checks.push({ id, status: "error", message: errorMessage(error) });
  }
}

export async function reviewLoopDoctorChecks(
  config: ServiceConfig,
  options: ReviewLoopDoctorCheckOptions,
): Promise<DoctorCheck[]> {
  return [
    reviewLoopStateCheck(config),
    await linearStateAvailabilityCheck(config, options),
    blockedAvailabilityCheck(config),
    await mcpToolAvailabilityCheck(config, options),
    candidateIsolationCheck(config),
  ];
}

function reviewLoopStateCheck(config: ServiceConfig): DoctorCheck {
  if (config.reviewLoop.reviewStates.length === 0) {
    return { id: "review_loop.states", status: "error", message: "review_loop.review_states must include an agent review queue state" };
  }
  if (config.reviewLoop.reviewPassState === null) {
    return {
      id: "review_loop.states",
      status: "error",
      message: "review_loop.review_pass_state must name the configured pass destination for dogfood smoke",
    };
  }
  return {
    id: "review_loop.states",
    status: "ok",
    message: `review_states: ${config.reviewLoop.reviewStates.join(", ")}; pass destination: ${config.reviewLoop.reviewPassState}`,
  };
}

async function linearStateAvailabilityCheck(
  config: ServiceConfig,
  options: ReviewLoopDoctorCheckOptions,
): Promise<DoctorCheck> {
  const requiredStates = uniqueStates([
    ...config.tracker.handoffStates,
    ...config.reviewLoop.reviewStates,
    ...config.reviewLoop.blockedStates,
    ...(config.reviewLoop.reviewPassState === null ? [] : [config.reviewLoop.reviewPassState]),
  ]);
  if (requiredStates.length === 0) {
    return {
      id: "review_loop.linear_states",
      status: "warn",
      message: "No review-loop Linear states are configured to verify",
    };
  }

  const lister =
    options.linearStateLister ??
    ((input) => createLinearTrackerClientForCapability(input.config, "linear.tracker").fetchWorkflowStatesByTeam());
  try {
    const teamStates = await lister({ config });
    if (teamStates.length === 0) {
      return {
        id: "review_loop.linear_states",
        status: "error",
        message: "Linear project did not return any teams to verify review-loop states",
      };
    }

    const missingByTeam = teamStates
      .map((team) => ({
        team,
        missing: requiredStates.filter((state) => !stateIn(state, team.states)),
      }))
      .filter((item) => item.missing.length > 0);
    if (missingByTeam.length > 0) {
      return {
        id: "review_loop.linear_states",
        status: "error",
        message: `Linear teams are missing configured review-loop states: ${missingByTeam
          .map(
            (item) =>
              `${formatTeamStateLabel(item.team)} missing ${item.missing.join(", ")} (available: ${formatStateList(item.team.states)})`,
          )
          .join("; ")}`,
      };
    }
    return {
      id: "review_loop.linear_states",
      status: "ok",
      message: `Linear project teams have configured review-loop states: ${requiredStates.join(", ")} (${teamStates
        .map(formatTeamStateLabel)
        .join("; ")})`,
    };
  } catch (error) {
    return {
      id: "review_loop.linear_states",
      status: "error",
      message: `Could not verify Linear review-loop state availability: ${errorMessage(error)}`,
    };
  }
}

function blockedAvailabilityCheck(config: ServiceConfig): DoctorCheck {
  if (config.reviewLoop.blockedStates.length === 0) {
    return {
      id: "review_loop.blocked_state",
      status: "warn",
      message: "No review_loop.blocked_states configured; blocked escalations will comment but leave Linear state unchanged",
    };
  }
  return {
    id: "review_loop.blocked_state",
    status: "ok",
    message: `blocked_states: ${config.reviewLoop.blockedStates.join(", ")}`,
  };
}

async function mcpToolAvailabilityCheck(
  config: ServiceConfig,
  options: ReviewLoopDoctorCheckOptions,
): Promise<DoctorCheck> {
  if (!options.mcpToolLister) {
    if (!options.cliPath) {
      return {
        id: "review_loop.mcp_tools",
        status: "error",
        message: "Configured MCP subprocess runner could not list review-loop MCP tools: missing explicit cliPath",
      };
    }
    const stage = await runSubprocessMcpToolExposureProbe(config, { cliPath: options.cliPath });
    if (stage.status === "failure") {
      return {
        id: "review_loop.mcp_tools",
        status: "error",
        message: `Configured MCP subprocess exposure failed (${stage.failureCode ?? "unknown"}): ${stage.message}`,
      };
    }
    return {
      id: "review_loop.mcp_tools",
      status: "ok",
      message: `Configured MCP subprocess runner exposes tools: ${stage.results.map((result) => result.expectedTool).join(", ")}`,
    };
  }
  const lister = options.mcpToolLister;
  const expected = [
    { command: "completion-report-mcp" as const, tool: COMPLETION_REPORT_TOOL_NAME },
    { command: "review-verdict-mcp" as const, tool: REVIEW_VERDICT_TOOL_NAME },
    { command: "review-feedback-mcp" as const, tool: REVIEW_FEEDBACK_TOOL_NAME },
  ];
  try {
    const missing: string[] = [];
    for (const item of expected) {
      const tools = await lister({ command: item.command, config, workflowPath: options.workflowPath, cliPath: options.cliPath ?? "" });
      if (!tools.includes(item.tool)) missing.push(`${item.command}:${item.tool}`);
    }
    if (missing.length > 0) {
      return {
        id: "review_loop.mcp_tools",
        status: "error",
        message: `Configured MCP subprocess runner did not list required tools: ${missing.join(", ")}`,
      };
    }
    return {
      id: "review_loop.mcp_tools",
      status: "ok",
      message: `Configured MCP subprocess runner lists tools: ${expected.map((item) => item.tool).join(", ")}`,
    };
  } catch (error) {
    return {
      id: "review_loop.mcp_tools",
      status: "error",
      message: `Configured MCP subprocess runner could not list review-loop MCP tools: ${errorMessage(error)}`,
    };
  }
}

function candidateIsolationCheck(config: ServiceConfig): DoctorCheck {
  const reviewActiveOverlap = overlappingStates(config.reviewLoop.reviewStates, config.tracker.activeStates);
  const blockedActiveOverlap = overlappingStates(config.reviewLoop.blockedStates, config.tracker.activeStates);
  if (reviewActiveOverlap.length > 0 || blockedActiveOverlap.length > 0) {
    return {
      id: "review_loop.candidate_isolation",
      status: "error",
      message: `Review-loop states overlap worker candidates: ${[...reviewActiveOverlap, ...blockedActiveOverlap].join(", ")}`,
    };
  }
  if (config.agent.requireLabels.length === 0) {
    return {
      id: "review_loop.candidate_isolation",
      status: "warn",
      message: "No required dispatch labels configured; any routed active-state issue can become a candidate",
    };
  }
  return {
    id: "review_loop.candidate_isolation",
    status: "ok",
    message: `worker candidates require labels: ${config.agent.requireLabels.join(", ")}; review/blocked states are isolated from active states`,
  };
}

function overlappingStates(left: string[], right: string[]): string[] {
  return left.filter((state) => stateIn(state, right));
}

function uniqueStates(states: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const state of states) {
    const key = state.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(state);
  }
  return result;
}

function formatStateList(states: string[]): string {
  return states.length === 0 ? "none" : states.join(", ");
}

function formatTeamStateLabel(team: LinearWorkflowTeamStates): string {
  return team.teamName ? `${team.teamName} (${team.teamKey})` : team.teamKey;
}

function stateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

async function checkGit(checks: DoctorCheck[]): Promise<void> {
  try {
    const result = await execFileAsync("git", ["--version"]);
    checks.push({ id: "git.binary", status: "ok", message: result.stdout.trim() });
  } catch (error) {
    checks.push({ id: "git.binary", status: "error", message: errorMessage(error) });
  }
}

export async function githubPublicationDoctorCheck(config: ServiceConfig): Promise<DoctorCheck> {
  if (!config.github.publishPullRequests) {
    return { id: "github.pr_publication", status: "ok", message: "PR publication is disabled" };
  }
  try {
    const configError = githubCredentialConfigError(config, "github.publication");
    if (configError !== null) {
      return { id: "github.pr_publication", status: "error", message: `github.publication: ${configError}` };
    }
    const github = createGitHubPullRequestClientForCapability(config, "github.publication");
    await github.checkRepositoryAccess();
    return {
      id: "github.pr_publication",
      status: "ok",
      message: githubAccessMessage("GitHub PR publication", config, github, "github.publication"),
    };
  } catch (error) {
    return { id: "github.pr_publication", status: "error", message: `github.publication: ${errorMessage(error)}` };
  }
}

export async function githubReviewFeedbackDoctorCheck(config: ServiceConfig): Promise<DoctorCheck> {
  try {
    const configError = githubCredentialConfigError(config, "github.review_feedback_write");
    if (configError !== null) {
      return { id: "github.review_feedback_write", status: "error", message: `github.review_feedback_write: ${configError}` };
    }
    const github = createGitHubPullRequestClientForCapability(config, "github.review_feedback_write");
    await github.checkRepositoryAccess();
    return {
      id: "github.review_feedback_write",
      status: "ok",
      message: githubAccessMessage("GitHub PR review feedback", config, github, "github.review_feedback_write"),
    };
  } catch (error) {
    return { id: "github.review_feedback_write", status: "error", message: `github.review_feedback_write: ${errorMessage(error)}` };
  }
}

function githubAccessMessage(
  action: "GitHub PR publication" | "GitHub PR review feedback",
  config: ServiceConfig,
  github: ReturnType<typeof createGitHubPullRequestClientForCapability>,
  capability: GitHubCredentialCapability,
): string {
  const base = `${action} can access ${config.github.owner}/${config.github.repo}`;
  const authDescription = githubCredentialAccessDescription(config, capability) ?? github.authenticationDescription();
  return authDescription ? `${base} using ${authDescription}` : base;
}

function githubCredentialConfigError(config: ServiceConfig, capability: GitHubCredentialCapability): string | null {
  const resolved = resolveGitHubClientConfig(config, capability);
  const credential = resolved.credential;
  const app = resolved.github.app;
  if (app === null) return null;

  const label =
    credential?.source === "profile" && credential.kind === "github_app"
      ? `GitHub App profile ${credential.profileName} for ${capability}`
      : credential === null
      ? `top-level github.app for ${capability}`
      : null;
  if (label === null) return null;
  if (!app.appId?.trim()) return `${label} is missing app_id`;
  if (!app.installationId?.trim()) return `${label} is missing installation_id`;
  if (!app.privateKey?.trim() && !app.privateKeyEnvVar?.trim() && !app.privateKeyPath?.trim()) {
    return `${label} is missing private_key or private_key_path`;
  }
  return null;
}

function githubCredentialAccessDescription(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
): string | null {
  const resolved = resolveGitHubClientConfig(config, capability);
  const credential = resolved.credential;
  if (credential?.source === "profile" && credential.kind === "github_app") {
    const installationId = credential.app?.installationId?.trim();
    return `GitHub App profile ${credential.profileName}${installationId ? ` installation ${installationId}` : ""}`;
  }
  if (credential?.source === "profile") {
    return `static GitHub token profile ${credential.profileName}`;
  }
  if (credential?.source === "legacy") {
    return "legacy static GitHub token";
  }
  const installationId = resolved.github.app?.installationId?.trim();
  if (resolved.github.app !== null) {
    return `top-level GitHub App installation${installationId ? ` ${installationId}` : ""}`;
  }
  return null;
}

export function runtimeCredentialDoctorCheck(config: ServiceConfig): DoctorCheck {
  if (config.agent.harness === "cursor") return cursorRuntimeDoctorCheck(config);
  if (config.agent.harness === "hermes") return hermesRuntimeCredentialDoctorCheck(config);
  if (config.agent.harness === "hermes_acp") {
    return {
      id: "env.hermes_acp",
      status: "ok",
      message: "Hermes ACP uses host Hermes profile credentials; Symphony runtime credential env injection is not used",
    };
  }
  return {
    id: "env.runtime",
    status: "warn",
    message: `No runtime credential doctor check is registered for ${config.agent.harness}`,
  };
}

function cursorRuntimeDoctorCheck(config: ServiceConfig): DoctorCheck {
  try {
    const missing = (["worker", "reviewer"] as const).filter((role) => !resolveCursorRuntimeApiKey(config, role));
    if (missing.length === 0) {
      return { id: "env.cursor", status: "ok", message: "runtime.cursor credentials are available for worker and reviewer" };
    }
    return {
      id: "env.cursor",
      status: "warn",
      message: `runtime.cursor credentials are missing for ${missing.join(", ")}; Cursor SDK smoke cannot run`,
    };
  } catch (error) {
    return { id: "env.cursor", status: "error", message: `runtime.cursor: ${errorMessage(error)}` };
  }
}

function hermesRuntimeCredentialDoctorCheck(config: ServiceConfig): DoctorCheck {
  if (isHermesOwnedAuthProvider(config.hermes.provider)) {
    return {
      id: "env.hermes",
      status: "ok",
      message: `Hermes provider ${normalizeHermesAuthProvider(config.hermes.provider ?? "")} uses managed Hermes auth at ${config.hermes.auth.managedRoot}`,
    };
  }
  try {
    const missing = (["worker", "reviewer"] as const).filter((role) => !resolveRuntimeApiKey(config, role, "hermes"));
    if (missing.length === 0) {
      return { id: "env.hermes", status: "ok", message: "runtime.hermes credentials are available for worker and reviewer" };
    }
    return {
      id: "env.hermes",
      status: "warn",
      message:
        `runtime.hermes credentials are missing for ${missing.join(", ")}; ` +
        `${config.hermes.runtimeCredentialEnv} will not be injected for those roles`,
    };
  } catch (error) {
    return { id: "env.hermes", status: "error", message: `runtime.hermes: ${errorMessage(error)}` };
  }
}

