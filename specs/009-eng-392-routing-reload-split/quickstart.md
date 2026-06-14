# ENG-392 blocked-state evidence quickstart

This quickstart records the source links and concise blocked-state notes needed before decomposing ENG-392 / PR #286. The public evidence below comes from the ENG-392 Linear issue link mirrored into PR #286, the linked Linear review URL, and the GitHub PR review timeline that preserves the actionable review text.

## Source links

### Contract and issue source

- Linear issue: [ENG-392 T037 Add orchestrator routing and config-reload preservation tests](https://linear.app/john-halbert/issue/ENG-392/t037-add-orchestrator-routing-and-config-reload-preservation-tests)
- PR linkback comment mirroring the issue contract and review URL: [PR #286 issue comment](https://github.com/johnhalbert/symphony/pull/286#issuecomment-4678769297)
- Linear review URL exposed by the linkback comment: [ENG-392 review thread](https://linear.app/john-halbert/review/eng-392-t037-add-orchestrator-routing-and-config-reload-preservation-68cc104e4ffe)

### Blocked-state and review evidence

- PR state snapshot: [PR #286](https://github.com/johnhalbert/symphony/pull/286) (`reviewDecision: CHANGES_REQUESTED`, `mergeStateStatus: DIRTY` from `gh pr view 286`)
- Initial blocker review: [pullrequestreview-4475688154](https://github.com/johnhalbert/symphony/pull/286#pullrequestreview-4475688154)
- Deterministic focused-test blocker: [pullrequestreview-4476019459](https://github.com/johnhalbert/symphony/pull/286#pullrequestreview-4476019459)
- Runtime-path preservation blocker: [pullrequestreview-4476182461](https://github.com/johnhalbert/symphony/pull/286#pullrequestreview-4476182461)
- Scope + flaky sibling blocker: [pullrequestreview-4480831534](https://github.com/johnhalbert/symphony/pull/286#pullrequestreview-4480831534)
- Contract-surface blocker: [pullrequestreview-4482844820](https://github.com/johnhalbert/symphony/pull/286#pullrequestreview-4482844820)
- Final contradiction / decomposition blocker: [pullrequestreview-4483292693](https://github.com/johnhalbert/symphony/pull/286#pullrequestreview-4483292693)

### PR #286 surface notes

- PR overview: [#286 ENG-392: T037 Add orchestrator routing and config-reload preservation tests](https://github.com/johnhalbert/symphony/pull/286)
- Files changed: [PR #286 /files](https://github.com/johnhalbert/symphony/pull/286/files)
- Commits: [PR #286 /commits](https://github.com/johnhalbert/symphony/pull/286/commits)

## Contract and blocked-state summary

- The mirrored ENG-392 issue contract is tests-only: `REQ-T037` requires adding orchestrator tests in `tests/orchestrator.test.ts` proving two Linear projects route to distinct workspaces/state buckets and that in-progress contexts survive config reload.
- PR #286 is still blocked at review time: `gh pr view 286` reports `reviewDecision: CHANGES_REQUESTED` and `mergeStateStatus: DIRTY`.
- The review history shows the branch first blocked on incomplete routing/reload proof and deterministic validation gaps, then on a deeper contract/publication mismatch once the coupled runtime paths became clear.

## Contract/publication mismatch sources

| Source | Evidence note |
| --- | --- |
| `REQ-T037` in the mirrored linkback comment | Contract scope is tests-only and points at `tests/orchestrator.test.ts` as the expected review surface. |
| PR #286 changed surface | The published branch touched `tests/orchestrator.test.ts` plus 10 additional runtime/CLI/workspace/writeback/status paths: `cursor/src/CursorWorkspaceOpener.ts`, `src/app/ProjectContextRuntime.ts`, `src/cli.ts`, `src/core/CompletionReportService.ts`, `src/core/approval/OperatorApprovalService.ts`, `src/core/orchestrator/Orchestrator.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/core/writeback/WritebackOutbox.ts`, `tests/cursor-workspace-opener.test.ts`, and `tests/status-api.test.ts`. |
| Review `4480831534` | Reviewer reported affected-suite flakiness, called out the tests-only contract vs. broad runtime publication mismatch, and flagged orphaned `tmp-debug-docs-reviewer-redispatch-state/` captures as non-fixture debug state. |
| Review `4483292693` | Final blocked-state summary: the focused five-test sweep and full `tests/orchestrator.test.ts` run were green on the branch tip, but restoring the non-contract paths to the merge-base made the routing/reload tests stop passing. That proves the published test-only proof still depends on coupled runtime changes. |

## T004 protected publication surface inventory

Later child contracts should use the following family labels when explicitly authorizing edits to the protected mismatch surfaces:

- `routing-reload-core`: project-context resolution, routed issue/workspace lookup, reload-safe runtime state, and redispatch preservation.
- `publication-handoff`: completion-report acceptance, pending publication approval, pull-request discovery/publication, and approval terminalization/recovery.
- `writeback-guardrails`: durable writeback records, lifecycle-bound tracker mutation checks, and PR-handoff audit/writeback validity.
- `workspace-lifecycle`: workspace key/path/branch/base-ref derivation, workspace metadata persistence, and workspace root safety.
- `operator-http-entrypoints`: authenticated approval and open-workspace HTTP routes plus their route-evidence / recovery behavior.

| Path | Protected surface to classify explicitly | Child contract family that must authorize edits | Default exclusion unless a later contract says otherwise |
| --- | --- | --- | --- |
| `src/core/orchestrator/Orchestrator.ts` | `start()` writeback processing, `resumeApprovedPublication()`, `recordPublicationApprovalTerminal()`, `recoverPendingPublicationApprovalHandoffs()`, worker dispatch writeback gating in `tryDispatchWorkerIssue()`, `reconcileCompletionReportHandoff()`, and `discoverPullRequestForEntry()` | `publication-handoff` for approval/PR/writeback recovery changes; add `routing-reload-core` when the same edit changes routed issue/context preservation or redispatch behavior | Provider-gate handling, operator chat, merge-policy reconciliation, and unrelated reviewer/runtime plumbing stay excluded. |
| `src/core/CompletionReportService.ts` | `submitCompletionReport()`, `publishPullRequestIfNeeded()`, `requestPublicationApproval()`, `waitForServiceOwnedPublicationApproval()`, `buildPublicationInput()`, `processAndVerifyPendingPublicationApprovalWritebacks()`, and `enqueuePublicationApprovalTerminal()` | `publication-handoff`; add `writeback-guardrails` when pending/terminal audit operations or outbox settlement rules change | Generic completion-report parsing and unrelated non-publication lifecycle helpers stay excluded unless the child contract expands into completion-report semantics. |
| `src/core/writeback/WritebackOutbox.ts` | `WritebackOperation` records, `FileWritebackOutboxStore.enqueueOnce()/claimDue()`, `WritebackProcessor.processDue()`, `verifyLifecycleBoundOperation()`, and the PR-handoff detector `isPullRequestHandoffOperation()` | `writeback-guardrails`; add `publication-handoff` when the edit changes pull-request-handoff comments or completion-report audit writebacks | Issue-breakdown child creation / relation application rules remain separate and should not ride along under a publication-only contract. |
| `src/core/workspace/WorkspaceManager.ts` | `createForIssue()`, `createForPlanning()`, `removeForIssue()`, `removeForPlanning()`, `resolveBranchName()`, workspace metadata writes, and `assertPathInsideRoot()` / `assertRealPathInsideRoot()` | `workspace-lifecycle`; add `routing-reload-core` when the same change alters context-qualified workspace identity or reload reuse | Generic copy/git bootstrap behavior and hook scripts stay excluded unless a later contract explicitly covers workspace source/bootstrap semantics. |
| `src/app/http.ts` | `POST /api/v1/approval-requests/:id`, `requireApprovalMutationToken()`, `recordPublicationApprovalTerminalConflict()`, `recordRejectedApprovalRunTerminal()`, `POST /api/v1/issues/:id/open-workspace`, the routed workspace lookup feeding `workspaceOpener.open()`, and projection rebuild surfaces that expose writeback/approval state | `operator-http-entrypoints` as the base contract; pair it with `publication-handoff`, `workspace-lifecycle`, or `routing-reload-core` to match the underlying behavior being changed | Unrelated status, dashboard, transcript, and web-projection routes stay excluded. |
| `cursor/src/CursorWorkspaceOpener.ts` | `open()`, workspace-root/realpath validation, default opener selection, and detached Cursor launch | `workspace-lifecycle` | General editor UX or unrelated desktop integration stays excluded unless a later contract explicitly authorizes opener behavior beyond workspace-safety and routing. |

### Explicit exclusions from the original mismatch surface

Keep these adjacent PR #286 paths excluded unless a later child contract names them directly:

- `src/app/ProjectContextRuntime.ts`
- `src/cli.ts`
- `src/core/approval/OperatorApprovalService.ts`
- `tests/orchestrator.test.ts`
- `tests/status-api.test.ts`
- `tests/cursor-workspace-opener.test.ts`
- Non-fixture debug capture directories such as `tmp-debug-docs-reviewer-redispatch-state/`

## Decomposition notes from the review trail

- The routing/reload tests and the shipped runtime behavior were coupled: reviewer feedback repeatedly traced gaps through routed workspace opening, prompt preservation across reload, worker retry redispatch, reviewer redispatch, and lifecycle-only pending-publication suppression.
- The branch eventually demonstrated working behavior only with the broader runtime surface present, which is why the final blocker shifted from implementation gaps to a scope mismatch between the ENG-392 contract and PR #286 publication surface.
- The review direction at the final blocker was to either:
  1. split or retarget PR #286 so `origin/main...HEAD` stays contract-scoped to `tests/orchestrator.test.ts`, or
  2. update the ENG-392 contract so the coupled runtime-routing surface is explicitly authorized and validated.

## Recording hygiene

- Keep follow-up notes limited to public URLs and repo-relative paths.
- Do not paste secrets, credentials, raw environment values, or local absolute filesystem paths.
- When citing the blocked-state validation history, prefer the exact command strings already quoted in the review comments.