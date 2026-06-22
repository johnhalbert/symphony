# Contract: ENG-2479 Child Issue Bodies

This contract defines the Linear-ready child issue descriptions to be produced by the Spec Kit task flow. It does not create live Linear issues.

## Shared Requirements

Every prepared body must include:

- Intended parent: `ENG-2479`
- Intended blocker relation: child blocks `ENG-2479` until complete
- Engineering team, Symphony project, high priority, dogfood labels, and Sinfonista delegation as sync metadata
- Exactly one fenced JSON Issue Contract
- Source context from `ENG-2479 -> ENG-392 -> ENG-351 -> ENG-347`
- Explicit out-of-scope boundaries for runtime implementation, lifecycle state changes, publication, merge, protected branches, and `hermes/upstream-src/**`

## Dependency Order

```text
T033A Proof Matrix
  -> T033B Execution Path
  -> T033C Focused Preflight Evidence
  -> T033D Parent Review Handoff
```

`T033C` also depends directly on `T033A`.

## T033A - Define Runtime Child Preflight Proof Matrix

**Purpose**: Own the hidden proof matrix that made ENG-2479 under-specified.

**Intended relations after issue-sync**:

- Parent: `ENG-2479`
- Blocks: `ENG-2479`, T033B, T033C
- Blocked by: none

**Issue Contract**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-16.1",
  "requirements": [
    {
      "id": "REQ-2479-MATRIX",
      "requirement": "Define the focused runtime child preflight proof matrix for ENG-2479, including the planned runtime child contract families, authoritative fallback sources, and required evidence fields.",
      "proofHint": "Show REQ-392-RUNTIME-ROUTING, REQ-392-RELOAD-PRESERVATION, and REQ-392-APPROVAL-WRITEBACK, plus the fallback source order when worker workspaces lack spec.md, plan.md, or tasks.md."
    },
    {
      "id": "REQ-2479-MATRIX-BOUNDARY",
      "requirement": "Record that the proof matrix does not authorize runtime implementation, publication, protected branch updates, or vendored upstream changes.",
      "proofHint": "Show the explicit out-of-scope boundary and the child issue dependencies that must own later execution or evidence work."
    }
  ]
}
```

## T033B - Define Service-Owned Preflight Execution Path

**Purpose**: Own the route for producing focused preflight output without relying on denied restricted worker/reviewer package-command execution.

**Intended relations after issue-sync**:

- Parent: `ENG-2479`
- Blocks: `ENG-2479`, T033C
- Blocked by: T033A

**Issue Contract**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-16.1",
  "requirements": [
    {
      "id": "REQ-2479-EXEC-PATH",
      "requirement": "Identify and document an approved execution path for the ENG-2479 focused runtime child contract preflight and where its output must be captured for lifecycle-bound evidence.",
      "proofHint": "Show the approved service-owned validation route or unrestricted executor, the artifact location, and how workers reference the result."
    },
    {
      "id": "REQ-2479-EXEC-POLICY",
      "requirement": "Record why restricted worker/reviewer direct command execution is not the evidence path for ENG-2479 and how the approved path prevents another blocked retry loop.",
      "proofHint": "Cite the ENG-2479 command-policy blocker and confirm the path does not rely on denied worker/reviewer package-command execution."
    }
  ]
}
```

## T033C - Capture Focused Runtime Child Preflight Evidence

**Purpose**: Own the exact focused preflight result or concrete findings for the planned runtime child contracts.

**Intended relations after issue-sync**:

- Parent: `ENG-2479`
- Blocks: `ENG-2479`, T033D
- Blocked by: T033A, T033B

**Issue Contract**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-16.1",
  "requirements": [
    {
      "id": "REQ-2479-PREFLIGHT-EVIDENCE",
      "requirement": "Run or attach the ENG-2479 focused runtime child contract preflight through the approved path and record the exact command, outcome status, and coverage signal for each planned runtime child contract family.",
      "proofHint": "Use the required command string npm test -- tests/issue-contract-lint.test.ts; show exit status or failure findings for REQ-392-RUNTIME-ROUTING, REQ-392-RELOAD-PRESERVATION, and REQ-392-APPROVAL-WRITEBACK."
    },
    {
      "id": "REQ-2479-PREFLIGHT-REDACTION",
      "requirement": "Ensure the preflight evidence is lifecycle-bound, redacted, and does not claim success from broad public validation alone.",
      "proofHint": "Show the attached or summarized result, note whether public CI was broad-only, and confirm no secret values or unnecessary local absolute paths are included."
    }
  ]
}
```

## T033D - Publish Parent Review-Unblock Evidence

**Purpose**: Own the handoff back to ENG-2479 after prerequisite evidence exists.

**Intended relations after issue-sync**:

- Parent: `ENG-2479`
- Blocks: `ENG-2479`
- Blocked by: T033C

**Issue Contract**:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-16.1",
  "requirements": [
    {
      "id": "REQ-2479-REVIEW-HANDOFF",
      "requirement": "Record a parent-facing ENG-2479 review-unblock summary that links the proof matrix, approved execution path, focused preflight evidence, and remaining review action.",
      "proofHint": "Show links or identifiers for the completed child evidence and identify the reviewer gate this evidence is intended to supersede."
    },
    {
      "id": "REQ-2479-UNVERIFIED-EFFECTS",
      "requirement": "List any intentionally unverified live Linear, GitHub, publication, or merge effects and confirm no lifecycle state was changed outside the service-owned path.",
      "proofHint": "Show a redacted parent comment or completion artifact that separates verified focused preflight evidence from unverified live effects."
    }
  ]
}
```
