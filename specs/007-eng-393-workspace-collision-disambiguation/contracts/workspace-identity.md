# Contract: Workspace Identity

## Purpose

Ensure Symphony never uses visible issue identifier alone to create, find, open, resume, summarize, or clean up workspaces when project contexts can overlap.

## Identity Rule

Workspace identity MUST be derived from:

- project context id
- canonical tracker issue identity when available
- visible issue identifier for display only
- repository/source identity
- workspace policy

## Required Operations

The identity contract applies to:

- workspace creation
- workspace reuse
- workspace open/status actions
- run resume
- continuation summary lookup
- status pointer lookup
- cleanup
- projection aliases that refer to a workspace

## Failure Behavior

If a request cannot resolve to one exact workspace:

- do not pick by visible identifier order
- do not reuse an unrelated workspace
- do not delete possible siblings
- return or record a redacted ambiguous-identity result

## Child Issue Contract Seed

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-WS-001",
      "requirement": "Workspace keys, paths, lookup, readback, and cleanup must be scoped by exact issue identity and project context.",
      "proofHint": "Show duplicate visible identifiers across contexts remain distinct."
    }
  ]
}
```
