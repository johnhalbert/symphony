# Research: ENG-392 decomposition service inventory

## Scope

T002 is a planning-only inspection pass over the current decomposition helpers in:

- `src/core/IssueBreakdownPlanService.ts`
- `src/core/IssueBreakdownPlanApplyService.ts`
- `src/core/IssueContractLint.ts`

The notes below summarize the current service responsibilities, where child-issue constraints are enforced, and which behaviors matter before decomposing ENG-392 into child issues.

## File-by-file inventory

### `src/core/IssueBreakdownPlanService.ts`

**Primary role**: accept and persist a worker-submitted issue breakdown plan for the parent issue.

Current responsibilities:

- Defines the accepted plan payload shape: `runId`, `issueId`, `summary`, `proposedIssues[]`, and `idempotencyKey`.
- Restricts submissions to the active `worker` run in the `issue_breakdown` phase and rejects mismatched `runId` / `issueId` values.
- Validates every proposed child issue before a plan is accepted:
  - labels must not include `dogfood-ready` or any configured worker-dispatch labels;
  - the child description must include every required issue-contract heading;
  - the child Issue Contract must parse as valid fenced JSON;
  - `Promotion Readiness` must explicitly declare `Ready for \`dogfood-ready\`: yes` or `no`;
  - protected touched surfaces require manual-only readiness plus a substantive operator/manual blocker.
- Computes three plan integrity values:
  - a config fingerprint,
  - an issue-content fingerprint,
  - a request hash for the submitted child payloads.
- Allows same-run idempotent replay only when the stored request hash matches the resubmitted payload; cross-run reuse of the same idempotency key is rejected.
- Persists the accepted plan into lifecycle state, records it as `lastIssueBreakdownPlanId`, creates a summary reference, and appends an `issue_breakdown_plan_accepted` transcript event.
- Exposes freshness helpers so downstream code only treats the latest plan as usable when:
  - it is still the lifecycle's `lastIssueBreakdownPlanId`,
  - it is not already marked `stale`,
  - its config fingerprint still matches,
  - its issue-content fingerprint still matches,
  - its proposed child issues still satisfy the current validation rules.

### `src/core/IssueBreakdownPlanApplyService.ts`

**Primary role**: preview or apply the latest fresh breakdown plan by turning it into writeback operations.

Current responsibilities:

- Refuses application when `issueBreakdown.applyToLinear.enabled` is off.
- Loads the latest fresh plan through `latestFreshIssueBreakdownPlan(...)` and returns `no_fresh_plan` when the parent issue or config has drifted.
- On live apply, marks older `pending` / `blocked` plans as `stale` when their fingerprints no longer match current issue/config state.
- Builds one `issue_create` writeback operation per proposed child issue with payload fields for:
  - `parentIssueId`
  - `planId`
  - `proposedIssueIndex`
  - `title`
  - `description`
  - `acceptanceCriteria`
  - `requestedLabels`
  - `dependencies`
  - `dedupeKey`
  - `payloadHash`
- Validates sibling dependency references before enqueueing work:
  - missing dependency title -> blocked
  - duplicate title match -> blocked as ambiguous
  - self-dependency -> blocked
- Supports preview mode (`dryRun`) without enqueueing any writeback operations.
- Requires both writeback enablement and a writeback processor for live apply; otherwise the plan is marked `blocked`.
- Records application progress in lifecycle state via `applicationStatus`, `applicationOperationKeys`, `createdIssueRefs`, `appliedAt`, and `applicationBlockedReason`.
- Treats child creation as successful only when the writeback result is `created` or `verified`; those results are merged into `createdIssueRefs`.
- Performs finalization only after all child references exist:
  - emits `issue_relation` writebacks for dependency edges, always using relation type `blocks`;
  - emits one parent `comment` summarizing the created child issues.
- Leaves the plan `pending`, `blocked`, or `applied` based on actual processed writeback results rather than on enqueue intent alone.

### `src/core/IssueContractLint.ts`

**Primary role**: shared preflight analysis for agent-eligible issue contracts and child-issue descriptions.

Current responsibilities:

- Defines the required headings for an agent-eligible issue description:
  - `Problem / Goal`
  - `Issue Contract`
  - `Touched Surfaces`
  - `Acceptance Criteria`
  - `Contract Checklist`
  - `Validation Requirements`
  - `Out Of Scope`
  - `Promotion Readiness`
- Parses markdown sections while ignoring headings inside fenced code blocks.
- Validates that the `Issue Contract` section contains a fenced `json` block that:
  - parses as JSON,
  - is an object,
  - includes a positive integer `schemaVersion`,
  - includes a non-empty `contractVersion`,
  - includes a non-empty `requirements` array,
  - uses stable unique requirement ids with non-empty requirement text.
- Parses `Promotion Readiness` for both:
  - `Ready for \`dogfood-ready\`: yes|no`
  - `Remaining blocker:` including nested bullet follow-on text.
- Finds protected-path matches only from the `Touched Surfaces` section, with normalization for `./`, punctuation, slashes, and glob patterns.
- Rejects placeholder remaining-blocker text and only treats a blocker as meaningful when it looks like a substantive operator/manual handoff reason.
- Provides `requiresAgentEligibleIssueContract(...)` for top-level issue lint applicability, but the breakdown plan service directly reuses the lower-level section/contract/protected-surface helpers for proposed child issues.

## Constraints relevant to ENG-392 child issue creation

1. **Every drafted child issue must already be agent-eligible or explicitly manual-only at submission time.** The breakdown plan service rejects child descriptions that are missing required sections, missing a fenced JSON Issue Contract, missing stable requirement ids, or omitting the `Ready for \`dogfood-ready\`` declaration.
2. **Decomposition cannot self-promote work into dispatch-ready labels.** Proposed child labels may not include `dogfood-ready` or configured worker-dispatch labels; operators are expected to add readiness labels after review.
3. **Protected surfaces force manual handling.** If a proposed child's `Touched Surfaces` matches a protected path, the child must keep `Ready for \`dogfood-ready\`: no` and include a substantive remaining blocker for operator/manual follow-up.
4. **Dependency wiring is title-based and strict.** Child dependencies are matched by normalized sibling titles, so missing titles, duplicate titles, or self-dependencies block application before any writeback is processed.
5. **The current apply path creates children, then relations, then a parent comment.** These services do not perform a separate child-issue update pass; they stage `issue_create`, `issue_relation`, and parent `comment` writebacks.
6. **Apply depends on freshness and writeback availability.** A plan only applies when it is the latest fresh plan, `applyToLinear` is enabled, and writeback is both enabled and available.
7. **Idempotency is already scoped for decomposition retries.** Same-run plan replays require an identical payload, cross-run idempotency-key reuse is rejected, and each child create operation gets its own payload-hashed dedupe key.

## Scenario matrix used for this inventory

| Scenario | Current behavior |
| --- | --- |
| Valid issue-breakdown submission from the active worker run | Plan is accepted, persisted, summarized, and exposed as the latest plan when fingerprints and validations stay current. |
| Child issue missing required sections or invalid contract JSON | Plan submission fails before persistence. |
| Child issue touches protected paths but claims ready or lacks a substantive blocker | Plan submission fails before persistence. |
| Parent issue/config drifts after a plan was accepted | The plan stops being fresh; live apply can mark `pending` / `blocked` plans as `stale`. |
| Child dependencies do not resolve cleanly by title | Apply returns or records `blocked` before child creation writebacks run. |
| Child create writebacks succeed but finalization is incomplete | Plan remains `pending` until child refs exist and final relation/comment operations succeed. |

## Relevant existing coverage for follow-on ENG-392 work

- `tests/issue-breakdown-plan-service.test.ts` covers plan acceptance, replay/idempotency, freshness drift, invalid child contracts, and protected-surface/manual-only enforcement.
- `tests/issue-breakdown-plan-apply-service.test.ts` covers preview/apply flows, stale-plan handling, dependency blocking, recovery of skipped writebacks, and project-context preservation.
- `tests/issue-contract-lint.test.ts` covers required headings, fenced JSON validation, protected-path matching, `Ready for \`dogfood-ready\`` parsing, and meaningful-blocker detection.

## Bottom line for decomposition planning

The current Symphony decomposition path already has three distinct seams:

1. **Plan acceptance** in `IssueBreakdownPlanService`.
2. **Plan application / child writeback orchestration** in `IssueBreakdownPlanApplyService`.
3. **Contract and protected-surface preflight** in `IssueContractLint`.

For ENG-392 child issue creation, the critical constraints are: keep child contracts fully formed up front, avoid auto-ready labels, keep protected-path children manual-only, and ensure dependency titles are unique and resolvable before any writeback apply is attempted.
