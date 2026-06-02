# Research: Block Worker and Reviewer Upstream GitHub Commands

## Decision: Enforce with a shared policy classifier, not prompt text

**Rationale**: The current workflow prompt already tells workers not to commit, push, or create PRs, but observed runs still attempted upstream Git/GitHub operations. Prompt guidance is useful as explanation but cannot be the enforcement boundary. The policy must run before command-capable tool execution and must classify both direct and disguised command attempts.

**Alternatives considered**:

- Prompt-only prohibition: rejected because it cannot prevent desktop OAuth/SSH prompts or remote side effects.
- Disable all terminal tools: rejected because workers and reviewers need safe local inspection.
- Let GitHub/SSH fail naturally: rejected because credential prompts and remote-side effects can happen before failure is visible to Symphony.

## Decision: Place ACP enforcement in the permission resolver path

**Rationale**: `hermes/src/HermesAcpHarness.ts` already parses `session/request_permission` payloads, resolves decisions, emits redacted permission diagnostics, and maps outcomes into run activity. This is the right place to deny terminal execution requests before ACP selects an allow option.

**Alternatives considered**:

- Deny after tool-call events are reported: rejected because the command may already have run.
- Depend on Hermes default permission options: rejected because generic approval does not understand Symphony's service-owned GitHub boundary.

## Decision: Use Hermes profile pre-tool-call hooks for gateway/TUI enforcement

**Rationale**: The non-ACP Hermes gateway has dangerous-command approval handling, but that path is pattern-driven and commands not classified as dangerous can execute without approval. Hermes supports `pre_tool_call` hooks that can block a tool before execution. A Symphony-managed hook in worker/reviewer profiles can call the shared classifier for `terminal`, `shell`, and `execute_code` surfaces before the command reaches Hermes execution.

**Alternatives considered**:

- Respond `deny` to gateway approval requests only: rejected because it catches only commands Hermes already classifies as dangerous.
- Patch vendored Hermes dangerous-command patterns or source code under `hermes/upstream-src/**`: rejected entirely for ENG-243. Vendored Hermes source changes are a deal breaker; Symphony must enforce this through owned orchestration code, generated profile assets, hooks/plugins, MCP/service boundaries, or configuration.
- Disable gateway/TUI terminal tools entirely: acceptable as a fail-closed fallback if hook installation cannot be validated, but it does not satisfy the desired local-inspection workflow.

## Decision: Treat `execute_code` as command-capable

**Rationale**: `execute_code` can run code that may spawn subprocesses, invoke network clients, or call Git/GitHub indirectly. It must be subject to the same worker/reviewer upstream GitHub boundary as terminal commands. The safe default is to deny ambiguous code-execution requests that import or construct subprocess, shell, network, or credential flows unless the implementation can prove the execution is local-only and helper-free.

**Alternatives considered**:

- Allow all `execute_code` because it helps reduce context bloat: rejected for ENG-243 because context efficiency cannot outrank credential and upstream safety.
- Static-scan code and allow anything not obviously unsafe: rejected as insufficient for obfuscated process/network invocation unless paired with sandbox-level restrictions.

## Decision: Preserve local Git inspection through fail-closed Git config checks

**Rationale**: Some local Git commands are safe in ordinary repositories but unsafe when configuration launches helpers, pagers, diff tools, hooks, filters, credential helpers, signing programs, filesystem monitors, transport helpers, or aliases. The classifier must consider inline environment assignments, inherited environment, per-command config, and persisted repo/user config before allowing local inspection.

**Alternatives considered**:

- Allow local Git subcommands by name only: rejected because `git diff`, `git log`, and similar commands can execute helper programs through config.
- Strip all Git environment and config silently: rejected where it could change command meaning without an auditable decision. Sanitization may be used only when the resulting command remains clearly local-only and the denial/audit semantics stay clear.

## Decision: Keep service-owned GitHub credentials in MCP/service paths only

**Rationale**: `src/core/harness/McpSubprocessEnvironment.ts` already slices GitHub credentials by MCP command capability, such as publication and review feedback. ENG-243 should preserve that service path while preventing workers/reviewers from using terminal or code-execution surfaces to access the same credentials.

**Alternatives considered**:

- Remove all GitHub credentials from every subprocess: rejected because service-owned publication and review feedback need controlled credentials.
- Let agents retry failed service writebacks directly: rejected because that breaks the orchestrated workflow boundary.

## Decision: Audit through existing run activity and transcript persistence first

**Rationale**: Symphony already persists run activity, tool diagnostics, transcript events, and replay projections. Command policy decisions should use those durable event paths before introducing a new storage table. This supports replay/restart without adding a queue or new persistence surface for ENG-243.

**Alternatives considered**:

- Store policy decisions only in logs: rejected because logs are not enough for replay and issue-level audit.
- Add a dedicated database table immediately: rejected for now as unnecessary complexity unless existing event paths cannot support the required fields.

## Decision: Validation must include fake-helper side-effect tests

**Rationale**: The latest ENG-243 failure examples allowed command-executing Git configuration such as external diff helpers, pagers, credential helpers, and inline config. Tests must prove the helper does not execute, not merely that the classifier returns a deny label.

**Alternatives considered**:

- Snapshot the deny reasons only: rejected because a classifier can report denial while a helper still executes if the hook is too late.
- Rely on real GitHub/SSH failures: rejected because tests must not contact upstream services or credentials.
