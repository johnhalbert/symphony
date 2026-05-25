# Symphony Dogfood Runbook

This runbook describes how to move the Engineering Linear backlog from planning into a controlled Symphony dogfood run.

## 1. Keep The Backlog Frozen

Keep `ENG-*` child issues in `Backlog` until their blockers clear and an operator intentionally promotes them.

All child issues in this epic remain `Backlog` with `dogfood-blocked` until manually promoted. Remove `dogfood-blocked` and add `dogfood-ready` only as part of an intentional operator promotion.

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

## 3. Baseline Checks

Run:

```powershell
npm test
npm run typecheck
npm run smoke:sdk-local
```

`npm run smoke:sdk-local` requires `CURSOR_API_KEY`.

## 4. Doctor

Run:

```powershell
$env:LINEAR_PROJECT_SLUG = "symphony-6cf4dcc723df"
$env:LINEAR_ASSIGNEE = "me"
npm run doctor
```

Set `LINEAR_API_KEY`, `CURSOR_API_KEY`, and `SYMPHONY_OPEN_WORKSPACE_TOKEN` as needed.

Doctor verifies workflow parsing, writable workspace paths, git availability, Cursor baseline model configuration, review-loop state configuration, actual Linear availability of `In Review`, `Blocked`, and `Ready to Merge` when Linear access is available, completion-report/review-verdict MCP tool availability, candidate isolation, and current Linear candidates.

Doctor also warns when `continuation_context.search_enabled` or `continuation_context.summarization_enabled` is enabled while those capabilities remain roadmap placeholders. The warning is intentional and does not imply Symphony can search, summarize, poll, or dispatch placeholder work.

## 5. Promotion Policy

Promote through `Backlog -> Todo`. Do not move issues directly to `In Progress` for dispatch, because `Todo` preserves blocker checks.

Before promotion, verify:

- The issue has no open blockers.
- The issue is assigned according to the workflow route.
- The issue has `dogfood-ready`.
- The issue does not have `dogfood-blocked` or `safety-blocked`.
- The issue does not touch protected paths unless a human is implementing it manually.
- The issue is not a continuation search or richer summarization placeholder that should remain `Backlog` with `dogfood-blocked`.

Gate issues such as orchestrator, config, workflow, Linear integration, and dogfood safety docs remain human-implemented until the smoke checkpoint passes.

## 6. Review-Loop Smoke

For `ENG-5`, promote one intentionally safe issue through `Backlog -> Todo`.

Expected result:

- Symphony dispatches exactly one worker.
- A git worktree is created.
- The run transcript is persisted.
- The worker calls `submit_completion_report` with summary, validation evidence, acceptance checklist, changed files, branch/PR details, risks, and an idempotency key.
- The issue reaches `Human Review` through service-owned PR handoff after the completion report and configured checks are accepted. Handoff checks are evaluated when the completion report is submitted; the worker MCP call does not poll or wait for newly queued CI checks.
- A human operator moves the issue from `Human Review` to `In Review` when reviewer-agent review should start.
- The reviewer records a fail verdict with concrete requested revisions.
- Symphony transitions the issue back to `In Progress` and the next worker turn addresses the requested revisions.
- The worker submits a new completion report before any second handoff.
- The reviewer records a pass verdict.
- Symphony applies the configured `Ready to Merge` pass destination.
- The workspace remains available for review-loop evidence and operator inspection until the pass path is complete.

## 7. Manual Dogfood Checklist

Before the smoke:

- [ ] `npm run doctor -- --strict` has no errors and only understood warnings.
- [ ] There are zero current `Todo` or `In Progress` candidates before intentional promotion.
- [ ] The target issue is the only issue with `dogfood-ready` and no `dogfood-blocked` or `safety-blocked` label.
- [ ] `Ready to Merge` exists in Linear and is not listed as an active, review, blocked, or terminal state.
- [ ] `Blocked` exists in Linear and is not listed as an active or review state.
- [ ] `Human Review` is understood as the PR handoff state; `In Review` is understood as the agent review queue.

During the smoke:

- [ ] No issue becomes a worker candidate until an operator intentionally moves it to `Todo` with the required label.
- [ ] No issue enters `Human Review` through Symphony writeback until the lifecycle record has a last completion report and verified PR.
- [ ] No issue enters `In Review` until a human operator promotes it from `Human Review`.
- [ ] No reviewer dispatch occurs without a last completion report.
- [ ] A fail verdict returns the issue to `In Progress`, increments the review round, and includes a revision-request comment.
- [ ] A pass verdict is recorded before the configured pass destination is applied.
- [ ] A blocked escalation comments with the reason, counters, last report, last verdict, and required human action.

After the smoke:

- [ ] Inspect `/api/v1/issues/<issue>` and confirm `reviewLoop.phase`, `role`, `reviewRound`, `incompleteTurnCount`, `lastCompletionReport`, `lastReviewVerdict`, and `blockedReason` match the observed loop.
- [ ] Identify the handoff worker run from `reviewLoop.lastCompletionReport.runId`, or from the matching `role: "worker"` entry in `/api/v1/issues/<issue>/runs` when correlating multiple worker runs. Do not use `latestRun` alone for post-handoff interpretation; after reviewer dispatch, `latestRun` may be a reviewer run while `lastCompletionReport` still describes the worker handoff.
- [ ] Inspect `/api/v1/runs/<handoffWorkerRunId>`. In the post-handoff context where `reviewLoop.lastCompletionReport` points at that worker run and `reviewLoop.phase` is `review`, `status: "succeeded"` means Symphony reconciled the accepted handoff. A succeeded worker run without a matching completion report is an incomplete turn, not a successful handoff.
- [ ] Inspect `/api/v1/runs/<handoffWorkerRunId>/transcript` when the SDK tail looks suspicious. Raw harness `failed` or `cancelled` events may appear after an accepted report even though the handoff worker run status is `succeeded`; a throw path may leave no terminal harness event. Treat lifecycle and the report-linked worker run record as authoritative for handoff outcome.
- [ ] Confirm no unrelated issue acquired `dogfood-ready`, entered `Todo`/`In Progress`, or received a Symphony worker run.

## 8. Recovery

Use the status API with `X-Symphony-Token` when a token is configured:

```powershell
Invoke-RestMethod -Method Post -Headers @{ "X-Symphony-Token" = $env:SYMPHONY_OPEN_WORKSPACE_TOKEN } -Uri "http://127.0.0.1:7331/api/v1/issues/ENG-123/pause"
Invoke-RestMethod -Method Post -Headers @{ "X-Symphony-Token" = $env:SYMPHONY_OPEN_WORKSPACE_TOKEN } -Uri "http://127.0.0.1:7331/api/v1/issues/ENG-123/cancel"
Invoke-RestMethod -Method Post -Headers @{ "X-Symphony-Token" = $env:SYMPHONY_OPEN_WORKSPACE_TOKEN } -Uri "http://127.0.0.1:7331/api/v1/issues/ENG-123/resume"
```

If the process must stop, use Ctrl+C and inspect worktrees before cleanup.

## 9. After Smoke

Promote one unblocked, allowlisted issue at a time. Keep `max_concurrent_agents: 1` until repeated runs are boring.
