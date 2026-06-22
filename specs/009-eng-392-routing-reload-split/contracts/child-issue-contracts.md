# Contract: ENG-392 Child Issue Contracts

This file defines the planned child issue contract families for ENG-392. These are planning templates only; the Linear issue description remains the canonical contract once a child issue is created or delegated.

## Required Child Families

### REQ-392-DECISION - Decomposition Decision

**Purpose**: Record whether ENG-392 will be split/retargeted, explicitly widened through child contracts, or closed/replaced with current-base evidence.

**Authorized Surfaces**:

- Linear comments or issue update through Symphony-owned writeback.
- Spec Kit or planning evidence.
- Issue breakdown plan records.

**Requirement Template**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-14.1",
  "requirements": [
    {
      "id": "REQ-392-DECISION",
      "requirement": "Record an operator-facing ENG-392 decomposition decision before any renewed worker dispatch.",
      "proofHint": "Show the selected path and cite the contract/publication mismatch evidence from Linear comments."
    }
  ]
}
```

### REQ-392-TEST-PROOF - Narrow Routing And Reload Test Proof

**Purpose**: Preserve the original ENG-392 obligation as an independently reviewable test-proof child.

**Authorized Surfaces**:

- `tests/orchestrator.test.ts`
- Planning or issue evidence that records dependency status.

**Requirement Template**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-14.1",
  "requirements": [
    {
      "id": "REQ-392-TEST-PROOF",
      "requirement": "Add or preserve orchestrator tests proving two Linear project contexts route to distinct workspaces/state buckets and in-progress contexts survive config reload.",
      "proofHint": "Show focused routing/reload tests and full orchestrator validation after declared runtime dependencies are satisfied."
    },
    {
      "id": "REQ-392-TEST-SURFACE",
      "requirement": "Keep the publication candidate limited to the test-proof contract surface unless a separate child contract authorizes more.",
      "proofHint": "Attach a contract-to-surface comparison for the candidate."
    }
  ]
}
```

### REQ-392-RUNTIME-ROUTING - Runtime Context Routing Prerequisites

**Purpose**: Own runtime behavior needed for project-context dispatch, retry, reconciliation, handoff, continuation, and readback.

**Authorized Surfaces**:

- `src/core/orchestrator/Orchestrator.ts`
- `src/core/config/Config.ts`
- `src/core/workspace/WorkspaceManager.ts`
- Tests that directly validate those runtime paths.

**Requirement Template**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-14.1",
  "requirements": [
    {
      "id": "REQ-392-RUNTIME-ROUTING",
      "requirement": "Carry the resolved project context through dispatch, retry, running-run reconciliation, handoff, continuation, and readback behavior required by the routing/reload proof.",
      "proofHint": "Show failing-before or base-behavior evidence, then focused passing validation for context-specific runtime routing."
    }
  ]
}
```

### REQ-392-RELOAD-PRESERVATION - Worker And Reviewer Redispatch Preservation

**Purpose**: Own preservation of the original issue/request project context after config reload until worker or reviewer redispatch completes.

**Authorized Surfaces**:

- `src/core/orchestrator/Orchestrator.ts`
- `src/core/persistence/RunTranscriptStore.ts`
- `src/core/persistence/IssueLifecycleStore.ts`
- `tests/orchestrator.test.ts`

**Requirement Template**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-14.1",
  "requirements": [
    {
      "id": "REQ-392-RELOAD-PRESERVATION",
      "requirement": "Preserve worker and reviewer redispatch routing through the original project context after config reload until the flow completes.",
      "proofHint": "Show worker retry and reviewer redispatch validation that uses original active/review states and original state buckets after reload."
    }
  ]
}
```

### REQ-392-APPROVAL-WRITEBACK - Approval Recovery And Writeback Buckets

**Purpose**: Own approved, rejected, stale, and expired publication approval recovery after config reload.

**Authorized Surfaces**:

- `src/core/CompletionReportService.ts`
- `src/core/approval/OperatorApprovalService.ts`
- `src/core/writeback/WritebackOutbox.ts`
- `src/core/orchestrator/Orchestrator.ts`
- Focused tests for approval recovery and writeback routing.

**Requirement Template**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-14.1",
  "requirements": [
    {
      "id": "REQ-392-APPROVAL-WRITEBACK",
      "requirement": "Preserve the request project context and writeback state bucket for approved, rejected, stale, and expired publication approval outcomes after config reload.",
      "proofHint": "Show per-context outbox/writeback evidence and focused approval recovery validation."
    }
  ]
}
```

### REQ-392-PUBLICATION-HYGIENE - Publication Surface And Debug Artifact Hygiene

**Purpose**: Ensure final publication candidates contain only authorized surfaces and no orphaned debug artifacts.

**Authorized Surfaces**:

- Contract-to-surface evidence.
- Redacted fixture files only when referenced by tests.
- Removal of transient debug captures.

**Requirement Template**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-14.1",
  "requirements": [
    {
      "id": "REQ-392-PUBLICATION-HYGIENE",
      "requirement": "Ensure every publication candidate maps changed surfaces to the active contract and contains no orphaned debug/runtime captures.",
      "proofHint": "Attach git diff name/status, git diff stat, and fixture/redaction notes."
    }
  ]
}
```

## Dependency Order

```text
REQ-392-DECISION
  -> REQ-392-RUNTIME-ROUTING
  -> REQ-392-RELOAD-PRESERVATION
  -> REQ-392-APPROVAL-WRITEBACK
  -> REQ-392-TEST-PROOF
  -> REQ-392-PUBLICATION-HYGIENE
```

The order may be shortened when a prerequisite is proven already satisfied on current base. The test-proof child must not be accepted while it depends on unpublished or out-of-contract runtime behavior.
