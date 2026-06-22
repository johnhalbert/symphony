# Contract: Live Tracker Routing

## Purpose

Define how Symphony chooses a Linear tracker client for live issue reads and mutation precursor checks.

## Required Entry Points

The route contract applies to:

- candidate polling
- reviewer polling
- status lookup
- open-workspace and workspace status actions
- issue-breakdown request generation
- issue-breakdown apply/writeback preparation
- lifecycle checks before tracker mutation

## Resolution Rule

1. Start with an exact issue identity when available.
2. If only a visible identifier is available, resolve it to exactly one context and canonical tracker identity.
3. Create or select the tracker client for that context.
4. Fetch live state using the tracker identity that the selected client understands.
5. Fail closed if the route is missing, ambiguous, or lacks credentials.

## Forbidden Behavior

- Do not send visible issue identifiers into APIs that expect canonical tracker ids.
- Do not use the default tracker when persisted project context exists.
- Do not query every context and pick the first match.
- Do not let an agent-provided context claim override the service-owned route.

## Child Issue Contract Seed

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-ROUTE-001",
      "requirement": "Live tracker reads must use the tracker client for the target issue's resolved project context.",
      "proofHint": "Show polling, status, workspace, and issue-breakdown paths route through non-default context credentials."
    }
  ]
}
```
