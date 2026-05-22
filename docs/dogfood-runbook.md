# Symphony Dogfood Runbook

This runbook describes how to move the Engineering Linear backlog from planning into a controlled Symphony dogfood run.

## 1. Keep The Backlog Frozen

Keep `ENG-*` child issues in `Backlog` until their blockers clear and an operator intentionally promotes them.

All child issues in this epic remain `Backlog` with `dogfood-blocked` until manually promoted. Remove `dogfood-blocked` and add `dogfood-ready` only as part of an intentional operator promotion.

Do not run Symphony against the Engineering project before the gate work lands.

## 2. Verify The Linear Contract

Confirm:

- Project: `Symphony`
- Team: `Engineering`
- Key: `ENG`
- Parent: `ENG-29`
- Active states: `Todo`, `In Progress`
- Reviewer queue state: `In Review`
- Escalation state: `Blocked`
- Terminal states: `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`
- Required dispatch label: `dogfood-ready`
- Deny labels: `dogfood-blocked`, `safety-blocked`

Confirm there are zero issues in `Todo` or `In Progress` before connectivity smoke.

State semantics:

- `Todo` and `In Progress` are the worker implementation queue.
- `In Review` means awaiting independent reviewer-agent review, not human review.
- `Blocked` means human-required escalation, including max review loops or max incomplete worker turns.
- A passing review is recorded through structured reviewer verdict evidence, such as a Linear comment or PR review, while the issue remains `In Review`.
- Do not add a `Ready` or `Ready for Human` state for the current dogfood loop; after merge, Symphony transitions the issue to `Done`.

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

Doctor verifies workflow parsing, writable workspace paths, git availability, Cursor baseline model configuration, review-loop state configuration, `Blocked` availability, completion-report/review-verdict MCP tool availability, candidate isolation, and current Linear candidates.

## 5. Promotion Policy

Promote through `Backlog -> Todo`. Do not move issues directly to `In Progress` for dispatch, because `Todo` preserves blocker checks.

Before promotion, verify:

- The issue has no open blockers.
- The issue is assigned according to the workflow route.
- The issue has `dogfood-ready`.
- The issue does not have `dogfood-blocked` or `safety-blocked`.
- The issue does not touch protected paths unless a human is implementing it manually.

Gate issues such as orchestrator, config, workflow, Linear integration, and dogfood safety docs remain human-implemented until the smoke checkpoint passes.

## 6. Review-Loop Smoke

For `ENG-5`, promote one intentionally safe issue through `Backlog -> Todo`.

Expected result:

- Symphony dispatches exactly one worker.
- A git worktree is created.
- The run transcript is persisted.
- The worker calls `submit_completion_report` with summary, validation evidence, acceptance checklist, changed files, branch/PR details, risks, and an idempotency key.
- The issue reaches `In Review` through service-owned writeback for reviewer-agent review.
- The reviewer records a fail verdict with concrete requested revisions.
- Symphony transitions the issue back to `In Progress` and the next worker turn addresses the requested revisions.
- The worker submits a new completion report before any second handoff.
- The reviewer records a pass verdict.
- Symphony applies the configured pass destination, or records the structured pass marker when no pass state is configured.
- The workspace remains available for review-loop evidence and operator inspection until the pass path is complete.

## 7. Manual Dogfood Checklist

Before the smoke:

- [ ] `npm run doctor -- --strict` has no errors and only understood warnings.
- [ ] There are zero current `Todo` or `In Progress` candidates before intentional promotion.
- [ ] The target issue is the only issue with `dogfood-ready` and no `dogfood-blocked` or `safety-blocked` label.
- [ ] `Blocked` exists in Linear and is not listed as an active or review state.
- [ ] `In Review` is understood as the agent review queue, not human review.

During the smoke:

- [ ] No issue becomes a worker candidate until an operator intentionally moves it to `Todo` with the required label.
- [ ] No issue enters `In Review` until the lifecycle record has a last completion report.
- [ ] No reviewer dispatch occurs without a last completion report.
- [ ] A fail verdict returns the issue to `In Progress`, increments the review round, and includes a revision-request comment.
- [ ] A pass verdict is recorded before the configured pass destination is applied.
- [ ] A blocked escalation comments with the reason, counters, last report, last verdict, and required human action.

After the smoke:

- [ ] Inspect `/api/v1/issues/<issue>` and confirm `reviewLoop.phase`, `role`, `reviewRound`, `incompleteTurnCount`, `lastCompletionReport`, `lastReviewVerdict`, and `blockedReason` match the observed loop.
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
