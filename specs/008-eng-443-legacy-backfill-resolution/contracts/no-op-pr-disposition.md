# Contract: No-op Pull Request Disposition

## Purpose

Prevent empty or behaviorally redundant pull requests from being promoted as implementation work for ENG-443.

## Decision Rule

Before implementation continues:

1. Compare the issue contract to current base behavior.
2. Determine whether the active pull request has a meaningful diff.
3. If base already satisfies the contract, attach evidence and choose a disposition.
4. If base does not satisfy the contract, identify the failing read path before code changes.

## Valid Dispositions

- `close`: Close the PR and resolve the issue with base-behavior evidence.
- `retarget`: Retarget the issue or PR to the actual missing work.
- `replace`: Create a new non-empty PR tied to a demonstrated failing path.
- `continue`: Continue only when the PR has a meaningful diff tied to the issue contract.

## Forbidden Behavior

- Do not merge an empty PR as proof of implementation.
- Do not continue review loops without a base-behavior decision.
- Do not create broad persistence refactors without a failing legacy-read scenario.

## Child Issue Contract Seed

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-NOOP-001",
      "requirement": "ENG-443 must classify the active pull request as no-op, retargeted, replaced, or tied to a specific failing legacy-read path before promotion.",
      "proofHint": "Attach current-base behavior evidence and PR diff disposition."
    }
  ]
}
```
