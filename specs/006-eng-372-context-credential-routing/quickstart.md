# ENG-372 routing validation matrix quickstart

Use this guide to capture deterministic validation evidence for ENG-372 child issues that cover credential routing, live tracker routing, redacted route evidence, identifier fallback, and issue-contract lint coverage.

## Requirement-to-validation matrix

| Requirement ID | Validation task | Primary evidence |
| --- | --- | --- |
| REQ-ENG372C-001 | Prove distinct worker tracker credentials and live tracker routing across Symphony and docs contexts. | `tests/linear.test.ts`, `tests/status-api.test.ts` |
| REQ-ENG372C-002 | Verify redacted `routeEvidence` for resolved, ambiguous, missing, wrong-context, and `credential_unavailable` outcomes from orchestrator and status routes. | `tests/orchestrator.test.ts`, `tests/status-api.test.ts` |
| REQ-ENG372C-003 | Keep ENG-372 child contract examples lintable and mapped to stable requirement IDs. | `tests/issue-contract-lint.test.ts`, contract examples, this quickstart |

## Required validation commands

```bash
npm test -- tests/linear.test.ts tests/orchestrator.test.ts tests/status-api.test.ts tests/workspace.test.ts
npm test -- tests/issue-contract-lint.test.ts
```

## Route matrix to exercise

| Route | Context | Expected routeEvidence status | Key evidence notes |
| --- | --- | --- | --- |
| `/api/v1/issues/docs:ENG-179/planning-run` | docs | `resolved` or `credential_unavailable` | Proves context-qualified worker tracker routing and candidate fallback. |
| `/api/v1/issues/docs:ENG-179/planning-run/apply` | docs | `resolved`, `wrong_context`, or `credential_unavailable` | Proves apply routing stays fail-closed when the resolved context does not match or lacks credentials. |
| `/api/v1/issues/ENG-179/open-workspace` | default alias | `ambiguous` | Proves bare aliases do not cross project-context boundaries. |
| `/api/v1/issues/docs:ENG-179/open-workspace` | docs | `resolved` or `missing` | Proves qualified workspace fallback preserves the requested context. |

## Route evidence fields

Every recorded `routeEvidence` payload should document:

- `kind`
- `requestKey`
- `requestAlias`
- `requestedProjectContextId`
- `resolvedProjectContextId`
- `lookupKey`
- `sources`
- `status`
- `reason`
- `redacted`

Expected statuses include `resolved`, `ambiguous`, `missing`, `wrong_context`, and `credential_unavailable`.

## Redaction rules

- Never emit tokens, private keys, raw profile values, or raw environment values.
- Replace any operator-facing secret excerpt with `[REDACTED]`.
- Keep `reason` values stable and secret-free.
- Preserve only routing metadata such as context IDs, lookup keys, source categories, and redaction markers.

## Example redacted evidence snippet

```json
{
  "routeEvidence": {
    "kind": "issue_breakdown",
    "requestKey": "docs:ENG-179",
    "requestAlias": "ENG-179",
    "requestedProjectContextId": "docs",
    "resolvedProjectContextId": "docs",
    "lookupKey": "issue-docs-179",
    "sources": ["tracker_direct", "tracker_candidate"],
    "status": "credential_unavailable",
    "reason": "resolved_project_context_tracker_unavailable",
    "redacted": true
  },
  "operatorNote": "Rejected raw secret sample: [REDACTED]"
}
```

## Contract-example maintenance

- Keep the fenced examples in `specs/006-eng-372-context-credential-routing/contracts/live-tracker-routing.md` aligned with the stable requirement IDs above.
- When a validation task changes, update the matching requirement row in this quickstart and the matching child-contract example together.
