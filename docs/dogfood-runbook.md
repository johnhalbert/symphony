# Symphony Dogfood Runbook

This runbook describes how to move the Engineering Linear backlog from planning into a controlled Symphony dogfood run.

## 1. Keep The Backlog Frozen

Keep `ENG-*` child issues in `Backlog` until their blockers clear and an operator intentionally promotes them.

All child issues in this epic remain `Backlog` with `dogfood-blocked` until
manually promoted. Remove `dogfood-blocked` and add `dogfood-ready` only as
part of an intentional operator promotion after reviewing the issue's fenced
JSON contract, contract checklist, and concrete validation plan.

Agent-eligible issue descriptions must use the durable template in
[`agent-eligible-issue-template.md`](./agent-eligible-issue-template.md) before
promotion. The required sections are `Problem / Goal`, `Issue Contract`,
`Touched Surfaces`, `Acceptance Criteria`, `Contract Checklist`, `Validation
Requirements`, `Out Of Scope`, and `Promotion Readiness`. The `Issue Contract`
section MUST contain a fenced `json` block with positive `schemaVersion`,
non-empty `contractVersion`, and a non-empty `requirements` array of stable
unique IDs and non-empty requirement text. Use the same section names for
docs-only drafting and implementation drafting so workers, reviewers, and
doctor lint evaluate one contract.

Spec Kit artifacts under `specs/` are planning records only for this workflow.
Operators, workers, and reviewers should treat the promoted Linear issue's
fenced JSON `Issue Contract` as the canonical work assignment unless a human
explicitly invokes a Spec Kit workflow for that feature.

Roadmap placeholder issues for continuation search or richer summarization stay `Backlog` with `dogfood-blocked`. Do not add `dogfood-ready` to those placeholders until the issue includes a concrete implementation path beyond interfaces, configuration flags, or docs.

Do not run Symphony against the Engineering project before the gate work lands.

## 2. Verify The Linear Contract

Confirm:

- Project: `Symphony`
- Team: `Engineering`
- Key: `ENG`
- Parent: `ENG-29`
- Active states: `Todo`, `In Progress`
- Reviewer queue state: `In Review`
- Review pass destination: `Ready to Merge`
- Escalation state: `Blocked`
- Terminal states: `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`
- Required dispatch label: `dogfood-ready`
- Deny labels: `dogfood-blocked`, `safety-blocked`

Confirm there are zero issues in `Todo` or `In Progress` before connectivity smoke.

State semantics:

- `Todo` and `In Progress` are the worker implementation queue.
- `In Review` means awaiting independent reviewer-agent review, not human review.
- `Ready to Merge` means the reviewer-agent pass was accepted and the issue is ready for human merge/release action.
- Reviewer-approved merge automation is opt-in only. With the default/manual merge policy, Symphony stops at `Ready to Merge`; `merge_policy.mode: gated` must be configured before Symphony can merge the lifecycle-bound PR and transition Linear to `Done`.
- `Blocked` means human-required escalation, including max review loops or max incomplete worker turns.
- A passing review is recorded through structured reviewer verdict evidence, such as a Linear comment or PR review, before the issue leaves `In Review`.
- Do not add a separate `Ready` or `Ready for Human` state for the current dogfood loop; use the configured `Ready to Merge` pass destination.

## 3. Hermes Runtime Setup

Initialize the upstream Hermes submodule and install the Hermes Python dependencies before dogfood:

```powershell
git submodule update --init hermes/upstream-src
python -m pip install -e '.\hermes\upstream-src[mcp]'
hermes auth add openai-codex
```

Native Windows is supported for Symphony's stdio gateway path when Node 22+ and Python 3.11+ are installed. Configure `hermes.python` in `WORKFLOW.md` if `python` does not resolve to the intended interpreter. WSL is not required for this integration path.

Hermes owns OpenAI Codex auth. Symphony bootstraps selected provider state from the local Hermes auth store into `hermes.auth.managed_root`; it does not read Codex CLI auth directly and does not require `runtime.hermes` API-key credentials for `openai-codex`.

The reference workflow configures Hermes with `provider: openai-codex` and `model: gpt-5.5`. The generated worker, reviewer, and planner profile templates set Hermes `agent.reasoning_effort: xhigh`.

### Host Hermes ACP harness setup

`agent.harness: hermes_acp` uses the operator's host Hermes executable and host profile store. It does **not** run the vendored `hermes/upstream-src` gateway, does **not** use `hermes.auth.managed_root`, and does **not** read `HERMES_AUTH_HOME` for ACP credentials. Before enabling it for dogfood, verify the host CLI directly:

```powershell
hermes --version
hermes profile
hermes acp --check
```

Configure `hermes_acp.binary_path` when the intended host `hermes` is not first on `PATH`. Configure `hermes_acp.source_profile` when the source profile should be a specific host profile rather than the active profile, and optionally configure `hermes_acp.profile_prefix` to identify Symphony-created clones. The older `hermes.acp_binary_path`, `hermes.acp_source_profile`, and `hermes.acp_profile_prefix` aliases remain accepted for compatibility, but new workflows should use the `hermes_acp` section. The source profile must already be authenticated for the configured provider/model, must pass `hermes acp --check` without interactive terminal setup, and must be safe to clone with `hermes profile create <disposable> --clone --clone-from <source> --no-alias`.

Run the opt-in ACP smoke preflight only when host Hermes credentials are available. This is a host-prerequisite check, not final dogfood-unblock evidence:

```powershell
npm run smoke:hermes-acp -- WORKFLOW.md --source-profile <host-profile>
```

This preflight runs against the checked-in `WORKFLOW.md`, so a success report still records the default `configuredHarness` value rather than `"hermes_acp"`. Use it only to prove the host binary/profile prerequisites. For final ACP unblock evidence, rerun the smoke later against `WORKFLOW.hermes-acp.md` so the recorded `configuredHarness` value comes from the disposable ACP workflow copy.

The smoke strips vendored/managed Hermes environment overrides (`HERMES_HOME`, `HERMES_AUTH_HOME`, `HERMES_PYTHON_SRC_ROOT`, `PYTHONPATH`, `HERMES_MODEL`, and `HERMES_TUI_PROVIDER`), honors `hermes_acp.profile_prefix` for generated disposable profile names unless `--profile-prefix` is provided, verifies `hermes --version`, `hermes acp --check`, verifies the source profile with `hermes -p <source> acp --check`, creates a disposable cloned profile, verifies `hermes -p <clone> acp --check`, sends one small ACP prompt through the clone, deletes the clone by default, and confirms the active host profile selection did not change. Use `--keep-profile` or `--keep-temp` only for troubleshooting; delete retained smoke profiles before promoting more work. If the host Hermes binary or profile prerequisite is unavailable, the smoke reports `SKIPPED` with `status: "skipped"` and actionable diagnostics instead of failing the validation command; fix the host prerequisite and rerun before treating host ACP as validated.

For the deeper ACP contract behind this operator checklist, cross-reference [`hermes-acp-integration-spec.md`](./hermes-acp-integration-spec.md#hermes-acp-process), especially [`#profile-lifecycle`](./hermes-acp-integration-spec.md#profile-lifecycle), [`#launch-environment`](./hermes-acp-integration-spec.md#launch-environment), and [`#validation-plan`](./hermes-acp-integration-spec.md#validation-plan). This runbook section is the operator-facing follow-up for the Linear implementation slices `ENG-136`, `ENG-143`, and `ENG-143C`.

Troubleshooting:

- Missing binary or active source profile: install host Hermes, set `hermes_acp.binary_path`/`--binary-path`, or set `hermes_acp.source_profile`/`--source-profile`; legacy `hermes.acp_binary_path` and `hermes.acp_source_profile` remain accepted. The smoke treats these host prerequisites as an actionable skip, not a failed repository validation. Do not point the binary at `hermes/upstream-src`.
- Missing ACP dependencies: run `hermes acp --check` in the host profile and fix the host Hermes installation until it passes.
- Auth failures or only terminal auth methods: refresh provider auth in the host source profile with the normal host Hermes auth flow, then rerun `hermes acp --check`; do not expect `HERMES_AUTH_HOME` or Symphony managed auth bootstrap to satisfy ACP.
- Clone/create failures: choose a fresh `--profile-name` or remove stale smoke profiles with `hermes profile delete <name> --yes`.
- Prompt failures after successful checks: rerun with `--keep-profile --keep-temp`, inspect the retained host profile and workspace, then delete the retained profile manually.

## 4. Preflight

Run:

```powershell
$env:LINEAR_PROJECT_SLUG = "symphony-6cf4dcc723df"
$env:LINEAR_ASSIGNEE = "me"
npm run typecheck
npm test
npm run doctor -- --strict
npm run doctor -- --strict --live-runtime
npm run smoke:hermes-local
# Optional host-ACP preflight only: this runs against the default WORKFLOW.md
# and is not acceptable final dogfood-unblock evidence.
npm run smoke:hermes-acp -- WORKFLOW.md --source-profile <host-profile>
```

Set `LINEAR_API_KEY`, `SYMPHONY_WORKSPACE_TOKEN`, and the GitHub credential variables in the workflow root `.env` file or process environment as needed. The reference workflow uses app-backed credential profiles: existing `GITHUB_APP_*` variables identify the publication/merge app, and `GITHUB_REVIEW_APP_*` variables identify a separate reviewer app for PR approvals and change requests. Static-token profiles such as `GITHUB_PUBLICATION_TOKEN` and `GITHUB_FEEDBACK_TOKEN` remain supported for non-app deployments.

### Multi-project workflow configuration

Existing single-project workflows stay valid. When `project_contexts` is absent, Symphony synthesizes one default project context from the top-level `tracker`, `workspace`, `github`, `review_loop`, `issue_breakdown`, `agent`, and `credential_profiles` blocks. Keep the current top-level-only `WORKFLOW.md` shape when every issue routes to one Linear project and one codebase.

When one workflow needs to carry configuration for more than one project context, keep truly service-wide settings at the top level and move per-project overrides into `project_contexts`. In the current dogfood runtime, the first enabled explicit context becomes the compatibility default context for legacy code paths and remains the active dispatch context for polling and workspace creation, so list the primary project first. Additional contexts are still useful for workflow authoring, `doctor` validation, and future routing work, but one live dogfood workflow process does not yet poll or create worktrees for every listed context.

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
workspace:
  root: ./symphony_workspaces
  state_dir: ./.symphony
  source:
    kind: git_worktree
    base_ref: origin/main
    branch_template: "symphony/{{ issue.identifier }}"
    cleanup: refuse_dirty
github:
  owner: johnhalbert
  repo: symphony

project_contexts:
  - id: symphony
    label: Symphony
    tracker:
      project_slug: $SYMPHONY_LINEAR_PROJECT
    workspace:
      source:
        repository: .

  - id: docs
    label: Documentation Site
    tracker:
      project_slug: $DOCS_LINEAR_PROJECT
    workspace:
      source:
        repository: ../docs-site
    github:
      owner: johnhalbert
      repo: docs-site
```

Use that pattern as the operator-facing baseline:

- Each enabled context needs its own `tracker.project_slug` and enough `workspace.source` fields for the selected source kind.
- Top-level `workspace`, `github`, `review_loop`, `issue_breakdown`, `agent`, and `credential_profiles` blocks act as defaults; a context should override only the fields it actually needs to change.
- `workspace.source.branch_template` currently renders only `issue.*` fields. Use supported values such as `{{ issue.identifier }}` and do not document `project.*` template variables until the renderer exposes them.
- Do not inline API keys, tokens, private keys, or repository URLs with embedded credentials in `project_contexts`. Use environment references or named `credential_profiles` instead. If a context truly needs different credentials, keep them env-backed or app-backed just like the examples in [`trust-and-safety.md`](./trust-and-safety.md#credential-profiles).

### Project-context redaction rules

`npm run doctor -- --strict` should summarize configured project contexts without printing resolved secret values. The `workflow.project_contexts` check is expected to show context ids and labels, the Linear project slug, the workspace source kind, boolean configured/not-configured flags such as `repositoryConfigured`, `baseRefConfigured`, and `branchTemplateConfigured`, the workspace `cleanup` mode, and whether a GitHub token is present.

It must not print raw API keys, GitHub tokens, private keys, credential profile secret material, provider account contents, or repository URLs that embed credentials. A sanitized summary looks like this:

```text
[OK] workflow.project_contexts: Configured project contexts (default: symphony): [{"id":"symphony","label":"Symphony","enabled":true,"tracker":{"projectSlug":"SYMPHONY"},"workspace":{"source":{"kind":"git_worktree","pathConfigured":false,"repositoryConfigured":true,"refConfigured":false,"baseRefConfigured":true,"branchTemplateConfigured":true,"cachePathConfigured":false,"cleanup":"refuse_dirty"}},"github":{"tokenPresent":true}},{"id":"docs","label":"Documentation Site","enabled":true,"tracker":{"projectSlug":"DOCS"},"workspace":{"source":{"kind":"git_worktree","pathConfigured":false,"repositoryConfigured":true,"refConfigured":false,"baseRefConfigured":true,"branchTemplateConfigured":true,"cachePathConfigured":false,"cleanup":"refuse_dirty"}},"github":{"tokenPresent":true}}]
```

Validation failures should point at the offending config path without echoing secret material. For example:

```text
[ERROR] workflow.parse: project_contexts["Docs Site"].workspace.source is required for enabled project contexts
```

If operator-facing workflow or doctor output includes a raw environment value, token, or credential-bearing repository URL, treat that as a redaction regression and stop promotion until it is fixed.

Normal doctor is non-LLM and non-costly. It verifies workflow parsing, writable workspace paths, git availability, runtime harness/provider checks, Hermes paths, Python importability, managed auth readiness when `openai-codex` is selected, review-loop state configuration, actual Linear availability of `In Review`, `Blocked`, and `Ready to Merge` when Linear access is available, subprocess MCP tool availability, candidate isolation, and current Linear candidates.

`doctor --live-runtime` is the opt-in live Hermes gateway readiness check. It materializes worker and reviewer profiles, writes Symphony MCP config, starts the stdio gateway, creates a session, calls `tools.list`, verifies the required Symphony MCP tools, closes the session, and redacts gateway logs. `npm run smoke:hermes-local` then uses a temp workspace/state area, starts the real `HermesHarness`, verifies MCP exposure, sends a short prompt, and persists a sanitized MCP exposure report under the configured workflow state directory. `npm run smoke:hermes-acp` is a separate opt-in live host ACP check; it is not part of default unit tests and should only be run when host Hermes ACP credentials are available. When you run it in this preflight block against `WORKFLOW.md`, treat it only as a prerequisite smoke for host Hermes setup. Final dogfood-unblock evidence must rerun the smoke against `WORKFLOW.hermes-acp.md` in the ACP checklist below so `configuredHarness: "hermes_acp"` is recorded.

### ACP final live validation checklist

Before removing `dogfood-blocked` from Hermes ACP dogfood issues, record the following evidence in the operator notes or issue comments:

Keep ACP opt-in by running the live issue validation from a disposable workflow copy instead of editing the checked-in default:

```powershell
Copy-Item WORKFLOW.md WORKFLOW.hermes-acp.md
# In WORKFLOW.hermes-acp.md change only:
# agent:
#   harness: hermes_acp
# Optionally pin the validated host profile in the workflow copy:
# hermes_acp:
#   source_profile: <host-profile>
npm run dev -- --port 7331 WORKFLOW.hermes-acp.md
```

Use the normal `WORKFLOW.md` again after ACP validation and delete `WORKFLOW.hermes-acp.md` so the default checked-in `agent.harness: hermes` path remains unchanged.

For the ACP smoke evidence below, run the smoke against that disposable workflow copy so the recorded `configuredHarness` value comes from `WORKFLOW.hermes-acp.md` rather than the checked-in default:

```powershell
npm run smoke:hermes-acp -- WORKFLOW.hermes-acp.md --source-profile <host-profile>
```

For the live-run items below, collect issue/run evidence with:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:7331/api/v1/state"
Invoke-RestMethod -Uri "http://127.0.0.1:7331/api/v1/issues/ENG-123"
Invoke-RestMethod -Uri "http://127.0.0.1:7331/api/v1/issues/ENG-123/runs"
Invoke-RestMethod -Uri "http://127.0.0.1:7331/api/v1/runs/<runId>"
Invoke-RestMethod -Uri "http://127.0.0.1:7331/api/v1/runs/<runId>/transcript?offset=0&limit=200"
```

- `npm run typecheck`, `npm test`, `npm run doctor -- --strict`, `npm run doctor -- --strict --live-runtime`, and `npm run smoke:hermes-local` succeeded for the same checkout/host environment, and the live-runtime/local-smoke evidence still showed the required Symphony handoff MCP tools, so the default Hermes TUI path is still healthy before any ACP-only unblock decision.
- `hermes --version`, `hermes profile`, `hermes acp --check`, and `hermes -p <source> acp --check` succeeded for the intended host source profile.
- `npm run smoke:hermes-acp -- WORKFLOW.hermes-acp.md --source-profile <host-profile>` succeeded, verified the disposable cloned profile, and its success JSON recorded `configuredHarness: "hermes_acp"`, `hostHermesBinary`, `sourceProfile`, `disposableProfile`, `disposableProfileDeleted: true`, `activeProfileUnchanged: true`, `promptExpectedText`, matching `promptResponseText`, a normal `promptStopReason`, and the ACP `promptSessionId` unless an operator intentionally retained the disposable profile for troubleshooting.
- One tiny unprotected issue then ran from `WORKFLOW.hermes-acp.md` in the same host environment. Choose or author the issue so it requires one safe repository edit and one targeted validation command, which forces an ACP permission request on a bounded surface. Passing handoff evidence is `/api/v1/issues/<issue-identifier>` showing `reviewLoop.phase: "review"` and `reviewLoop.lastCompletionReport.runId`, `/api/v1/runs/<handoffWorkerRunId>` showing `status: "succeeded"` and `terminalReason: "succeeded"`, and `/api/v1/runs/<handoffWorkerRunId>/transcript` showing a `tool_call_completed` entry whose payload `toolName` or public tool preview names `submit_completion_report`.
- Deliberately exercise both deny and allow on the first safe ACP permission request from that tiny issue. First deny the request; passing evidence is `/api/v1/runs/<runId>/transcript` showing `command_policy_decision` with payload fields such as `outcome: "deny"`, `surface`/`requestKind`, and `permissionOutcome`. Then rerun the same issue and allow the equivalent safe request; passing evidence is a later `command_policy_decision` for the same surface with `outcome: "allow"`, `permissionOutcome: "allowed"`, and a recorded `selectedOptionId`, plus the successful completion-report handoff evidence from the previous bullet.
- Start a separate intentionally cancelled `agent.harness: hermes_acp` run after the worker is active in `operatorView.running`, then fetch `/api/v1/issues/<issue-identifier>` and use the returned internal `id` value in the cancel route:

  ```powershell
  Invoke-RestMethod -Method Post -Headers @{ "X-Symphony-Token" = $env:SYMPHONY_WORKSPACE_TOKEN } -Uri "http://127.0.0.1:7331/api/v1/issues/<issueId>/cancel"
  ```

  Passing cancellation evidence is `/api/v1/state` showing `operatorView.running[].liveness.status: "cancelling"` before terminal resolution, `/api/v1/runs/<runId>` ending with `status: "cancelled"` and `terminalReason: "cancelled"`, and `/api/v1/runs/<runId>/transcript` containing the terminal `cancelled` event instead of a completion-report handoff.

- The active host profile before and after the ACP smoke/issue runs matched; the source profile was not renamed, selected, deleted, or used directly as the disposable run profile, and any retained session/profile artifacts belonged to the disposable clone rather than the source profile.

- No retained disposable profile with the configured `hermes_acp.profile_prefix` (or the operator-selected `--profile-prefix`/`--profile-name`) remains unless an operator intentionally used `--keep-profile` for troubleshooting and tracked the cleanup.
- Default validation remains non-ACP unless the operator explicitly runs this ACP evidence set; failing host ACP setup should keep the affected issue `dogfood-blocked`, not break default unit tests.

Only unblock `dogfood-blocked` after the checklist passes for the same host environment that will run the dogfood worker. If any item fails, leave the issue blocked, fix the host Hermes installation/auth/profile setup, and rerun the ACP evidence steps before promotion.

When you record the unblock evidence, link the operator note back to [`hermes-acp-integration-spec.md#validation-plan`](./hermes-acp-integration-spec.md#validation-plan) and note which Linear ACP follow-up it satisfies (`ENG-136`, `ENG-143`, or `ENG-143C`) so the spec, runbook, and implementation history stay connected.

## 5. Promotion Policy

Promote through `Backlog -> Todo`. Do not move issues directly to `In Progress` for dispatch, because `Todo` preserves blocker checks.

Before promotion, verify:

- The issue has the required agent-eligible authoring sections from [`agent-eligible-issue-template.md`](./agent-eligible-issue-template.md): `Problem / Goal`, `Issue Contract`, `Touched Surfaces`, `Acceptance Criteria`, `Contract Checklist`, `Validation Requirements`, `Out Of Scope`, and `Promotion Readiness`.
- The issue has the required fenced JSON issue contract in `Issue Contract`,
  with `schemaVersion`, `contractVersion`, and at least one `requirements`
  entry whose `id` is stable and unique and whose `requirement` text is
  non-empty.
- The issue has a concrete validation plan in `Validation Requirements`, not only generic "add tests" language.
- The `Contract Checklist` covers the relevant happy path, negative/error path, sibling surfaces, stale/fallback states, replay/idempotency, credential boundary, and side-effect verification cases.
- The issue has no open blockers.
- The issue is assigned according to the workflow route.
- The issue has `dogfood-ready` only after an operator reviewed the required
  sections, fenced JSON issue contract, contract checklist, and validation plan.
- `dogfood-blocked` has been removed only after the required issue contract is complete and, when the issue depends on `hermes_acp`, after the ACP final live validation checklist passes.
- The issue does not have `dogfood-blocked` or `safety-blocked`.
- The issue does not touch protected paths unless a human is implementing it manually.
- The issue is not a continuation search or richer summarization placeholder that should remain `Backlog` with `dogfood-blocked`.

Gate issues such as orchestrator, config, workflow, Linear integration, runtime harnesses, and dogfood safety docs remain human-implemented until the smoke checkpoint passes.

## 6. Hermes Smoke Issue

Create or choose one tiny, unprotected Linear issue with `dogfood-ready`, then promote it through `Backlog -> Todo`.

Expected result:

- Symphony dispatches exactly one worker.
- A git worktree is created.
- The run transcript is persisted.
- The worker calls `submit_completion_report` with summary, validation
  evidence, acceptance checklist, changed files, branch/PR details, risks, an
  idempotency key, and the structured requirements proof block when
  proof-gated completion is enabled.
- The worker does not run `git commit`, `git push`, or create/update GitHub PRs directly; implementation changes remain in the assigned worktree for service-owned publication.
- Symphony publishes or reuses the lifecycle-bound pull request and moves the issue directly to `In Review` because `github.pr_handoff.enabled` is false.
- The reviewer records a pass verdict for the tiny smoke.
- Symphony applies the configured `Ready to Merge` pass destination.
- A human reviews and merges manually.
- The workspace remains available for review-loop evidence and operator inspection until the pass path is complete.

For review-loop proof, promote one small real issue after the smoke issue. If the reviewer naturally fails it, verify the fail/revise/pass path. If not, keep single-issue dogfood until a real reviewer fail exercises the repair loop.

## 7. Manual Dogfood Checklist

Before the smoke:

- `npm run doctor -- --strict` has no errors and only understood warnings.
- `npm run doctor -- --strict --live-runtime` succeeds.
- `npm run smoke:hermes-local` succeeds.
- There are zero current `Todo` or `In Progress` candidates before intentional promotion.
- The target issue is the only issue with `dogfood-ready` and no `dogfood-blocked` or `safety-blocked` label.
- `Ready to Merge` exists in Linear and is not listed as an active, review, blocked, or terminal state.
- `Blocked` exists in Linear and is not listed as an active or review state.
- `In Review` is understood as the agent review queue; no `Human Review` handoff is active while `github.pr_handoff.enabled` is false.

During the smoke:

- No issue becomes a worker candidate until an operator intentionally moves it to `Todo` with the required label.
- No issue enters `In Review` until the lifecycle record has an accepted worker completion report and any configured PR publication step has completed.
- Worker implementation and merge-gate repair prompts instruct workers to submit completion reports instead of committing, pushing, or mutating lifecycle-bound PRs directly.
- No reviewer dispatch occurs without a last completion report.
- A fail verdict returns the issue to `In Progress`, increments the review round, and includes a revision-request comment.
- A pass verdict is recorded before the configured pass destination is applied.
- A blocked escalation comments with the reason, counters, last report, last verdict, and required human action.

After the smoke:

- Inspect `/api/v1/issues/<issue>` and confirm `reviewLoop.phase`, `role`, `reviewRound`, `incompleteTurnCount`, `lastCompletionReport`, `lastReviewVerdict`, and `blockedReason` match the observed loop.
- Identify the handoff worker run from `reviewLoop.lastCompletionReport.runId`, or from the matching `role: "worker"` entry in `/api/v1/issues/<issue>/runs` when correlating multiple worker runs. Do not use `latestRun` alone for post-handoff interpretation; after reviewer dispatch, `latestRun` may be a reviewer run while `lastCompletionReport` still describes the worker handoff.
- Inspect `/api/v1/runs/<handoffWorkerRunId>`. In the post-handoff context where `reviewLoop.lastCompletionReport` points at that worker run and `reviewLoop.phase` is `review`, `status: "succeeded"` means Symphony reconciled the accepted handoff. A succeeded worker run without a matching completion report is an incomplete turn, not a successful handoff.
- Inspect `/api/v1/runs/<handoffWorkerRunId>/transcript` when the SDK tail looks suspicious. Raw harness `failed` or `cancelled` events may appear after an accepted report even though the handoff worker run status is `succeeded`; a throw path may leave no terminal harness event. Treat lifecycle and the report-linked worker run record as authoritative for handoff outcome.
- Confirm no unrelated issue acquired `dogfood-ready`, entered `Todo`/`In Progress`, or received a Symphony worker run.

## 8. Recovery

Use the status API with `X-Symphony-Token` when a token is configured. Resolve the internal issue `id` from `/api/v1/issues/<issue-identifier>` first, then use that `id` in the mutation routes:

```powershell
$issue = Invoke-RestMethod -Uri "http://127.0.0.1:7331/api/v1/issues/ENG-123"
$issueId = $issue.id
Invoke-RestMethod -Method Post -Headers @{ "X-Symphony-Token" = $env:SYMPHONY_WORKSPACE_TOKEN } -Uri "http://127.0.0.1:7331/api/v1/issues/$issueId/pause"
Invoke-RestMethod -Method Post -Headers @{ "X-Symphony-Token" = $env:SYMPHONY_WORKSPACE_TOKEN } -Uri "http://127.0.0.1:7331/api/v1/issues/$issueId/cancel"
Invoke-RestMethod -Method Post -Headers @{ "X-Symphony-Token" = $env:SYMPHONY_WORKSPACE_TOKEN } -Uri "http://127.0.0.1:7331/api/v1/issues/$issueId/resume"
```

If the process must stop, use Ctrl+C and inspect worktrees before cleanup.

## 9. After Smoke

Promote one unblocked, allowlisted issue at a time. Keep `max_concurrent_agents: 1` until repeated runs are boring.
