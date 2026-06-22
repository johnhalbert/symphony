# Contract: Branch Fallback Safety

## Purpose

Ensure branch fallback remains collision-safe when tracker branch metadata is null or missing.

## Safety Input

A branch safety decision MUST be scoped to:

- project context id
- canonical tracker issue identity
- visible issue identifier
- repository/source identity
- branch template
- tracker branch metadata value, including null
- candidate branch name

## Required Behavior

1. If tracker branch metadata is present and safe, it may be used.
2. If tracker branch metadata is null or unsafe, derive a deterministic context-safe fallback.
3. If a branch template produces a collision, reject it for that issue and use a safe alternative.
4. A safety result for one issue must not be reused for a different issue unless all safety inputs match.

## Forbidden Behavior

- Do not cache branch-template safety by template alone.
- Do not treat null tracker branch metadata as a shared safe result.
- Do not derive fallback from visible identifier alone when contexts can overlap.

## Child Issue Contract Seed

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-BRANCH-001",
      "requirement": "Branch fallback and branch-template safety decisions must be scoped to the exact issue identity and project context.",
      "proofHint": "Prime safety with one context issue, then prove a duplicate-context issue still receives a safe branch."
    }
  ]
}
```
