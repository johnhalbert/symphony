# Contract: Publication Surface Gate

## Purpose

Prevent a repeat of the ENG-392 review failure where the active publication candidate exceeded the test-only issue contract.

## Gate Inputs

- Active child issue contract, including `requirements` and authorized surfaces.
- Publication candidate diff from the current merge base.
- Validation evidence for the child contract.
- Debug artifact disposition notes.

## Required Checks

1. Every changed file or generated artifact must map to at least one requirement in the active child contract.
2. Runtime/source files must not appear in a test-proof candidate unless the active contract explicitly authorizes runtime behavior.
3. Status, workspace, cursor/editor, approval, and writeback surfaces require explicit child-contract authorization.
4. Temporary debug captures must be absent unless they are intentional redacted fixtures referenced by tests.
5. Evidence must identify any intentionally unverified live Linear or GitHub effects.
6. The candidate must not modify vendored upstream source.

## Surface Comparison Format

```text
Active contract: <child issue id and requirement ids>
Merge base: <sha or branch reference>

Changed surface | Authorizing requirement | Validation evidence
--------------- | ----------------------- | -------------------
tests/orchestrator.test.ts | REQ-392-TEST-PROOF | focused orchestrator route/reload run
src/core/orchestrator/Orchestrator.ts | REQ-392-RUNTIME-ROUTING | runtime routing focused test

Unmapped surfaces:
- None

Debug artifact disposition:
- None present
```

## Pass Criteria

- `Unmapped surfaces` is empty.
- Debug artifacts are absent or deliberately converted fixtures.
- Validation evidence covers the active contract's requirements.
- No secret values or unnecessary local absolute paths appear in the evidence.

## Fail Criteria

- Any changed surface lacks an authorizing requirement.
- A test-proof candidate depends on runtime behavior that is not already merged, proven on base, or represented by a dependency child.
- Orphaned debug captures are present.
- Evidence relies on unredacted local paths, credentials, or secret-backed configuration.
