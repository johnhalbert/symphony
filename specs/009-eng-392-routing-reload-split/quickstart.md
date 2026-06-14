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