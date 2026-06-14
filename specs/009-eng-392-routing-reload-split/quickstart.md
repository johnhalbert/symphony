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

## Current `tests/orchestrator.test.ts` coverage inventory

### Routing and route-selection coverage already present

- `tests/orchestrator.test.ts:1229` — `reroutes implementation dispatch to planning when writeback reveals stale issue content` proves stale post-writeback issue content reroutes back into planning instead of continuing to implementation.
- `tests/orchestrator.test.ts:1309` — `routes worker dispatch to planning when only a superseded plan matches the issue` proves superseded planning artifacts route back to planning.
- `tests/orchestrator.test.ts:1359` — `queues explicit issue breakdown planning when the only matching plan is superseded` covers the explicit-request variant of the superseded-plan reroute.
- `tests/orchestrator.test.ts:1416` — `fails closed for direct issue-breakdown lookups when the direct tracker hit resolves outside the requested project context` covers wrong-project-context route rejection.
- `tests/orchestrator.test.ts:1493` — `redacts orchestrator route evidence when issue breakdown tracker credentials are unavailable` covers routing evidence redaction on tracker-credential failure.
- `tests/orchestrator.test.ts:1977` — `does not route planning-labeled issues to implementation when planning persistence is missing` blocks misrouting into implementation when planning persistence is unavailable.
- `tests/orchestrator.test.ts:2119`, `tests/orchestrator.test.ts:2152`, `tests/orchestrator.test.ts:2185`, and `tests/orchestrator.test.ts:2218` — `revalidates issue state before dispatch`, `skips issues no longer routed to this worker`, `skips issues with refreshed open blockers`, and `skips issues without required dispatch labels` cover pre-dispatch route revalidation and dispatch exclusion.
- `tests/orchestrator.test.ts:2350` — `propagates non-default project context through dispatch harness, run records, and lifecycle state` proves routed project-context propagation into dispatch/run/lifecycle artifacts.
- `tests/orchestrator.test.ts:2420` and `tests/orchestrator.test.ts:2479` — `dispatches legacy single-project workflows as the synthesized default context` and `rehydrates stale legacy-default lifecycle records on dispatch recovery` cover default-context routing and recovery rehydration.
- `tests/orchestrator.test.ts:5216`, `tests/orchestrator.test.ts:5555`, `tests/orchestrator.test.ts:5589`, and `tests/orchestrator.test.ts:5627` — `dispatches reviewer runs from resolved project-context review states with reviewer evidence`, `does not treat review-state issues as worker candidates`, `does not dispatch worker runs for blocked states even when they are active states`, and `does not dispatch reviewers for blocked review issues` cover reviewer-lane routing plus worker/reviewer exclusion rules.

### Reload, restart, and redispatch-adjacent coverage already present

- `tests/orchestrator.test.ts:1852` — `honors durable planning backoff after a non-submitting planning run` proves persisted planning retry/backoff survives orchestrator restart.
- `tests/orchestrator.test.ts:2960` — `does not redispatch persisted fallback-blocked issues after restart` proves blocked lifecycle state remains non-dispatched after restart.
- `tests/orchestrator.test.ts:3009` and `tests/orchestrator.test.ts:3053` — `does not redispatch issues with %s pending publication approval before Linear reaches Blocked` and `does not stall-cancel lifecycle-only pending publication approval handoffs` cover pending-approval non-redispatch and non-cancellation behavior.
- `tests/orchestrator.test.ts:3780`, `tests/orchestrator.test.ts:3829`, and `tests/orchestrator.test.ts:5672` — `clears blocked lifecycle counters after a human unblock transition`, `reapplies Todo dispatch transitions after a prior dispatch writeback already succeeded`, and `pauses and resumes issue dispatch` cover explicit resume/unblock behavior after blocked or paused states.

### Approval recovery coverage already present

- `tests/orchestrator.test.ts:3284`, `tests/orchestrator.test.ts:3381`, and `tests/orchestrator.test.ts:3459` — `skips recovery for an already linked pending publication approval wait`, `leaves missing_run pending publication approval recovery untouched during orchestrator ticks`, and `leaves audit_not_settled pending publication approval recovery unfinalized during orchestrator ticks` cover negative and edge approval-recovery paths.
- `tests/orchestrator.test.ts:3548` and `tests/orchestrator.test.ts:3675` — `recovers a pre-approved publication approval handoff during an orchestrator tick` and `recovers a terminal publication approval handoff during an orchestrator tick` cover happy-path and terminal approval recovery during ticks.
- `tests/orchestrator.test.ts:4370` and `tests/orchestrator.test.ts:4472` — `preserves fail-policy approval rejection through abnormal worker exit` and `preserves cancel-policy approval rejection through cancelled worker exit` cover rejection persistence across abnormal/cancelled exits.
- `tests/orchestrator.test.ts:4580`, `tests/orchestrator.test.ts:4679`, `tests/orchestrator.test.ts:4744`, `tests/orchestrator.test.ts:4857`, and `tests/orchestrator.test.ts:5002` — `resumes approved publication through the orchestrator after the worker exits`, `records terminal publication approval recovery through the orchestrator when an approval is replayed after worker exit`, `resumes approved publication with project-context GitHub publication credentials`, `recovers approved publication with project-context GitHub publication credentials after worker exit`, and `records terminal publication approval recovery through the orchestrator when approval is %s after worker exit` cover after-worker-exit resume/replay, project-context credential preservation, and terminal approval replay variants.

### Coverage gaps to carry into later child contracts

- No single existing test proves two different Linear project contexts route to distinct workspace/state buckets in one scenario. `tests/orchestrator.test.ts:2350` proves non-default context propagation for one routed issue, but not cross-project isolation between two simultaneously relevant routes.
- No existing test explicitly proves an already-running routed worker or reviewer context survives a config reload with the same workspace/prompt/context identity. Current restart-adjacent coverage proves backoff persistence, recovery rehydration, or blocked-state suppression rather than in-progress reload preservation.
- No explicit reviewer redispatch-after-reload or restart scenario appears for a routed review issue.
- No explicit worker retry redispatch-after-reload or restart scenario appears for routed project-context implementation work.
- Approval recovery is broad, but no focused scenario combines pending approval recovery with config reload/restart plus routed project-context preservation and redispatch suppression in one test.

## Recording hygiene

- Keep follow-up notes limited to public URLs and repo-relative paths.
- Do not paste secrets, credentials, raw environment values, or local absolute filesystem paths.
- When citing the blocked-state validation history, prefer the exact command strings already quoted in the review comments.