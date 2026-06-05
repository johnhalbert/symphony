# ENG-243 SC-004 No-Upstream-Prompt Dogfood Evidence

Captured on 2026-06-05 for `specs/001-block-agent-github`.

## Purpose

Provide reviewer-checkable evidence that post-rollout Symphony dogfood runs did **not** trigger desktop OAuth prompts, SSH key confirmation prompts, or GitHub credential prompts from agent-owned command attempts, while keeping the command-policy audit/redaction story independently verifiable.

## Live Runs Inspected

The live evidence packet uses a recent worker/reviewer pair from `ENG-241` (`ENG-185E: Add end-to-end smoke for durable live web app behavior`) because both runs completed successfully under the Hermes harness after the command-policy rollout and expose durable transcript state through the status API and persisted run logs.

| Role | Run ID | Issue | Phase | Status | Model | Started | Completed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| worker | `hermes-37ff7bb2-c3e1-4990-b8d1-294e9d3fcc64` | `ENG-241` | `implementation` | `succeeded` | `gpt-5.4` | `2026-06-05T02:00:57.234Z` | `2026-06-05T02:13:45.611Z` |
| reviewer | `hermes-a3f2234a-c6bf-454b-b3cf-6b49f8066500` | `ENG-241` | `review` | `succeeded` | `gpt-5.4` | `2026-06-05T02:13:54.924Z` | `2026-06-05T02:29:08.391Z` |

Independent inspection pointers:

- `/api/v1/runs/hermes-37ff7bb2-c3e1-4990-b8d1-294e9d3fcc64`
- `/api/v1/runs/hermes-37ff7bb2-c3e1-4990-b8d1-294e9d3fcc64/transcript`
- `/api/v1/runs/hermes-a3f2234a-c6bf-454b-b3cf-6b49f8066500`
- `/api/v1/runs/hermes-a3f2234a-c6bf-454b-b3cf-6b49f8066500/transcript`
- Persisted run files under the workspace state directory:
  - `symphony_workspaces/.symphony/runs/hermes-37ff7bb2-c3e1-4990-b8d1-294e9d3fcc64/{meta.json,events.jsonl}`
  - `symphony_workspaces/.symphony/runs/hermes-a3f2234a-c6bf-454b-b3cf-6b49f8066500/{meta.json,events.jsonl}`

## Inspection Method

For each run, inspect the persisted `events.jsonl` stream and:

1. Extract every `Hermes tool terminal:` command.
2. Flag blocked-command patterns:
   - upstream Git: `git fetch`, `git pull`, `git push`, `git clone`, `git ls-remote`, `git remote update`
   - GitHub CLI/network: `gh auth`, `gh api`, `gh pr`, `gh run`, `curl`, `wget`, `ssh`, `scp`, `sftp`, `plink`
3. Search the full event stream, including runtime stderr and progress payloads, for prompt markers:
   - `oauth`
   - `ssh key confirmation`
   - `github credential`
   - `credential prompt`
   - `gh auth`
   - `git-credential`
   - `ssh-askpass`

## Live Scan Results

### Worker run `hermes-37ff7bb2-c3e1-4990-b8d1-294e9d3fcc64`

- `terminalCommandCount`: `6`
- `blockedTerminalCommandCount`: `0`
- `promptHitCount`: `0`
- Observed terminal commands stayed local-only:
  - `git status --short ... git branch --show-current ... git rev-parse @{upstream}`
  - `git diff --stat origin/main...HEAD ...`
  - workspace-local `node` module inspection
  - `node --check web/scripts/browser-vite-proxy-smoke.mjs && npm run test --prefix web -- tests/apiDataSource.test.ts ...`
  - `npm test -- tests/web-transcript-api.test.ts`
  - `git rev-parse HEAD` and `git status --short`

### Reviewer run `hermes-a3f2234a-c6bf-454b-b3cf-6b49f8066500`

- `terminalCommandCount`: `12`
- `blockedTerminalCommandCount`: `0`
- `promptHitCount`: `0`
- Observed terminal commands stayed local-only:
  - `git diff --stat origin/main...HEAD ...`
  - `git status --short ... git rev-parse HEAD ... git rev-parse origin/main`
  - `node --check web/scripts/browser-vite-proxy-smoke.mjs`
  - `npm test -- tests/web-transcript-api.test.ts`
  - `npm run test --prefix web -- tests/apiDataSource.test.ts ...`
  - local Python file inspection commands against `web/scripts/...` and `web/tests/...`
  - `npm run smoke:browser --prefix web`
  - `sleep 22`

### SC-004 Conclusion From Live Runs

The inspected worker and reviewer dogfood runs executed only workspace-local git inspection, local code inspection, local tests, and local smoke commands. The transcript scan found **zero** upstream Git/GitHub terminal commands and **zero** prompt-marker hits across the full persisted event stream. That satisfies the live dogfood portion of SC-004 for these runs: no desktop OAuth prompt, SSH key confirmation prompt, or GitHub credential prompt was observed from agent-owned command attempts.

## Redaction And Service-Boundary Support Evidence

The chosen live runs did not emit a `command_policy_decision` event because the agents stayed inside allowed local-only behavior. Redaction behavior is therefore supported by the automated contract tests that exercise denied policy decisions and public transcript projection.

### Structured redacted audit example

`tests/run-activity-event-command-policy.test.ts` and `tests/transcript-replay-command-policy.test.ts` verify the durable denied-event shape, including structured metadata and `upstreamContactAttempted: false`:

```json
{
  "message": "Command policy deny: upstream_github (worker · implementation · terminal_execute)",
  "payload": {
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "commandClass": "direct_upstream_git_operation",
    "permissionOutcome": "denied",
    "hookAction": "block",
    "upstreamContactAttempted": false,
    "message": "[redacted command payload]",
    "text": "[redacted command payload]",
    "commandPreview": "[redacted command payload]",
    "rawInputPreview": "[redacted command payload]",
    "env": "[redacted environment values]",
    "helperPath": "[redacted helper path]",
    "redacted": true
  }
}
```

### Supporting automated checks

- `tests/run-activity-event-command-policy.test.ts`
  - durable `command_policy_decision` audit schema
  - allow vs deny structure
  - redacted helper/env evidence
- `tests/transcript-replay-command-policy.test.ts`
  - transcript replay preserves safe metadata
  - public transcript reads remove raw command payloads, helper paths, and secrets
- `tests/web-transcript-projection-command-policy.test.ts`
  - public transcript and public agent-event projections use redacted fallback text and payloads
- `tests/completion-report-mcp-command-policy.test.ts`
  - service-owned publication remains allowed while equivalent worker terminal / `execute_code` attempts are denied
- `tests/review-feedback-mcp-command-policy.test.ts`
  - service-owned reviewer feedback remains allowed while direct reviewer `gh pr review` attempts are denied
- `tests/github-service-boundary-command-policy.test.ts`
  - mergeability / CI GitHub paths stay outside worker/reviewer command policy

## Reviewer Checklist

A reviewer can independently confirm this evidence packet by:

1. Opening the four `/api/v1/runs/...` endpoints above and checking the stored status/phase/model/timestamps.
2. Inspecting the two persisted `events.jsonl` files (or transcript API output) and confirming the listed `Hermes tool terminal:` commands are local-only.
3. Re-running the transcript scan for the blocked-command and prompt-marker patterns listed in **Inspection Method** and confirming zero hits.
4. Inspecting the cited automated tests to confirm denied-command audit events stay redacted and that service-owned GitHub paths remain allowed.
