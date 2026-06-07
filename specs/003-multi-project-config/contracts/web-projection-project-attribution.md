# Contract: Web Projection Project Attribution

## Purpose

Make active and historical operator views distinguish records from different project contexts, including when Linear issue identifiers collide.

## Projection Model Additions

Board cards, issue details, run/session rows, transcript prelude messages, workspace records, approval records, writeback rows, provider gates, and activity entries SHOULD expose:

```json
{
  "projectContext": {
    "id": "symphony",
    "label": "Symphony",
    "linearProject": "ENG",
    "codebase": "johnhalbert/symphony"
  }
}
```

Fields are display metadata only and must not include secret values.

## Alias Rules

- A bare issue identifier such as `ENG-123` may be accepted only when it maps to one record in the current view or compatibility mode.
- Context-qualified aliases are authoritative, for example `symphony:ENG-123`.
- Workspace keys and run aliases must include or resolve through `projectContextId`.
- Historical records without context metadata are attributed to the default or legacy context.

## Filtering Rules

Operator-facing reads MAY support a project context filter:

- no filter: return aggregate cross-project view with visible context labels
- `projectContextId=<id>`: return only matching context records
- unknown context id: return a safe not-found or validation error

## Projection Scope Rules

- Existing global scopes may remain as aggregate views.
- Project-scoped views should use context-aware scope keys.
- Transcript projections remain run-scoped but include project attribution in prelude and source metadata.
- Projection source indexes must include context id when building aliases from issue id, issue identifier, workspace key, or run metadata.

## Collision Requirements

When two contexts contain the same issue identifier:

- board and history rows must remain distinct
- links must route to the correct context-bound issue detail
- workspace opening must target the correct context-bound workspace
- transcript reads must target the correct context-bound run
- writeback and approval views must not merge records across contexts
