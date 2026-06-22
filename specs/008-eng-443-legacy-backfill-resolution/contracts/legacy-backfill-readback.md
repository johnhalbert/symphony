# Contract: Legacy Backfill Readback

## Purpose

Ensure older run and workspace records read back with stable, non-secret project-context attribution after Symphony becomes multi-project.

## Readback Rule

When a record lacks explicit project-context metadata:

1. Preserve the original record.
2. Derive a default or legacy context attribution for the read result.
3. Include only non-secret diagnostic metadata.
4. Mark the attribution source as legacy/default.
5. Do not rewrite historical records during ordinary reads.

## Required Record Types

- legacy run records
- legacy workspace records
- transcript readback derived from legacy runs
- web/history projection rows derived from legacy records

## Child Issue Contract Seed

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-BACKFILL-001",
      "requirement": "Legacy run and workspace records without project-context metadata must read back with stable non-secret default or legacy attribution.",
      "proofHint": "Show current-main proof or failing-before/passing-after validation for both record types."
    }
  ]
}
```
