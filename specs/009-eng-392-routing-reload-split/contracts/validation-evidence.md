# Contract: Validation Evidence

## Purpose

Standardize the evidence each ENG-392 child issue must provide before review or parent resolution.

## Evidence Categories

### Base-Behavior Proof

Use when current base already satisfies a child concern.

Required fields:

- Current base reference.
- Scenario being proven.
- Command or inspection evidence.
- Explanation of why no implementation is required.

### Failing-Before Evidence

Use when a child requires implementation.

Required fields:

- Scenario that fails before the change.
- Focused command or inspection result.
- Affected requirement id.
- Explicit boundary showing the failure is within the child contract.

### Passing-After Evidence

Use after implementation.

Required fields:

- Focused validation command.
- Broader validation command when shared orchestration or protected surfaces changed.
- Requirement ids satisfied.
- Remaining intentionally unverified areas.

### Surface Comparison Evidence

Use before review.

Required fields:

- Merge base.
- `git diff --name-status` output summary.
- Mapping from changed surfaces to requirement ids.
- Empty unmapped-surface list.

### Publication Hygiene Evidence

Use when debug artifacts or generated captures were created during diagnosis.

Required fields:

- Removed artifact paths, or fixture paths if converted.
- Redaction statement.
- Tests or docs that reference converted fixtures.

## Redaction Requirements

Evidence must not include:

- Credential values, tokens, private keys, or raw environment variable values.
- Secret-backed profile contents.
- Customer-private data.
- Unnecessary local absolute paths.
- Transient runtime captures unless converted into deliberate redacted fixtures.

## Recommended Local Validation Commands

```powershell
npm test -- tests/issue-contract-lint.test.ts
npm test -- tests/orchestrator.test.ts
npm run typecheck
```

Use additional focused suites only when the child contract authorizes the related surface.
