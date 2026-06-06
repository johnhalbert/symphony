# ENG-243 SC-004 No-Upstream-Prompt Dogfood Evidence

Captured on 2026-06-06 for `specs/001-block-agent-github`.

## Purpose

Provide reviewer-checkable evidence that two live Symphony dogfood runs contained no agent-owned upstream-capable command attempts and emitted zero OAuth / SSH / GitHub credential prompt markers. Because SC-004 is scoped to prompts **caused by agent-owned command attempts**, this packet treats the same-run causal no-attempt proof as the primary evidence path and uses operator/desktop observation only when a run leaves an upstream-capable prompt path ambiguous. The packet also records same-run hook-activation evidence plus the separate redaction and service-boundary proof.

## Live Runs Inspected

This packet uses a current worker/reviewer pair from `ENG-281` so the evidence stays on the same issue branch and the worker profile artifacts remain locally inspectable.

| Role | Run ID | Issue | Phase | Status | Model | Started | Completed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| worker | `hermes-d9985558-fa9f-45a0-ba54-99d1e1e2a01d` | `ENG-281` | `implementation` | `succeeded` | `gpt-5.4` | `2026-06-06T02:01:39.968Z` | `2026-06-06T02:10:37.218Z` |
| reviewer | `hermes-0e9ff87d-e2ec-4cdf-8361-99edc6bd8113` | `ENG-281` | `review` | `succeeded` | `gpt-5.4` | `2026-06-06T03:03:01.039Z` | `2026-06-06T03:12:17.283Z` |

Independent inspection pointers:

- `/api/v1/runs/hermes-d9985558-fa9f-45a0-ba54-99d1e1e2a01d`
- `/api/v1/runs/hermes-d9985558-fa9f-45a0-ba54-99d1e1e2a01d/transcript`
- `/api/v1/runs/hermes-0e9ff87d-e2ec-4cdf-8361-99edc6bd8113`
- `/api/v1/runs/hermes-0e9ff87d-e2ec-4cdf-8361-99edc6bd8113/transcript`
- Persisted run files under the workspace state directory:
  - `symphony_workspaces/.symphony/runs/hermes-d9985558-fa9f-45a0-ba54-99d1e1e2a01d/{meta.json,events.jsonl}`
  - `symphony_workspaces/.symphony/runs/hermes-0e9ff87d-e2ec-4cdf-8361-99edc6bd8113/{meta.json,events.jsonl}`
- Same-run activation evidence:
  - Worker retained profile artifacts: `symphony_workspaces/.symphony/hermes/profiles/eng-281/worker/implementation/sym_eng-281_worker_eng-281_implementation_reuse_by_issue/{config.yaml,shell-hooks-allowlist.json}`
  - Reviewer same-run `hermes_profile` event plus deterministic reviewer profile-generation contract evidence in `tests/hermes-command-policy-profile.test.ts` and `tests/hermes-mcp-config.test.ts`

## Inspection Method

For each run, inspect the persisted `meta.json` plus `events.jsonl` stream and:

1. Record the run metadata (`role`, `runPhase`, `status`, `runtimeModel`, `startedAt`, `completedAt`).
2. Inventory every command-capable surface actually used by the run.
   - Worker run `hermes-d9985558-fa9f-45a0-ba54-99d1e1e2a01d` uses `terminal` only.
   - Reviewer run `hermes-0e9ff87d-e2ec-4cdf-8361-99edc6bd8113` uses `terminal` plus one `execute_code` reducer whose same-run preview begins `from hermes_tools import read_file ... root = Path('../.symphony/runs') ...`, indicating a local run-file scan rather than a subprocess or network path.
3. Extract every `Hermes tool terminal:` command and flag any upstream-risk command families rather than only a small literal list:
   - direct upstream Git: `git push`, `git pull`, `git fetch`, `git clone`, `git ls-remote`, `git remote update`, `git remote prune`, upstream `checkout --track`, or remote-add / transport commands that mention GitHub
   - GitHub CLI / network / transport: `gh` or `hub` GitHub operations, `curl` / `wget` requests to `github.com` or `api.github.com`, and `ssh` / `scp` / `sftp` / `plink` GitHub transports
   - opaque wrapper commands that would need separate causal proof if they attempted upstream contact, such as `npm run ...`, `node ...`, `python ...`, or `bash -c ...`
4. Search the full event stream, including runtime stderr and progress payloads, with case-insensitive prompt markers such as:
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
5. Prove same-run command-policy activation.
   - Prefer a persisted `command_policy_decision` event when one exists.
   - Otherwise use the run's `hermes_profile` event plus exact same-run materialized hook files when they are retained.
   - For non-reusable reviewer profiles that are cleaned after exit, use the run's same-run `hermes_profile` event plus deterministic generated-profile contract tests that verify reviewer profile materialization always installs the same `pre_tool_call` `terminal|execute_code` hook and decision-journal path.
6. Apply the SC-004 causal rule. If the recorded command-capable surface inventory shows zero upstream-risk agent-owned attempts, then the run itself contains no prompt-causing agent-owned path. A separate operator/desktop observation note is only needed when the run evidence leaves an unresolved upstream-capable wrapper, helper, network, or surface gap.

## Live Scan Results

### Worker run `hermes-d9985558-fa9f-45a0-ba54-99d1e1e2a01d`

- `commandCapableSurfaces`: `terminal`
- `terminalCommandCount`: `4`
- `promptHitCount`: `0`
- Observed terminal commands stayed local-only:
  - `events.jsonl:402` — `git status --short && printf '\\n---BRANCH---\\n' && git branch --show-current && printf '\\n---DIFFSTAT---\\n' && git diff --stat`
  - `events.jsonl:1231` — workspace-local `npm test -- tests/web-transcript-projection-command-policy.test.ts tests/transcript-replay-command-policy.test.ts`, a package-script wrapper aimed only at repo-local Vitest files
  - `events.jsonl:1315` — `git diff -- docs/smoke/eng-243-sc-004-no-upstream-prompts.md`
  - `events.jsonl:1424` — `git status --short`
- No upstream-risk terminal command families, network clients, GitHub transports, or unresolved wrapper/helper paths appeared in the worker run; the lone package-script wrapper stayed scoped to repo-local test files only.

### Reviewer run `hermes-0e9ff87d-e2ec-4cdf-8361-99edc6bd8113`

- `commandCapableSurfaces`: `terminal` plus one local `execute_code` reducer (`events.jsonl:1582-1585`)
- `terminalCommandCount`: `14`
- `promptHitCount`: `0`
- Observed terminal commands stayed local-only:
  - `events.jsonl:319` — local `git status` / `git diff --stat` / `git diff --name-only`
  - `events.jsonl:324` — local `git log` / `git merge-base` / `git rev-parse`
  - `events.jsonl:512`, `:517`, `:522`, and `:527` — local diffs against `quickstart.md`, `agent-command-policy.md`, `eng-243-sc-004-no-upstream-prompts.md`, and the then-present runtime/test files
  - `events.jsonl:1368`, `:1373`, and `:1470` — vendored-Hermes base/worktree diff and status checks
  - `events.jsonl:1465` — a local loop over persisted run files for the cited evidence packet
  - `events.jsonl:1475` — `git diff --check origin/main...HEAD`
  - `events.jsonl:2643` and `:2648` — workspace-local Vitest/package-script invocations targeting repo-local test files only
  - `events.jsonl:4350` — local unified diff against the then-present runtime/test files
- The `execute_code` reducer is also local-only. Its same-run preview at `events.jsonl:1583` begins `from hermes_tools import read_file ... root = Path('../.symphony/runs') ...`, showing a read-only scan of persisted run files rather than a subprocess, network, or credential-backed path.
- No upstream-risk terminal command families, transport/client executables, or unresolved wrapper/helper paths appeared in the reviewer run.

## Same-Run Command-Policy Activation Evidence

The chosen live runs do not emit a persisted `command_policy_decision` event, so this packet proves same-run activation through the `hermes_profile` event plus retained/generated hook artifacts.

- Worker run:
  - `../.symphony/runs/hermes-d9985558-fa9f-45a0-ba54-99d1e1e2a01d/events.jsonl:5` records the same-run Hermes profile directory `sym_eng-281_worker_eng-281_implementation_reuse_by_issue`.
  - `../.symphony/hermes/profiles/eng-281/worker/implementation/sym_eng-281_worker_eng-281_implementation_reuse_by_issue/config.yaml:20-33` installs a `pre_tool_call` hook for `terminal|execute_code` that invokes `agent-command-policy-hook --role worker --phase implementation --decision-journal ...agent-command-policy-decisions.ndjson --issue-id 8e72c7fd-52c6-487e-826a-67920b4ba580`.
  - `../.symphony/hermes/profiles/eng-281/worker/implementation/sym_eng-281_worker_eng-281_implementation_reuse_by_issue/shell-hooks-allowlist.json:1-9` records approval of that exact `pre_tool_call` hook command.
- Reviewer run:
  - `../.symphony/runs/hermes-0e9ff87d-e2ec-4cdf-8361-99edc6bd8113/events.jsonl:5` records the same-run fresh reviewer profile directory `sym_eng-281_reviewer_eng-281_review_fresh_per_r_5e62d81631f4e9bb`, the reviewer template directory `hermes/templates/reviewer`, and `reusable: false`.
  - Fresh reviewer profile directories are cleaned after review exit, so the exact same-run materialized `config.yaml` / `shell-hooks-allowlist.json` files are not retained locally.
  - `tests/hermes-command-policy-profile.test.ts:45-85,458-474` verifies that worker and reviewer profile materialization installs the generated `pre_tool_call` hook, and that the hook command always contains `agent-command-policy-hook`, the expected role, the expected phase, the issue id, and the decision-journal path.
  - `tests/hermes-mcp-config.test.ts:155-172` verifies that generated Hermes profile config merges the command-policy hook into `hooks.pre_tool_call` with `hooks_auto_accept: true`.

Taken together, the worker run has same-run retained hook files, and the reviewer run has same-run `hermes_profile` evidence tied to deterministic reviewer generated-profile contract tests. That is enough for a reviewer to independently confirm that the chosen worker/reviewer sessions were running under the command-policy hook path rather than under an unhooked profile.

### SC-004 Conclusion From Live Runs

Across the selected `ENG-281` runs, the recorded command-capable surface inventory is complete enough to rule out prompt-causing agent-owned attempts:

- the worker run used `terminal` only;
- the reviewer run used `terminal` plus one local read-only `execute_code` reducer over persisted run files;
- every recorded terminal command stayed local-only;
- no upstream Git / GitHub / SSH / HTTP transport command families appeared;
- the full event-stream prompt-marker scan returned zero hits.

Because SC-004 is framed as prompts **caused by agent-owned command attempts**, those same-run facts prove the chosen runs produced zero desktop OAuth prompts, SSH key confirmation prompts, or GitHub credential prompts caused by agent-owned attempts. A separate operator/desktop observation note would only be required for a future packet if the chosen run evidence left an unresolved upstream-capable wrapper, helper, network, or surface gap.

## Redaction And Service-Boundary Support Evidence

The chosen live runs prove the no-upstream / no-prompt causal story, but they do not themselves emit a durable `command_policy_decision` sample. This packet therefore pairs the live-run evidence above with automated contract tests for denied-decision redaction and service-owned GitHub boundary behavior.

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
2. Inspecting `meta.json`, `tool_start` events, and `Hermes tool terminal:` events for the two runs to confirm the command-capable surface inventory above (worker: `terminal` only; reviewer: `terminal` plus the local run-file `execute_code` reducer preview at `events.jsonl:1583`).
3. Re-running the prompt-marker scan from **Inspection Method** across both `events.jsonl` files and confirming zero hits.
4. Inspecting the worker same-run `config.yaml` / `shell-hooks-allowlist.json` files, then pairing the reviewer same-run `hermes_profile` event with `tests/hermes-command-policy-profile.test.ts` and `tests/hermes-mcp-config.test.ts` to confirm reviewer materialization installs the same command-policy hook even though fresh reviewer profile directories are cleaned after exit.
5. Comparing the recorded empty-stdout no-touch transcript above with a local rerun of `git diff --name-only origin/main...HEAD -- hermes/upstream-src` and `git status --short -- hermes/upstream-src`.
6. Inspecting the cited automated tests to confirm denied-command audit events stay redacted and that service-owned GitHub paths remain allowed.
7. Adding a same-run operator/desktop observation note only if a future packet chooses runs whose surface inventory leaves an unresolved GUI/browser prompt path.
