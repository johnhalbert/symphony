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
- Matching worker profile artifacts and a preserved reviewer role/phase profile example:
  - Worker same-run profile: `symphony_workspaces/.symphony/hermes/profiles/eng-241/worker/implementation/sym_eng-241_worker_eng-241_implementation_reuse_by_issue/{config.yaml,shell-hooks-allowlist.json}`
  - Reviewer role/phase profile example: `symphony_workspaces/.symphony/hermes/profiles/eng-241/reviewer/review/sym_eng-241_reviewer_eng-241_review_fresh_per_r_e07489e456403225/{config.yaml,shell-hooks-allowlist.json}`

## Inspection Method

For each run, inspect the persisted `events.jsonl` stream and:

1. Extract every `Hermes tool terminal:` command.
2. Flag any upstream-risk command families rather than only a small literal list:
   - direct upstream Git: `git push`, `git pull`, `git fetch`, `git clone`, `git ls-remote`, `git remote update`, `git remote prune`, upstream `checkout --track`, or remote-add / transport commands that mention GitHub
   - GitHub CLI / network / transport: `gh` or `hub` GitHub operations, `curl` / `wget` requests to `github.com` or `api.github.com`, and `ssh` / `scp` / `sftp` / `plink` GitHub transports
   - opaque wrapper commands that would need separate policy evidence if they attempted upstream contact, such as `npm run ...`, `node ...`, `python ...`, or `bash -c ...`
3. Search the full event stream, including runtime stderr and progress payloads, with case-insensitive prompt markers such as:
   - `oauth`
   - `device code`
   - `open this url`
   - `browser auth`
   - `ssh key confirmation`
   - `authenticity of host`
   - `are you sure you want to continue connecting`
   - `github credential`
   - `credential prompt`
   - `username for`
   - `password for`
   - `passphrase`
   - `gh auth`
   - `git-credential`
   - `ssh-askpass`
4. Inspect the same run's `hermes_profile` event together with any preserved matching `config.yaml` / `shell-hooks-allowlist.json` artifacts to confirm the `pre_tool_call` `terminal|execute_code` hook was installed for that worker/reviewer session. If the exact run profile directory is no longer retained, use the `hermes_profile` event plus a preserved same-issue same-role profile example to show the role/phase hook wiring.
5. Treat transcript/event scanning as proof of **terminal-visible** prompt markers only. GUI/browser dialogs that bypass transcript logging still require a same-run operator/desktop observation source when assembling the final SC-004 packet.

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
- The `node` / `npm` entries are recorded here as factual workspace-local terminal activity from the captured run, **not** as helper-free command-policy allow-list examples. The interpreter/package-script allow-or-deny contract is covered by the automated command-policy suite cited below.

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
- The `node` / `npm` / `python` entries are again recorded as observed local activity, not as a claim that those wrapper surfaces are part of the helper-free local-inspection allow list.

## Command-Policy Hook Materialization Evidence

The chosen live runs do not expose a persisted `command_policy_decision` event, so the packet proves command-policy activation through the preserved profile materialization artifacts that are still available locally:

- Worker run:
  - `../.symphony/runs/hermes-37ff7bb2-c3e1-4990-b8d1-294e9d3fcc64/events.jsonl:5` records the materialized Hermes profile directory for the worker session.
  - `../.symphony/hermes/profiles/eng-241/worker/implementation/sym_eng-241_worker_eng-241_implementation_reuse_by_issue/config.yaml:20-32` installs a `pre_tool_call` hook for `terminal|execute_code` that invokes `agent-command-policy-hook --role worker --phase implementation --decision-journal ...agent-command-policy-decisions.ndjson`.
  - `../.symphony/hermes/profiles/eng-241/worker/implementation/sym_eng-241_worker_eng-241_implementation_reuse_by_issue/shell-hooks-allowlist.json:1-9` records approval of that exact `pre_tool_call` hook command.
- Reviewer run:
  - `../.symphony/runs/hermes-a3f2234a-c6bf-454b-b3cf-6b49f8066500/events.jsonl:5` records the live review session's Hermes profile directory.
  - The exact archived reviewer profile directory from that event is no longer present in the workspace snapshot, so this packet cannot replay the same-run reviewer hook files directly from disk.
  - `../.symphony/hermes/profiles/eng-241/reviewer/review/sym_eng-241_reviewer_eng-241_review_fresh_per_r_e07489e456403225/config.yaml:19-31` and `.../shell-hooks-allowlist.json:1-9` show the preserved reviewer role/phase profile wiring for the same issue, including the `pre_tool_call` `terminal|execute_code` hook that invokes `agent-command-policy-hook --role reviewer --phase review --decision-journal ...agent-command-policy-decisions.ndjson`.

Taken together, those artifacts show the ENG-241 worker profile retained same-run hook materialization evidence, and the reviewer run plus preserved reviewer profile example still demonstrate that the Hermes review role/phase wiring used the command-policy hook path rather than treating the live zero-prompt scan as hook-free execution.

### SC-004 Conclusion From Live Runs

The inspected worker and reviewer dogfood runs executed only workspace-local git inspection, local code inspection, local tests, and local smoke commands. The transcript scan found **zero** upstream Git/GitHub terminal commands and **zero** prompt-marker hits across the full persisted event stream, and the preserved worker profile artifacts plus reviewer profile materialization evidence above show that command-policy hook wiring was in place for the ENG-241 worker/reviewer role path. That proves the recorded run pair avoided agent-owned upstream command attempts and emitted no **terminal-visible** OAuth / SSH / GitHub credential prompt markers. GUI/browser dialogs can bypass transcript logging, so the full desktop/browser-prompt claim still depends on a same-run operator/desktop observation source as described in `specs/001-block-agent-github/quickstart.md`. The automated evidence below supplies the separate allow/deny, redaction, and service-boundary proof that these live runs do not expose on their own.

## Redaction And Service-Boundary Support Evidence

The chosen live runs did not emit a persisted `command_policy_decision` event. This packet therefore uses the live runs for the no-upstream / no-terminal-prompt claim, uses the profile materialization evidence above to prove hook installation, and relies on the automated contract tests below for denied-decision redaction and service-boundary verification.

### Durable redacted audit example

`tests/run-activity-event-command-policy.test.ts` verifies the durable denied-event shape. The durable run-activity event keeps redacted command details in `payload.audit` and records the service-checkable decision metadata at the top level:

```json
{
  "actor": "harness",
  "channel": "diagnostic",
  "kind": "command_policy_decision",
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
    "upstreamContactAttempted": false,
    "requestKind": "terminal_execute",
    "toolCallId": "tool-call-terminal-1",
    "permissionOutcome": "denied",
    "hookAction": "block",
    "audit": {
      "redacted": true,
      "commandClass": "direct_upstream_git_operation",
      "reasonKind": "upstream_github",
      "upstreamContactAttempted": false,
      "targetHosts": ["github.com"]
    }
  }
}
```

`tests/transcript-replay-command-policy.test.ts` verifies a **public transcript event** view. The public read keeps the safe fallback `message` while exposing only redacted metadata inside `payload`:

```json
{
  "message": "Command policy deny: upstream_github (worker · implementation · terminal_execute)",
  "payload": {
    "kind": "command_policy_decision",
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "commandClass": "direct_upstream_git_operation",
    "permissionOutcome": "denied",
    "hookAction": "block",
    "redacted": true,
    "env": "[redacted environment values]",
    "helperPath": "[redacted helper path]",
    "audit": {
      "rawInputPreview": "[redacted command payload]",
      "rawInputPreviewRedacted": true,
      "commandPreview": "[redacted command payload]",
      "helperPath": "[redacted helper path]",
      "redacted": true
    },
    "normalizedCommand": {
      "argumentsPreview": "[redacted command payload]"
    }
  }
}
```

`tests/web-transcript-projection-command-policy.test.ts` verifies the **web status projection** shape. Unlike the public transcript event above, the web projection collapses the safe fields into a status message plus a `policy` summary object:

```json
{
  "kind": "status",
  "state": "command_policy_decision",
  "ts": "2026-01-01T00:00:00.000Z",
  "text": "Command policy deny: upstream_github (worker · implementation · terminal_execute)",
  "policy": {
    "outcome": "deny",
    "reasonKind": "upstream_github",
    "role": "worker",
    "phase": "implementation",
    "surface": "terminal_execute",
    "commandClass": "direct_upstream_git_operation",
    "upstreamContactAttempted": false,
    "requiresUserOrServiceFix": true,
    "requestKind": "pre_tool_call",
    "hookAction": "block",
    "permissionOutcome": "denied"
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
  - public transcript reads use redacted fallback text and payloads
  - web status projections expose only safe command-policy summary metadata
- `tests/completion-report-mcp-command-policy.test.ts`
  - service-owned publication remains allowed while equivalent worker terminal / `execute_code` attempts are denied
- `tests/review-feedback-mcp-command-policy.test.ts`
  - service-owned reviewer feedback remains allowed while direct reviewer `gh pr review` attempts are denied
- `tests/github-service-boundary-command-policy.test.ts`
  - mergeability / CI GitHub paths stay outside worker/reviewer command policy

## Vendored Hermes No-Touch Check

The ENG-281 branch did not modify vendored Hermes source. The protected-surface check compares the branch diff against the PR base ref and separately checks for any remaining worktree/index changes:

```text
$ git diff --name-only origin/main...HEAD -- hermes/upstream-src
# stdout: <empty>

$ git status --short -- hermes/upstream-src
# stdout: <empty>
```

Taken together, those commands show there are zero committed vendored-Hermes branch changes and zero uncommitted vendored-Hermes worktree/index changes, which is the expected passing result for REQ-005.

## Reviewer Checklist

A reviewer can independently confirm this evidence packet by:

1. Opening the four `/api/v1/runs/...` endpoints above and checking the stored status/phase/model/timestamps.
2. Inspecting the two persisted `events.jsonl` files (or transcript API output) and confirming the listed `Hermes tool terminal:` commands are local-only.
3. Inspecting the worker same-run `config.yaml` / `shell-hooks-allowlist.json` files plus any preserved reviewer role/phase profile example and confirming the `pre_tool_call` `terminal|execute_code` hook invokes `agent-command-policy-hook` for the ENG-241 worker/reviewer profile wiring.
4. Re-running the transcript scan for the blocked-command and prompt-marker patterns listed in **Inspection Method** and confirming zero upstream-command hits and zero terminal-visible prompt hits.
5. Adding the same-run operator/desktop observation note if the reviewer needs to confirm GUI/browser prompt absence rather than only transcript-visible markers.
6. Comparing the recorded empty-stdout no-touch transcript above with a local rerun of `git diff --name-only origin/main...HEAD -- hermes/upstream-src` and `git status --short -- hermes/upstream-src`.
7. Inspecting the cited automated tests to confirm denied-command audit events stay redacted and that service-owned GitHub paths remain allowed.
