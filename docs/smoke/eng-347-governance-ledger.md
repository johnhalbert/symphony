# ENG-347 Governance and Proof Ledger

Captured on `2026-06-08T17:04:19Z` for `specs/003-multi-project-config` on branch `sinfonista/eng-347-implement-multi-project-configuration`.

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
- Validation packet: `docs/smoke/eng-347-final-validation.md:23-192`
- Contract-shape helper used by the test suite: `tests/helpers.ts:51-133`

## ENG-347 feature issue-contract mirror

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-08.1",
  "requirements": [
    {
      "id": "REQ-FEATURE-001",
      "requirement": "Close the multi-project configuration feature from current repo-local artifacts by mapping the implemented behavior and validation packet to FR-001 through FR-025 and SC-001 through SC-009.",
      "proofHint": "See the FR/SC proof ledger in this file plus docs/smoke/eng-347-final-validation.md."
    },
    {
      "id": "REQ-FEATURE-002",
      "requirement": "Preserve reviewer-verifiable governance evidence for the tasks.md-derived implementation issues by keeping a repo-local child-issue inventory/order/completion ledger and valid fenced JSON contract mirrors for each split child issue.",
      "proofHint": "See the child-issue ledger and child contract mirrors in this file."
    }
  ]
}
```

## Child-issue inventory / order / completion ledger

The refs below are visible in the local repository via `git for-each-ref refs/remotes/origin/sinfonista/eng-3*`. Their exact tip SHAs are retained as branch records even though the current ENG-347 feature branch does not preserve those tip commits as direct ancestors; the durable completion signal for review is therefore the current worktree artifact set cited in the `Completion evidence` column.

| Order | Issue | Planned scope | Ref / branch evidence | Order evidence | Completion evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | ENG-348 | Phase 1 setup (`T001-T005`) | `origin/sinfonista/eng-348-phase-1-multi-project-setup-inventory@01d6c22` | `tasks.md:11-19`, `tasks.md:235-237`, `tasks.md:254-255` | `specs/003-multi-project-config/research.md:73-96`; `tests/helpers.ts:51-139`; `docs/smoke/eng-347-final-validation.md:160-173` |
| 2 | ENG-349 | Phase 2 foundational contracts (`T006-T022`) | `origin/sinfonista/eng-349-phase-2-multi-project-foundational-contracts@6aecb5c` | `tasks.md:23-45`, `tasks.md:236-237`, `tasks.md:255` | `src/core/config/ProjectContexts.ts:18-115`; `src/core/config/Config.ts:1160-1217`; `migrations/postgres/0007_project_context_attribution.sql`; `tests/postgres-schema.test.ts:41-44,171-191`; `docs/smoke/eng-347-final-validation.md:33-91` |
| 3 | ENG-356 | `T001` inspect current single-project assumptions | `origin/sinfonista/eng-356-t001-inspect-current-single-project-assumptions@2643fb9` | `tasks.md:15`, `tasks.md:254` | `specs/003-multi-project-config/research.md:73-96` |
| 4 | ENG-357 | `T002` add reusable multi-project workflow fixture helpers | `origin/sinfonista/eng-357-t002-add-reusable-multi-project-workflow-fixture-helpers@58e1305` | `tasks.md:16`, `tasks.md:254` | `tests/helpers.ts:51-169` |
| 5 | ENG-358 | `T003` add multi-project tracker and issue fixture builders | `origin/sinfonista/eng-358-t003-add-multi-project-tracker-and-issue-fixture-builders@3e7fd46` | `tasks.md:17`, `tasks.md:254` | `tests/helpers.ts:1-49` |
| 6 | ENG-359 | `T004` add protected-surface inventory note | `origin/sinfonista/eng-359-t004-add-protected-surface-inventory-note@8df43a4` | `tasks.md:18`, `tasks.md:254` | `specs/003-multi-project-config/research.md:73-96` |
| 7 | ENG-360 | `T005` verify no implementation dependency under `hermes/upstream-src/**` | `origin/sinfonista/eng-360-t005-verify-no-hermes-upstream-implementation-dependency@1a080b8` | `tasks.md:19`, `tasks.md:254` | `specs/003-multi-project-config/research.md:92-96`; `docs/smoke/eng-347-final-validation.md:160-173` |
| 8 | ENG-361 | `T006` config contract tests for ids / duplicates / validation | `origin/sinfonista/eng-361-t006-add-project-context-config-contract-tests@4baa858` | `tasks.md:29`, `tasks.md:255` | `tests/workflow.test.ts:1410-1501`; `docs/smoke/eng-347-final-validation.md:33-42` |
| 9 | ENG-362 | `T007` redaction tests for context summaries and validation errors | `origin/sinfonista/eng-362-t007-add-project-context-redaction-tests@dea0082` | `tasks.md:30`, `tasks.md:255` | `tests/workflow.test.ts:1410-1501`; `tests/credential-profiles.test.ts:181-183,289-329,379-380`; `docs/smoke/eng-347-final-validation.md:148-158` |
| 10 | ENG-363 | `T008` normalization + durable attribution contract tests | `origin/sinfonista/eng-363-t008-add-project-context-normalization-and-durable@b29f994` | `tasks.md:31`, `tasks.md:255-256` | `src/core/config/ProjectContexts.ts:18-115`; `src/core/persistence/IssueLifecycleStore.ts`; `src/core/writeback/WritebackOutbox.ts`; `src/core/approval/OperatorApprovalService.ts`; `docs/smoke/eng-347-final-validation.md:82-108` |
| 11 | ENG-364 | `T021` Postgres migration tests for project-context attribution | `origin/sinfonista/eng-364-t021-add-postgres-migration-tests-for-project-context@353dafe` | `tasks.md:44`, `tasks.md:255` | `tests/postgres-schema.test.ts:41-44,171-191`; `docs/smoke/eng-347-final-validation.md:82-91` |

## Child issue-contract mirrors

All mirrors below keep the schema expected by `tests/helpers.ts:51-133`: `schemaVersion`, `contractVersion`, and a non-empty `requirements` array with stable unique IDs.

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
      "proofHint": "See tests/helpers.ts:51-169."
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
      "proofHint": "See tests/helpers.ts:1-49."
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
      "proofHint": "See specs/003-multi-project-config/research.md:92-96 and docs/smoke/eng-347-final-validation.md:160-173."
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
| FR-001 | `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md:33-42`; `tests/workflow.test.ts:1430-1483` |
| FR-002 | `src/core/config/ProjectContexts.ts:18-21,40-55,113-115`; `src/core/config/Config.ts:1188-1199`; `tests/workflow.test.ts:1485-1501` |
| FR-003 | `src/core/config/ProjectContexts.ts:18-31,90-110`; `tests/workflow.test.ts:1430-1483`; `tests/linear-multi-project.test.ts:238-247` |
| FR-004 | `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md:33-42`; `tests/workflow.test.ts:1430-1483` |
| FR-005 | `specs/003-multi-project-config/quickstart.md:35-45`; `docs/smoke/eng-347-final-validation.md:44-53`; `tests/linear-multi-project.test.ts:79-236` |
| FR-006 | `specs/003-multi-project-config/quickstart.md:35-45`; `tests/linear-multi-project.test.ts:115-236`; `docs/smoke/eng-347-final-validation.md:44-53` |
| FR-007 | `specs/003-multi-project-config/quickstart.md:35-45`; `tests/linear-multi-project.test.ts:79-113`; `docs/smoke/eng-347-final-validation.md:44-53` |
| FR-008 | `specs/003-multi-project-config/quickstart.md:47-58`; `docs/smoke/eng-347-final-validation.md:44-53,110-127`; `tests/status-api.test.ts`; `tests/orchestrator.test.ts` |
| FR-009 | `src/core/config/ProjectContexts.ts:53-110`; `tests/git-worktree.test.ts`; `docs/smoke/eng-347-final-validation.md:44-53` |
| FR-010 | `tests/linear-multi-project.test.ts:167-247`; `src/core/writeback/TransitionPolicy.ts:97-105,210-215,493-553,644-690`; `tests/transition-policy.test.ts:230-276,369-443` |
| FR-011 | `src/core/writeback/TransitionPolicy.ts:97-105,210-215,493-553,644-690`; `tests/transition-policy.test.ts:230-276,369-443`; `tests/completion-report-mcp.test.ts`; `tests/review-verdict-mcp.test.ts`; `tests/review-feedback-mcp.test.ts` |
| FR-012 | `tests/completion-report-mcp.test.ts`; `tests/review-verdict-mcp.test.ts`; `tests/review-feedback-mcp.test.ts`; `docs/smoke/eng-347-final-validation.md:55-64` |
| FR-013 | `src/core/config/ProjectContexts.ts:53-55`; `src/app/WebProjectionContext.ts`; `tests/git-worktree.test.ts`; `docs/smoke/eng-347-final-validation.md:23-29,64-78` |
| FR-014 | `migrations/postgres/0007_project_context_attribution.sql`; `src/core/persistence/RunTranscriptStore.ts`; `src/app/webProjection.ts`; `docs/smoke/eng-347-final-validation.md:82-108` |
| FR-015 | `tests/linear-multi-project.test.ts:115-236`; `src/integrations/linear/MultiProjectLinearTrackerClient.ts`; `docs/smoke/eng-347-final-validation.md:44-53` |
| FR-016 | `specs/003-multi-project-config/quickstart.md:59-79`; `docs/smoke/eng-347-final-validation.md:66-80,110-127`; `tests/web-projection.test.ts`; `tests/web-history-projection.test.ts`; `tests/web-transcript-projection.test.ts`; `tests/web-route-contract.test.ts`; `tests/web-projection-context.test.ts`; `tests/web-issue-detail.test.ts` |
| FR-017 | `specs/003-multi-project-config/quickstart.md:59-79`; `src/app/http.ts:2396,5210,5756-5781`; `tests/status-api.test.ts:1726-1823`; `tests/web-history-projection.test.ts`; `tests/web-issue-detail.test.ts` |
| FR-018 | `tests/workflow.test.ts:1485-1501`; `tests/credential-profiles.test.ts`; `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md:33-42,148-158` |
| FR-019 | `specs/003-multi-project-config/quickstart.md:47-58`; `docs/smoke/eng-347-final-validation.md:44-53,110-127`; `tests/orchestrator.test.ts`; `tests/status-api.test.ts` |
| FR-020 | `src/core/persistence/IssueLifecycleStore.ts`; `src/core/persistence/RunTranscriptStore.ts`; `docs/smoke/eng-347-final-validation.md:25-31,82-108`; `tests/issue-lifecycle-store.test.ts`; `tests/writeback-outbox.test.ts` |
| FR-021 | `src/core/config/Config.ts:1160-1180`; `src/core/config/ProjectContexts.ts:62-88`; `tests/workflow.test.ts:1410-1428`; `docs/smoke/eng-347-final-validation.md:33-42` |
| FR-022 | `src/core/config/ProjectContexts.ts:57-88`; `src/core/persistence/RunTranscriptStore.ts`; `src/core/persistence/IssueLifecycleStore.ts`; `tests/status-api.test.ts`; `tests/web-history-projection.test.ts`; `tests/web-transcript-projection.test.ts` |
| FR-023 | `src/core/config/ProjectContexts.ts:18-31,90-110`; `src/core/config/Config.ts:1195-1217`; `tests/workflow.test.ts:1430-1483`; `tests/linear-multi-project.test.ts:238-247`; `tests/transition-policy.test.ts:230-276,369-443` |
| FR-024 | `docs/smoke/eng-347-final-validation.md:148-158`; `tests/credential-profiles.test.ts`; `tests/status-api.test.ts`; `tests/web-route-contract.test.ts`; `tests/web-issue-detail.test.ts`; `docs/dogfood-runbook.md` |
| FR-025 | `docs/smoke/eng-347-final-validation.md:23-192`; `specs/003-multi-project-config/quickstart.md:81-87`; `npm test`; `npm run typecheck` |

## SC proof ledger

| Requirement | Repo-local closure |
| --- | --- |
| SC-001 | `specs/003-multi-project-config/quickstart.md:21-33`; `docs/smoke/eng-347-final-validation.md:33-42,110-127`; `tests/workflow.test.ts:1430-1483` |
| SC-002 | `specs/003-multi-project-config/quickstart.md:35-45`; `docs/smoke/eng-347-final-validation.md:44-53`; `tests/linear-multi-project.test.ts:167-247`; `tests/transition-policy.test.ts:230-276,369-443` |
| SC-003 | `specs/003-multi-project-config/quickstart.md:59-79`; `docs/smoke/eng-347-final-validation.md:66-80`; `tests/git-worktree.test.ts`; `tests/web-projection-context.test.ts`; `tests/web-issue-detail.test.ts`; `tests/status-api.test.ts:1726-1823` |
| SC-004 | `specs/003-multi-project-config/quickstart.md:47-58`; `docs/smoke/eng-347-final-validation.md:44-53,110-127`; `tests/orchestrator.test.ts`; `tests/status-api.test.ts`; `tests/git-worktree.test.ts` |
| SC-005 | `specs/003-multi-project-config/quickstart.md:35-45`; `tests/linear-multi-project.test.ts:115-236`; `docs/smoke/eng-347-final-validation.md:44-53` |
| SC-006 | `specs/003-multi-project-config/quickstart.md:9-19`; `docs/smoke/eng-347-final-validation.md:33-42`; `tests/workflow.test.ts:1410-1428` |
| SC-007 | `docs/smoke/eng-347-final-validation.md:148-158`; `tests/credential-profiles.test.ts`; `tests/status-api.test.ts`; `tests/web-route-contract.test.ts`; `tests/web-issue-detail.test.ts` |
| SC-008 | `docs/smoke/eng-347-final-validation.md:25-31,82-108`; `migrations/postgres/0007_project_context_attribution.sql`; `src/core/persistence/RunTranscriptStore.ts`; `src/core/persistence/IssueLifecycleStore.ts`; `tests/issue-lifecycle-store.test.ts`; `tests/writeback-outbox.test.ts`; `tests/status-api.test.ts` |
| SC-009 | `specs/003-multi-project-config/quickstart.md:59-79`; `src/app/http.ts:2396,5210,5756-5781`; `tests/status-api.test.ts:1726-1823`; `tests/web-history-projection.test.ts`; `tests/web-issue-detail.test.ts`; `docs/smoke/eng-347-final-validation.md:66-80` |

## Reviewer-facing closure summary

- `REQ-FEATURE-001` is closed by the FR/SC proof ledger above plus the validation packet in `docs/smoke/eng-347-final-validation.md`.
- `REQ-FEATURE-002` is closed by the child-issue inventory/order/completion ledger plus the fenced JSON contract mirrors in this file.
- The remaining runtime caveat is now operational rather than authoring/governance-related: the repo still does not include a live external Linear + GitHub multi-context publication/replay capture, which remains tracked as validation scope rather than review-surface governance.
