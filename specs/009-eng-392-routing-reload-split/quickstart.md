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
- Merge-base used for the reproducible local diff summary: `3839c28462010e2a14520f2853aa83e15873fc6f` from `git merge-base origin/main origin/sinfonista/eng-392-t037-add-orchestrator-routing-and-config-reload-preservation`
- `git diff --name-status 3839c28462010e2a14520f2853aa83e15873fc6f..origin/sinfonista/eng-392-t037-add-orchestrator-routing-and-config-reload-preservation` captured the widened surface:

  ```text
  M	cursor/src/CursorWorkspaceOpener.ts
  A	src/app/ProjectContextRuntime.ts
  M	src/cli.ts
  M	src/core/CompletionReportService.ts
  M	src/core/approval/OperatorApprovalService.ts
  M	src/core/orchestrator/Orchestrator.ts
  M	src/core/workspace/WorkspaceManager.ts
  M	src/core/writeback/WritebackOutbox.ts
  M	tests/cursor-workspace-opener.test.ts
  M	tests/orchestrator.test.ts
  M	tests/status-api.test.ts
  ```

- `git diff --stat 3839c28462010e2a14520f2853aa83e15873fc6f..origin/sinfonista/eng-392-t037-add-orchestrator-routing-and-config-reload-preservation` shows how far the branch exceeded the original tests-only contract:

  ```text
   cursor/src/CursorWorkspaceOpener.ts          |   35 +-
   src/app/ProjectContextRuntime.ts             |  967 ++++++++++++++++++
   src/cli.ts                                   |   23 +-
   src/core/CompletionReportService.ts          |    4 +
   src/core/approval/OperatorApprovalService.ts |   16 +-
   src/core/orchestrator/Orchestrator.ts        |  686 +++++++++----
   src/core/workspace/WorkspaceManager.ts       |    8 +
   src/core/writeback/WritebackOutbox.ts        |   12 +
   tests/cursor-workspace-opener.test.ts        |   17 +
   tests/orchestrator.test.ts                   | 1406 +++++++++++++++++++++++++-
   tests/status-api.test.ts                     |  159 ++-
   11 files changed, 3084 insertions(+), 249 deletions(-)
  ```

- Contract-to-surface mismatch summary: `REQ-T037` named `tests/orchestrator.test.ts` as the review surface, but the merge-base diff shows 10 additional out-of-contract paths: `cursor/src/CursorWorkspaceOpener.ts`, `src/app/ProjectContextRuntime.ts`, `src/cli.ts`, `src/core/CompletionReportService.ts`, `src/core/approval/OperatorApprovalService.ts`, `src/core/orchestrator/Orchestrator.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/core/writeback/WritebackOutbox.ts`, `tests/cursor-workspace-opener.test.ts`, and `tests/status-api.test.ts`. The biggest expansions were the new `src/app/ProjectContextRuntime.ts` surface and the large `src/core/orchestrator/Orchestrator.ts` runtime edit, which confirms the proof depended on coupled runtime changes rather than a test-only publication.

## Contract and blocked-state summary

- The mirrored ENG-392 issue contract is tests-only: `REQ-T037` requires adding orchestrator tests in `tests/orchestrator.test.ts` proving two Linear projects route to distinct workspaces/state buckets and that in-progress contexts survive config reload.
- PR #286 is still blocked at review time: `gh pr view 286` reports `reviewDecision: CHANGES_REQUESTED` and `mergeStateStatus: DIRTY`.
- The review history shows the branch first blocked on incomplete routing/reload proof and deterministic validation gaps, then on a deeper contract/publication mismatch once the coupled runtime paths became clear.

## Contract/publication mismatch sources

| Source | Evidence note |
| --- | --- |
| `REQ-T037` in the mirrored linkback comment | Contract scope is tests-only and points at `tests/orchestrator.test.ts` as the expected review surface. |
| PR #286 changed surface | The merge-base diff evidence above (`git diff --name-status` / `git diff --stat` against `3839c28462010e2a14520f2853aa83e15873fc6f..origin/sinfonista/eng-392-t037-add-orchestrator-routing-and-config-reload-preservation`) shows the published branch touched `tests/orchestrator.test.ts` plus 10 additional runtime/CLI/workspace/writeback/status paths: `cursor/src/CursorWorkspaceOpener.ts`, `src/app/ProjectContextRuntime.ts`, `src/cli.ts`, `src/core/CompletionReportService.ts`, `src/core/approval/OperatorApprovalService.ts`, `src/core/orchestrator/Orchestrator.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/core/writeback/WritebackOutbox.ts`, `tests/cursor-workspace-opener.test.ts`, and `tests/status-api.test.ts`. |
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

## Current `tests/orchestrator.test.ts` coverage inventory

### Routing and route-selection coverage already present

- `tests/orchestrator.test.ts:978` — `uses resolved project-context issue breakdown planning config during automatic polling` proves automatic polling resolves the non-default project context before planning dispatch, applies the project-context planning labels/prompt/run mode, and persists the routed project context on lifecycle state.
- `tests/orchestrator.test.ts:1043` — `uses resolved project-context fresh-plan and apply-to-linear config during automatic polling` proves automatic polling carries project-context planning and apply-to-linear configuration through planning-to-implementation routing, with docs-context run records and lifecycle persistence.
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

- `tests/orchestrator.test.ts:3136` — `recovers a real post-exit pending publication approval handoff after partial audit failure: $name` is the core post-exit pending-approval recovery suite. It proves recovery re-establishes the pending approval request, preserves the single run record, emits one approval-request transcript event, and finishes the pending approval audit operations after the initial partial failure.
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

## Local validation quickstart

Run these commands from the repository root in PowerShell. They stay inside the checkout and avoid live Linear or GitHub writeback by default.

### PowerShell setup

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Quickstart = '.\specs\009-eng-392-routing-reload-split\quickstart.md'
$ChildContracts = '.\specs\009-eng-392-routing-reload-split\contracts\child-issue-contracts.md'
$SurfaceGate = '.\specs\009-eng-392-routing-reload-split\contracts\publication-surface-gate.md'
$ValidationGuide = '.\specs\009-eng-392-routing-reload-split\contracts\validation-evidence.md'

Test-Path $Quickstart
Test-Path $ChildContracts
Test-Path $SurfaceGate
Test-Path $ValidationGuide
```

All four `Test-Path` checks should print `True` before you rely on the rest of this packet.

### 1. Issue-contract lint

```powershell
npm test -- tests/issue-contract-lint.test.ts
```

Expected evidence to record:

- exit code `0`
- a passing `tests/issue-contract-lint.test.ts` run
- the child examples in `$ChildContracts` still satisfy the required headings, fenced JSON `Issue Contract` blocks, and stable requirement IDs

### 2. Orchestrator validation sweeps

Run the focused local test sweeps that back the runtime-routing, reload-preservation, approval-writeback, and focused-proof child families:

```powershell
npm test -- tests/orchestrator.test.ts tests/status-api.test.ts tests/cursor-workspace-opener.test.ts
npm test -- tests/orchestrator.test.ts tests/status-api.test.ts
npm test -- tests/orchestrator.test.ts tests/completion-report-service.test.ts tests/operator-approval-service.test.ts tests/approval-status-api.test.ts tests/status-api.test.ts
npm test -- tests/orchestrator.test.ts
```

Expected evidence to record:

- all four commands exit `0`
- the passing output covers `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, `REQ-392-APPROVAL-WRITEBACK`, and `REQ-392-TEST-PROOF`
- review notes cite the matching suites directly instead of inferring success from coupled runtime edits alone

### 3. Diff-surface checks

```powershell
git diff --name-only origin/main...HEAD
git status --short -- 'tmp-debug-*'
git diff --name-only origin/main...HEAD -- 'hermes/upstream-src'
git status --short -- 'hermes/upstream-src'
```

Expected evidence to record:

- `git diff --name-only origin/main...HEAD` lists only repo-relative surfaces authorized by the active child contract
- `git status --short -- 'tmp-debug-*'` returns no debug-capture paths
- both `hermes/upstream-src` checks return no paths, proving vendored Hermes source stayed untouched
- reviewers can map any remaining spec-doc changes back to `$Quickstart`, `$ChildContracts`, or another explicitly authorized surface

### 4. Redaction check

Use a bounded repo-local scan against the candidate evidence docs you plan to cite. Keep the validation guide itself out of the scan because it intentionally contains example sensitive-pattern classes.

```powershell
$DocsToScan = @(
  $ChildContracts,
  $SurfaceGate,
  '.\specs\009-eng-392-routing-reload-split\review-notes.md'
) | Where-Object { Test-Path $_ }

$Patterns = [ordered]@{
  github_token   = 'gh[pousr]_[A-Za-z0-9]{20,}'
  github_pat     = 'github_pat_[A-Za-z0-9_]{20,}'
  openai_key     = 'sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}'
  private_key    = '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  credential_url = 'https?://[^\s:@/]+:[^\s@/]+@'
  local_path     = '(?:[A-Za-z]:[\\/]+Users[\\/]+|/Users/|/home/)'
}

$Findings = foreach ($Pattern in $Patterns.GetEnumerator()) {
  foreach ($Hit in Select-String -Path $DocsToScan -Pattern $Pattern.Value -AllMatches) {
    [pscustomobject]@{
      pattern = $Pattern.Key
      path = (Resolve-Path -LiteralPath $Hit.Path -Relative)
      line = $Hit.LineNumber
    }
  }
}

[pscustomobject]@{
  surfacesChecked = $DocsToScan
  findings = @($Findings)
} | ConvertTo-Json -Depth 4
```

Expected evidence to record:

- `findings` is `[]`
- `surfacesChecked` lists only repo-local spec docs you actually plan to cite
- any finding blocks promotion until the doc or evidence packet is sanitized to remove the secret class or local absolute path

### 5. Review pass criteria

Before promoting a child issue or reviewer packet, confirm all of the following:

- the lint and orchestrator commands above match the child-family validation requirements in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- the diff checks stay aligned with `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`
- the evidence and redaction expectations stay aligned with `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- all cited proof stays repo-relative and public-safe, with no live publication or writeback side effects
