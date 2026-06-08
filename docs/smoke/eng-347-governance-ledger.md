# ENG-347 Governance and Proof Ledger

Captured on `2026-06-08T20:40:32Z` for `specs/003-multi-project-config` on branch `sinfonista/eng-347-implement-multi-project-configuration`.

## Purpose

Provide a repo-local, reviewer-verifiable closure packet for the ENG-347 governance finding by recording:

1. a fenced JSON feature issue-contract mirror for ENG-347;
2. a child-issue inventory / order / completion ledger for the `tasks.md`-derived implementation issues currently visible as local git refs;
3. fenced JSON contract mirrors for each split child issue; and
4. an explicit current-artifact proof ledger mapping `FR-001` through `FR-025` and `SC-001` through `SC-009` to code, tests, docs, and validation artifacts in this worktree.

This ledger is the repo-local counterpart to the governance rules in `WORKFLOW.md:29-35`, the split-issue requirement in `specs/003-multi-project-config/tasks.md:9`, the quickstart scenarios in `specs/003-multi-project-config/quickstart.md:9-87`, and the final validation packet in `docs/smoke/eng-347-final-validation.md`.

## Verification anchors

- Issue-contract authoring rule: `WORKFLOW.md:29-35`
- Split-issue contract rule: `specs/003-multi-project-config/tasks.md:9`
- Child-task order/dependencies: `specs/003-multi-project-config/tasks.md:11-19`, `specs/003-multi-project-config/tasks.md:23-45`, `specs/003-multi-project-config/tasks.md:221-260`
- Scenario definitions: `specs/003-multi-project-config/quickstart.md:9-87`
- Validation packet: `docs/smoke/eng-347-final-validation.md` (current T095-T105 sections).
- Contract-shape helpers used by the test suite: `tests/helpers.ts` (`renderIssueDescription`, `issueContractContractVersion`, `createLinearIssueFixture`, `createLinearWorkflowStateFixture`, `buildMultiProjectWorkflowConfig`).

## Child issue derivation scope

- `specs/003-multi-project-config/tasks.md` remains the authoritative full feature plan across Phases 1 through 8.
- `specs/003-multi-project-config/tasks.md:9` narrows the child-issue governance requirement to tasks or phase buckets that were actually split into child issues.
- The complete repo-visible child issue set for this feature is exhausted by the matching `sinfonista/eng-3*` local/origin refs for `ENG-348`, `ENG-349`, and `ENG-356` through `ENG-364`; no additional child phase/task refs exist in this worktree.
- The remaining Phase 3 through Phase 8 tasks (`T009-T105`) stayed parent-scoped on `ENG-347` and therefore close through the FR/SC proof ledger later in this file plus `docs/smoke/eng-347-final-validation.md`, not through separate child-issue rows.

## ENG-347 feature issue-contract mirror

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-07.1",
  "requirements": [
    {
      "id": "REQ-FEATURE-001",
      "requirement": "Complete the multi-project configuration feature by delivering the child phase issues derived from specs/003-multi-project-config/tasks.md.",
      "proofHint": "Reference completed child issues and validation evidence from the feature task plan."
    },
    {
      "id": "REQ-FEATURE-002",
      "requirement": "Preserve Symphony issue-contract governance: every child implementation issue must keep a valid fenced JSON issue contract with non-empty stable requirements.",
      "proofHint": "Confirm child issues retain schemaVersion, contractVersion, and requirements entries before promotion."
    }
  ]
}
```

## Child-issue inventory / order / completion ledger

The table below records the complete repo-visible child issue set for this feature. Matching local/origin refs were re-verified via `git for-each-ref --sort=refname --format='%(refname:short)|%(objectname:short)|%(subject)' refs/heads/sinfonista/eng-3* refs/remotes/origin/sinfonista/eng-3*`. No additional child phase/task refs exist beyond the 11 entries below. The remaining `tasks.md` items stayed parent-scoped on `ENG-347`, so their closure evidence appears in the FR/SC proof ledger rather than in separate child rows.

| Order | Issue | Planned scope | Ref / branch evidence | Order evidence | Completion evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | ENG-348 | Phase 1 setup (`T001-T005`) | `origin/sinfonista/eng-348-phase-1-multi-project-setup-inventory@01d6c22` | `tasks.md:11-19`, `tasks.md:235-237`, `tasks.md:254-255` | `specs/003-multi-project-config/research.md:73-110`; `tests/helpers.ts` (`renderIssueDescription`, `issueContractContractVersion`); `docs/smoke/eng-347-final-validation.md` |
| 2 | ENG-349 | Phase 2 foundational contracts (`T006-T022`) | `origin/sinfonista/eng-349-phase-2-multi-project-foundational-contracts@a708b02` | `tasks.md:23-45`, `tasks.md:236-237`, `tasks.md:255` | `src/core/config/ProjectContexts.ts:18-115`; `src/core/config/Config.ts:1160-1217`; `migrations/postgres/0007_project_context_attribution.sql`; `tests/postgres-schema.test.ts:41-44,171-191`; `docs/smoke/eng-347-final-validation.md` |
| 3 | ENG-356 | `T001` inspect current single-project assumptions | `origin/sinfonista/eng-356-t001-inspect-current-single-project-assumptions@2643fb9` | `tasks.md:15`, `tasks.md:254` | `specs/003-multi-project-config/research.md:73-110` |
| 4 | ENG-357 | `T002` add reusable multi-project workflow fixture helpers | `origin/sinfonista/eng-357-t002-add-reusable-multi-project-workflow-fixture-helpers@58e1305` | `tasks.md:16`, `tasks.md:254` | `tests/helpers.ts` (`renderIssueDescription`, `issueContractContractVersion`) |
| 5 | ENG-358 | `T003` add multi-project tracker and issue fixture builders | `origin/sinfonista/eng-358-t003-add-multi-project-tracker-and-issue-fixture-builders@3e7fd46` | `tasks.md:17`, `tasks.md:254` | `tests/helpers.ts` (`createLinearIssueFixture`, `createLinearWorkflowStateFixture`, `buildMultiProjectWorkflowConfig`) |
| 6 | ENG-359 | `T004` add protected-surface inventory note | `origin/sinfonista/eng-359-t004-add-protected-surface-inventory-note@8df43a4` | `tasks.md:18`, `tasks.md:254` | `specs/003-multi-project-config/research.md:73-110` |
| 7 | ENG-360 | `T005` verify no implementation dependency under `hermes/upstream-src/**` | `origin/sinfonista/eng-360-t005-verify-no-hermes-upstream-implementation-dependency@1a080b8` | `tasks.md:19`, `tasks.md:254` | `specs/003-multi-project-config/research.md:99-105`; `docs/smoke/eng-347-final-validation.md` |
| 8 | ENG-361 | `T006` config contract tests for ids / duplicates / validation | `origin/sinfonista/eng-361-t006-add-project-context-config-contract-tests@249c794` | `tasks.md:29`, `tasks.md:255` | `tests/workflow.test.ts:1410-1501`; `docs/smoke/eng-347-final-validation.md` |
| 9 | ENG-362 | `T007` redaction tests for context summaries and validation errors | `origin/sinfonista/eng-362-t007-add-project-context-redaction-tests@b14a8b0` | `tasks.md:30`, `tasks.md:255` | `tests/workflow.test.ts:1410-1501`; `tests/credential-profiles.test.ts:181-183,289-329,379-380`; `docs/smoke/eng-347-final-validation.md` |
| 10 | ENG-363 | `T008` normalization + durable attribution contract tests | `origin/sinfonista/eng-363-t008-add-project-context-normalization-and-durable@3a59a1c` | `tasks.md:31`, `tasks.md:255-256` | `src/core/config/ProjectContexts.ts:18-115`; `src/core/persistence/IssueLifecycleStore.ts`; `src/core/writeback/WritebackOutbox.ts`; `src/core/approval/OperatorApprovalService.ts`; `docs/smoke/eng-347-final-validation.md` |
| 11 | ENG-364 | `T021` Postgres migration tests for project-context attribution | `origin/sinfonista/eng-364-t021-add-postgres-migration-tests-for-project-context@2e16092` | `tasks.md:44`, `tasks.md:255` | `tests/postgres-schema.test.ts:41-44,171-191`; `docs/smoke/eng-347-final-validation.md` |

## Child issue-contract mirrors

All mirrors below keep the schema expected by `tests/helpers.ts` (`renderIssueDescription`, `issueContractContractVersion`, `createLinearIssueFixture`, `createLinearWorkflowStateFixture`, `buildMultiProjectWorkflowConfig`): `schemaVersion`, `contractVersion`, and a non-empty `requirements` array with stable unique IDs.

### ENG-348

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-348-001",
      "requirement": "Complete the multi-project setup inventory tasks T001 through T005 from specs/003-multi-project-config/tasks.md.",
      "proofHint": "See research.md protected-surface inventory, tests/helpers.ts fixtures, and the no-Hermes-upstream evidence in the validation packet."
    }
  ]
}
```

### ENG-349

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-349-001",
      "requirement": "Complete the foundational multi-project contracts and durable attribution tasks T006 through T022 from specs/003-multi-project-config/tasks.md.",
      "proofHint": "See ProjectContexts/Config normalization, migration 0007, and the foundational validation packet sections."
    }
  ]
}
```

### ENG-356

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-356-001",
      "requirement": "Inspect the current single-project assumptions called out by task T001 and preserve the findings in repo-local planning research.",
      "proofHint": "See specs/003-multi-project-config/research.md:73-96."
    }
  ]
}
```

### ENG-357

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-357-001",
      "requirement": "Add reusable multi-project workflow fixture helpers for test coverage as required by task T002.",
      "proofHint": "See tests/helpers.ts (`renderIssueDescription`, `issueContractContractVersion`)."
    }
  ]
}
```

### ENG-358

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-358-001",
      "requirement": "Add multi-project tracker and issue fixture builders for test coverage as required by task T003.",
      "proofHint": "See tests/helpers.ts (`createLinearIssueFixture`, `createLinearWorkflowStateFixture`, `buildMultiProjectWorkflowConfig`)."
    }
  ]
}
```

### ENG-359

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-359-001",
      "requirement": "Record the protected-surface inventory note for the feature as required by task T004.",
      "proofHint": "See specs/003-multi-project-config/research.md:73-96."
    }
  ]
}
```

### ENG-360

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-360-001",
      "requirement": "Verify that the multi-project feature does not require implementation changes under hermes/upstream-src/** as required by task T005.",
      "proofHint": "See specs/003-multi-project-config/research.md:99-105 and docs/smoke/eng-347-final-validation.md."
    }
  ]
}
```

### ENG-361

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-361-001",
      "requirement": "Add project-context configuration contract tests for normalization, duplicates, and validation errors as required by task T006.",
      "proofHint": "See tests/workflow.test.ts:1410-1501."
    }
  ]
}
```

### ENG-362

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-362-001",
      "requirement": "Add project-context redaction tests for validation errors and summaries as required by task T007.",
      "proofHint": "See workflow/credential redaction evidence referenced in the ledger."
    }
  ]
}
```

### ENG-363

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-363-001",
      "requirement": "Add project-context normalization and durable attribution contract coverage as required by task T008.",
      "proofHint": "See ProjectContexts, lifecycle/writeback/approval durability surfaces, and the validation packet T099-T101 evidence."
    }
  ]
}
```

### ENG-364

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-ENG-364-001",
      "requirement": "Add Postgres migration tests for project-context attribution as required by task T021.",
      "proofHint": "See tests/postgres-schema.test.ts:41-44,171-191."
    }
  ]
}
```

## FR proof ledger

| Requirement | Repo-local closure |
| --- | --- |
| FR-001 | `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md`; `tests/workflow.test.ts:1430-1483` |
| FR-002 | `src/core/config/ProjectContexts.ts:18-21,40-55,113-115`; `src/core/config/Config.ts:1188-1199`; `tests/workflow.test.ts:1485-1501` |
| FR-003 | `src/core/config/ProjectContexts.ts:18-31,90-110`; `tests/workflow.test.ts:1430-1483`; `tests/linear-multi-project.test.ts:238-247` |
| FR-004 | `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md`; `tests/workflow.test.ts:1430-1483` |
| FR-005 | `specs/003-multi-project-config/quickstart.md:35-45`; `docs/smoke/eng-347-final-validation.md`; `tests/linear-multi-project.test.ts:79-236` |
| FR-006 | `specs/003-multi-project-config/quickstart.md:35-45`; `tests/linear-multi-project.test.ts:115-236`; `docs/smoke/eng-347-final-validation.md` |
| FR-007 | `specs/003-multi-project-config/quickstart.md:35-45`; `tests/linear-multi-project.test.ts:79-113`; `docs/smoke/eng-347-final-validation.md` |
| FR-008 | `specs/003-multi-project-config/quickstart.md:47-58`; `docs/smoke/eng-347-final-validation.md`; `tests/status-api.test.ts`; `tests/orchestrator.test.ts` |
| FR-009 | `src/core/config/ProjectContexts.ts:53-110`; `tests/git-worktree.test.ts`; `docs/smoke/eng-347-final-validation.md` |
| FR-010 | `tests/linear-multi-project.test.ts:167-247`; `src/core/writeback/TransitionPolicy.ts:97-105,210-215,493-553,644-690`; `tests/transition-policy.test.ts:230-276,369-443` |
| FR-011 | `src/core/writeback/TransitionPolicy.ts:97-105,210-215,493-553,644-690`; `tests/transition-policy.test.ts:230-276,369-443`; `tests/completion-report-mcp.test.ts`; `tests/review-verdict-mcp.test.ts`; `tests/review-feedback-mcp.test.ts` |
| FR-012 | `tests/completion-report-mcp.test.ts`; `tests/review-verdict-mcp.test.ts`; `tests/review-feedback-mcp.test.ts`; `docs/smoke/eng-347-final-validation.md` |
| FR-013 | `src/core/config/ProjectContexts.ts:53-55`; `src/app/WebProjectionContext.ts`; `tests/git-worktree.test.ts`; `docs/smoke/eng-347-final-validation.md` |
| FR-014 | `migrations/postgres/0007_project_context_attribution.sql`; `src/core/persistence/RunTranscriptStore.ts`; `src/app/webProjection.ts`; `docs/smoke/eng-347-final-validation.md` |
| FR-015 | `tests/linear-multi-project.test.ts:115-236`; `src/integrations/linear/MultiProjectLinearTrackerClient.ts`; `docs/smoke/eng-347-final-validation.md` |
| FR-016 | `specs/003-multi-project-config/quickstart.md:59-79`; `docs/smoke/eng-347-final-validation.md`; `tests/web-projection.test.ts`; `tests/web-history-projection.test.ts`; `tests/web-transcript-projection.test.ts`; `tests/web-route-contract.test.ts`; `tests/web-projection-context.test.ts`; `tests/web-issue-detail.test.ts` |
| FR-017 | `specs/003-multi-project-config/quickstart.md:59-79`; `src/app/http.ts:2396,5210,5756-5781`; `tests/status-api.test.ts:1726-1823`; `tests/web-history-projection.test.ts`; `tests/web-issue-detail.test.ts` |
| FR-018 | `tests/workflow.test.ts:1485-1501`; `tests/credential-profiles.test.ts`; `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md` |
| FR-019 | `specs/003-multi-project-config/quickstart.md:47-58`; `docs/smoke/eng-347-final-validation.md`; `tests/orchestrator.test.ts`; `tests/status-api.test.ts` |
| FR-020 | `src/core/persistence/IssueLifecycleStore.ts`; `src/core/persistence/RunTranscriptStore.ts`; `docs/smoke/eng-347-final-validation.md`; `tests/issue-lifecycle-store.test.ts`; `tests/writeback-outbox.test.ts` |
| FR-021 | `src/core/config/Config.ts:1160-1180`; `src/core/config/ProjectContexts.ts:62-88`; `tests/workflow.test.ts:1410-1428`; `docs/smoke/eng-347-final-validation.md` |
| FR-022 | `src/core/config/ProjectContexts.ts:57-88`; `src/core/persistence/RunTranscriptStore.ts`; `src/core/persistence/IssueLifecycleStore.ts`; `tests/status-api.test.ts`; `tests/web-history-projection.test.ts`; `tests/web-transcript-projection.test.ts` |
| FR-023 | `src/core/config/ProjectContexts.ts:18-31,90-110`; `src/core/config/Config.ts:1195-1217`; `tests/workflow.test.ts:1430-1483`; `tests/linear-multi-project.test.ts:238-247`; `tests/transition-policy.test.ts:230-276,369-443` |
| FR-024 | `docs/smoke/eng-347-final-validation.md`; `tests/credential-profiles.test.ts`; `tests/status-api.test.ts`; `tests/web-route-contract.test.ts`; `tests/web-issue-detail.test.ts`; `docs/dogfood-runbook.md` |
| FR-025 | `docs/smoke/eng-347-final-validation.md`; `specs/003-multi-project-config/quickstart.md:81-87`; `npm test`; `npm run typecheck` |

## SC proof ledger

| Requirement | Repo-local closure |
| --- | --- |
| SC-001 | `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md`; `tests/workflow.test.ts:1430-1483` |
| SC-002 | `specs/003-multi-project-config/quickstart.md:35-45`; `docs/smoke/eng-347-final-validation.md`; `tests/linear-multi-project.test.ts:167-247`; `tests/transition-policy.test.ts:230-276,369-443` |
| SC-003 | `specs/003-multi-project-config/quickstart.md:59-79`; `docs/smoke/eng-347-final-validation.md`; `tests/git-worktree.test.ts`; `tests/web-projection-context.test.ts`; `tests/web-issue-detail.test.ts`; `tests/status-api.test.ts:1726-1823` |
| SC-004 | `specs/003-multi-project-config/quickstart.md:47-58`; `docs/smoke/eng-347-final-validation.md`; `tests/orchestrator.test.ts`; `tests/status-api.test.ts`; `tests/git-worktree.test.ts` |
| SC-005 | `specs/003-multi-project-config/quickstart.md:35-45`; `tests/linear-multi-project.test.ts:115-236`; `docs/smoke/eng-347-final-validation.md` |
| SC-006 | `specs/003-multi-project-config/quickstart.md:9-19`; `docs/smoke/eng-347-final-validation.md`; `tests/workflow.test.ts:1410-1428` |
| SC-007 | `docs/smoke/eng-347-final-validation.md`; `tests/credential-profiles.test.ts`; `tests/status-api.test.ts`; `tests/web-route-contract.test.ts`; `tests/web-issue-detail.test.ts` |
| SC-008 | `docs/smoke/eng-347-final-validation.md`; `migrations/postgres/0007_project_context_attribution.sql`; `src/core/persistence/RunTranscriptStore.ts`; `src/core/persistence/IssueLifecycleStore.ts`; `tests/issue-lifecycle-store.test.ts`; `tests/writeback-outbox.test.ts`; `tests/status-api.test.ts` |
| SC-009 | `specs/003-multi-project-config/quickstart.md:59-79`; `src/app/http.ts:2396,5210,5756-5781`; `tests/status-api.test.ts:1726-1823`; `tests/web-history-projection.test.ts`; `tests/web-issue-detail.test.ts`; `docs/smoke/eng-347-final-validation.md` |

## Reviewer-facing closure summary

- `REQ-FEATURE-001` proof now lives in the FR/SC ledger above plus the current validation packet in `docs/smoke/eng-347-final-validation.md`, including the host-local T100/T102 blockers still open on this Windows review surface.
- `REQ-FEATURE-002` remains closed by the child-issue inventory/order/completion ledger plus the fenced JSON contract mirrors in this file.
- Remaining caveats are operational rather than governance-related: the current Windows host still has the sqlite / CLI full-suite blockers recorded in the validation packet, and the repo still does not include a live external Linear + GitHub multi-context publication/replay capture.
