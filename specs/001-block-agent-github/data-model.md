# Data Model: Agent Command Policy

## AgentRun

Represents a worker, reviewer, or merge-conflict-repair execution session.

**Fields**:

- `runId`: Durable Symphony run identifier.
- `issueId`: Linear/Symphony issue identifier.
- `role`: `worker`, `reviewer`, or other configured role.
- `phase`: `implementation`, `review`, `merge_conflict_resolution`, or other known run phase.
- `workspacePath`: Local workspace path for command evaluation.
- `harnessId`: Harness responsible for the run, such as Hermes gateway or Hermes ACP.
- `sessionId`: Runtime session identifier when available.

**Validation rules**:

- Worker/reviewer command policy applies to `worker` and `reviewer` roles.
- Merge-conflict-repair worker runs inherit worker command restrictions.
- Service-owned GitHub actions are not represented as agent command attempts.

## CommandAttempt

Represents a role-accessible tool invocation that may execute a command, shell, script, code, or subprocess.

**Fields**:

- `attemptId`: Unique policy attempt identifier.
- `runId`: Agent run that requested the command.
- `role`: Role that requested the command.
- `surface`: Tool surface, such as `terminal`, `shell`, `execute_code`, `acp_permission`, `gateway_pre_tool_call`, or `subagent_tool_call`.
- `rawInputPreview`: Redacted bounded preview of the original tool input.
- `workingDirectory`: Effective working directory.
- `inheritedEnvironmentKeys`: Sorted list of environment variable names considered by policy.
- `inlineEnvironmentKeys`: Sorted list of inline environment variable names parsed from the command.
- `createdAt`: Timestamp of the policy decision.

**Validation rules**:

- `rawInputPreview` must be redacted and bounded.
- Environment values must not be stored.
- Attempts with unknown or malformed command content are denied when the surface could execute a command.

## NormalizedCommand

Represents the classifier's interpretation of command content.

**Fields**:

- `executable`: Normalized executable name or path when known.
- `executableKind`: `git`, `github_cli`, `ssh`, `network_client`, `shell`, `interpreter`, `package_script`, `unknown`, or `other`.
- `arguments`: Bounded, redacted argument summary.
- `gitSubcommand`: Git subcommand when executable kind is `git`.
- `targetHosts`: Hostnames detected from URLs, remotes, SSH specs, or API calls.
- `hasNestedCommand`: Whether shell, interpreter, package script, or wrapper syntax may execute nested commands.
- `hasInlineEnvironment`: Whether command-local environment assignments were present.
- `hasUnsafeGitConfig`: Whether inline, inherited, or persisted Git configuration can execute helpers or credentials.

**Validation rules**:

- Absolute executable paths must normalize to their basename plus path evidence.
- Windows and POSIX executable suffixes must normalize consistently.
- GitHub host aliases and API endpoints must classify as upstream GitHub contact.
- Unknown nested command content is denied unless proven local-only.

## PolicyDecision

Represents the allow/deny result for a command attempt.

**Fields**:

- `decisionId`: Stable identifier for the policy decision.
- `attemptId`: Related command attempt.
- `outcome`: `allow` or `deny`.
- `reasonKind`: Structured reason, such as `upstream_github`, `unsafe_git_config`, `unsafe_environment`, `unknown_command`, `safe_local_inspection`, or `service_owned_not_applicable`.
- `requiresCodeChange`: Whether the denied operation indicates the agent should change implementation code instead.
- `requiresUserOrServiceFix`: Whether the denial indicates a service-owned workflow or user action is needed.
- `message`: Redacted actionable message returned to the agent.
- `evidence`: Bounded structured details needed for audit and replay.

**Validation rules**:

- Denial messages must not include credential values.
- `allow` decisions must identify why the command is local-only.
- `deny` decisions must be recorded before command execution.
- Replay must reproduce the same outcome from persisted evidence or preserved policy inputs.

## UnsafeGitConfigFinding

Represents Git configuration or environment that can turn local inspection into helper execution or credential use.

**Fields**:

- `source`: `inline_env`, `inherited_env`, `inline_git_config`, `persisted_repo_config`, `persisted_user_config`, or `unknown`.
- `key`: Redacted configuration or environment key.
- `category`: `alias`, `pager`, `external_diff`, `credential_helper`, `hook`, `filter`, `signing_program`, `filesystem_monitor`, `transport_helper`, `ssh_command`, or `other`.
- `effect`: `executes_helper`, `uses_credentials`, `contacts_remote`, or `ambiguous`.

**Validation rules**:

- Values must be redacted or omitted.
- Findings that could execute helpers, use credentials, or contact remotes cause fail-closed denial.

## ServiceOwnedGitHubAction

Represents publication, PR review feedback, mergeability, CI, merge, or writeback work performed by Symphony service code rather than by a worker/reviewer command.

**Fields**:

- `actionId`: Service action identifier.
- `capability`: Service capability, such as `github.publication`, `github.review_feedback_write`, or merge/writeback capability.
- `credentialProfile`: Profile name or capability owner, without credential value.
- `runId`: Related agent run when the action is caused by a handoff.
- `issueId`: Related issue.
- `status`: `pending`, `succeeded`, `failed`, or `blocked`.

**Validation rules**:

- Service actions are outside worker/reviewer command policy.
- Failures must be recorded as service workflow failures, not as permission for an agent to retry directly.
- Credential values must never be stored.

## State Transitions

```text
CommandAttempt created
  -> PolicyDecision allow
      -> Command executes
      -> Result recorded through existing tool/run activity
  -> PolicyDecision deny
      -> Command does not execute
      -> Denial message returned to agent
      -> Redacted policy decision recorded for audit/replay
```

```text
ServiceOwnedGitHubAction pending
  -> succeeded
  -> failed
  -> blocked
```

Service-owned transitions do not pass through `CommandAttempt` unless an agent tries to perform the action directly, in which case that attempt is denied as agent-owned upstream GitHub activity.
