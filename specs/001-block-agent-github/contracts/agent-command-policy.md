# Contract: Agent Command Policy

## Purpose

Define the expected behavior for role-scoped command policy decisions across worker and reviewer command-capable surfaces.

## Policy Input

Every command-capable surface must provide enough context to classify the attempt before execution.

```json
{
  "runId": "hermes-acp-...",
  "issueId": "af4e8c9f-a5cf-40af-ad57-0fdad1c1bc2d",
  "role": "worker",
  "phase": "implementation",
  "surface": "terminal",
  "workingDirectory": "C:\\Users\\john\\src\\github.com\\johnhalbert\\symphony\\symphony_workspaces\\ENG-243",
  "rawInput": {
    "command": "git status --short"
  },
  "environment": {
    "keysOnly": ["PATH", "HOME", "GIT_PAGER"]
  }
}
```

### Input Rules

- `role`, `phase`, `surface`, and `workingDirectory` are required.
- Raw command/code input is required for command-capable surfaces.
- Environment values must not be persisted in audit output.
- If a surface cannot provide command content before execution, the surface must be disabled for worker/reviewer roles or treated as denied.

## Policy Output

Every decision is structured before execution. The final operator-facing examples below cover the required allow, deny, service-boundary, and redaction scenarios.

### Example: allowed helper-free local inspection

```json
{
  "outcome": "allow",
  "reasonKind": "local_only_inspection",
  "commandClass": "local_git_inspection",
  "message": "Allowed helper-free local Git inspection command.",
  "requiresUserOrServiceFix": false,
  "normalizedCommand": {
    "executable": "git",
    "executableKind": "git",
    "argumentsPreview": "status --short",
    "gitSubcommand": "status",
    "targetHosts": [],
    "hasNestedCommand": false,
    "hasInlineEnvironment": false,
    "hasUnsafeGitConfig": false
  },
  "audit": {
    "redacted": true,
    "surface": "terminal_execute",
    "role": "reviewer",
    "phase": "review",
    "outcome": "allow",
    "reasonKind": "local_only_inspection",
    "commandClass": "local_git_inspection",
    "rawInputPreview": "git status --short",
    "normalizedExecutable": "git",
    "executableKind": "git",
    "gitSubcommand": "status",
    "commandPreview": "git status --short",
    "upstreamContactAttempted": false
  }
}
```

### Example: denied upstream Git command

```json
{
  "outcome": "deny",
  "reasonKind": "upstream_github",
  "commandClass": "direct_upstream_git_operation",
  "message": "Blocked worker/reviewer upstream GitHub activity. Use Symphony service-owned publication, review, and writeback workflow actions instead.",
  "requiresUserOrServiceFix": true,
  "normalizedCommand": {
    "executable": "git",
    "executableKind": "git",
    "argumentsPreview": "push origin HEAD",
    "gitSubcommand": "push",
    "targetHosts": ["github.com"],
    "hasNestedCommand": false,
    "hasInlineEnvironment": false,
    "hasUnsafeGitConfig": false
  },
  "audit": {
    "redacted": true,
    "surface": "terminal_execute",
    "role": "worker",
    "phase": "implementation",
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "commandClass": "direct_upstream_git_operation",
    "rawInputPreview": "git push origin HEAD",
    "normalizedExecutable": "git",
    "executableKind": "git",
    "gitSubcommand": "push",
    "commandPreview": "git push origin HEAD",
    "targetHosts": ["github.com"],
    "upstreamContactAttempted": false
  }
}
```

### Example: denied GitHub CLI command redirected to the service-owned workflow

```json
{
  "outcome": "deny",
  "reasonKind": "upstream_github",
  "commandClass": "github_cli",
  "message": "Blocked worker/reviewer upstream GitHub activity. Use Symphony service-owned publication, review, and writeback workflow actions instead.",
  "requiresUserOrServiceFix": true,
  "normalizedCommand": {
    "executable": "gh",
    "executableKind": "github_cli",
    "argumentsPreview": "pr create --fill",
    "gitSubcommand": null,
    "targetHosts": ["github.com"],
    "hasNestedCommand": false,
    "hasInlineEnvironment": false,
    "hasUnsafeGitConfig": false
  },
  "audit": {
    "redacted": true,
    "surface": "terminal_execute",
    "role": "worker",
    "phase": "implementation",
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "commandClass": "github_cli",
    "rawInputPreview": "gh pr create --fill",
    "normalizedExecutable": "gh",
    "executableKind": "github_cli",
    "commandPreview": "gh pr create --fill",
    "targetHosts": ["github.com"],
    "upstreamContactAttempted": false
  }
}
```

### Example: denied local inspection because a helper or credential path would run

```json
{
  "outcome": "deny",
  "reasonKind": "unsafe_environment",
  "commandClass": "git_local_inspection_with_helper",
  "message": "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.",
  "requiresUserOrServiceFix": true,
  "normalizedCommand": {
    "executable": "git",
    "executableKind": "git",
    "argumentsPreview": "diff",
    "gitSubcommand": "diff",
    "targetHosts": [],
    "hasNestedCommand": false,
    "hasInlineEnvironment": true,
    "hasUnsafeGitConfig": true
  },
  "audit": {
    "redacted": true,
    "surface": "terminal_execute",
    "role": "worker",
    "phase": "implementation",
    "outcome": "deny",
    "reasonKind": "unsafe_environment",
    "commandClass": "git_local_inspection_with_helper",
    "rawInputPreview": "GIT_ASKPASS=[redacted] git diff",
    "rawInputPreviewRedacted": true,
    "commandPreview": "GIT_ASKPASS=[redacted] git diff",
    "inlineEnvironmentKeys": ["GIT_ASKPASS"],
    "unsafeConfigCategories": ["credential_helper"],
    "upstreamContactAttempted": false
  }
}
```

### Output Rules

- `outcome` is either `allow` or `deny`.
- `deny` decisions must be returned before command execution.
- Denial messages must be actionable, redacted, and point back to Symphony service-owned workflow actions when the user is trying to perform a service-owned GitHub task.
- `allow` decisions must identify the command as local-only and helper-free.
- `reasonKind`, `commandClass`, and `upstreamContactAttempted` must stay structured rather than inferred from freeform messages.

## Required Deny Classes

The policy must deny worker/reviewer attempts for these classes:

- Direct upstream Git operations: push, pull, fetch, clone, remote update, upstream checkout, remote branch mutation.
- GitHub CLI operations that read, create, edit, approve, merge, comment, or otherwise contact GitHub.
- SSH or HTTPS GitHub transport, including absolute executable paths.
- GitHub API/web calls through network clients.
- Shell, interpreter, package-script, or wrapper invocations that contain or may contain the above operations.
- Inline or inherited environment that can redirect Git to helpers, credentials, transports, pagers, hooks, filters, signing programs, or command lookup.
- Git configuration that can execute helpers or use credentials during otherwise local commands.
- Unknown or malformed command content where upstream contact or helper execution cannot be ruled out.

## Required Allow Classes

The policy may allow worker/reviewer attempts only when all are true:

- The command is local-only.
- The command cannot contact GitHub.
- The command cannot mutate remotes.
- The command cannot use GitHub credentials.
- The command cannot execute external helpers through Git configuration, environment, aliases, hooks, filters, pagers, or wrapper commands.

Examples include safe forms of local status, diff, log, show, branch listing, blame, and file history inspection.

## Service-Owned Boundary Examples

The same GitHub workflow action can be allowed for the service while denied for workers/reviewers.

```json
[
  {
    "role": "service",
    "phase": "mcp-subprocess",
    "surface": "terminal_execute",
    "command": "gh pr create --fill",
    "outcome": "allow",
    "reasonKind": "role_not_restricted",
    "commandClass": "role_not_restricted"
  },
  {
    "role": "worker",
    "phase": "implementation",
    "surface": "terminal_execute",
    "command": "gh pr create --fill",
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "commandClass": "github_cli"
  },
  {
    "role": "reviewer",
    "phase": "review",
    "surface": "terminal_execute",
    "command": "gh pr review 42 --request-changes --body 'Please fix this'",
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "commandClass": "github_cli"
  }
]
```

The service-owned MCP paths keep their scoped credentials, while direct worker/reviewer command-surface attempts are denied and redirected back to the service-owned workflow.

## ACP Permission Bridge Contract

For Hermes ACP:

- `terminal_execute` permission requests for worker/reviewer roles must pass through the policy before selecting any allow option.
- Denied policy decisions must return a cancelled permission outcome.
- Allowed local-only decisions may select a single-use allow option when the offered options support it.
- The run activity record must include `requestKind`, `toolCallId`, selected or denied outcome, structured reason, and redacted params preview.

## Gateway/TUI Hook Contract

For Hermes gateway/TUI:

- Worker/reviewer profiles must install a `pre_tool_call` hook for command-capable tools.
- The hook must call the same classifier contract as ACP enforcement.
- The hook must return a block decision before command execution when the classifier denies the attempt.
- Hook registration must be validated during profile materialization or harness startup.
- If the hook cannot be installed or verified, command-capable surfaces for affected roles must fail closed.

## Audit Contract

Each policy decision must be visible in durable run activity or transcript replay with:

- Role and phase.
- Surface.
- Normalized command class.
- Allow/deny outcome.
- Structured reason kind.
- Redacted evidence keys and categories.
- Whether upstream contact was attempted. For correct denials this should be false.

### Example: durable redacted audit event

```json
{
  "kind": "command_policy_decision",
  "text": "Command policy deny: upstream_github",
  "payload": {
    "redacted": true,
    "decisionId": "decision-deny-upstream-1",
    "attemptId": "tool-call-terminal-1",
    "surface": "terminal_execute",
    "role": "worker",
    "phase": "implementation",
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "commandClass": "direct_upstream_git_operation",
    "requestKind": "terminal_execute",
    "toolCallId": "tool-call-terminal-1",
    "permissionOutcome": "denied",
    "hookAction": "block",
    "upstreamContactAttempted": false,
    "audit": {
      "redacted": true,
      "commandPreview": "[redacted command payload]",
      "rawInputPreview": "[redacted command payload]",
      "rawInputPreviewRedacted": true,
      "targetHosts": ["github.com"],
      "helperPath": "[redacted helper path]"
    }
  }
}
```

### Example: public transcript projection

```json
{
  "message": "Command policy deny: upstream_github (worker · implementation · terminal_execute)",
  "payload": {
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "role": "worker",
    "phase": "implementation",
    "surface": "terminal_execute",
    "commandClass": "direct_upstream_git_operation",
    "message": "[redacted command payload]",
    "text": "[redacted command payload]",
    "textPreview": "[redacted command payload]",
    "messagePreview": "[redacted command payload]",
    "commandPreview": "[redacted command payload]",
    "rawInputPreview": "[redacted command payload]",
    "env": "[redacted environment values]",
    "helperPath": "[redacted helper path]",
    "redacted": true
  }
}
```

Public reads must omit raw command payloads and protocol payloads entirely, keep only structured metadata such as `outcome`, `reasonKind`, `commandClass`, `role`, `phase`, and `surface`, and replace command text, helper paths, and environment values with redacted placeholders.

## Service-Owned Boundary Contract

The policy must not block Symphony service-owned GitHub actions invoked through controlled MCP/service paths. If a worker/reviewer attempts the same action directly through a command surface, the attempt is denied and the message points back to the service-owned workflow.
