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

```json
{
  "outcome": "deny",
  "reasonKind": "unsafe_git_config",
  "commandClass": "git_local_inspection_with_helper",
  "message": "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.",
  "audit": {
    "redacted": true,
    "surface": "terminal",
    "role": "worker",
    "phase": "implementation",
    "normalizedExecutable": "git",
    "gitSubcommand": "diff",
    "inlineEnvironmentKeys": ["GIT_EXTERNAL_DIFF"],
    "unsafeConfigCategories": ["external_diff"],
    "upstreamContactAttempted": false
  }
}
```

### Output Rules

- `outcome` is either `allow` or `deny`.
- `deny` decisions must be returned before command execution.
- Denial messages must be actionable and redacted.
- `allow` decisions must identify the command as local-only and helper-free.
- `reasonKind` must be structured, not inferred from a freeform message.

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

## Service-Owned Boundary Contract

The policy must not block Symphony service-owned GitHub actions invoked through controlled MCP/service paths. If a worker/reviewer attempts the same action directly through a command surface, the attempt is denied and the message points back to the service-owned workflow.
