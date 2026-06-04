# Agent-Eligible Linear Issue Template

Use this template before an issue is promoted for Symphony agent dispatch. It
applies to docs-only issues and implementation issues. The fenced JSON issue
contract is mandatory and authoritative; the prose sections help humans,
workers, reviewers, and doctor lint interpret the work but do not replace the
JSON requirements.

Do not include secrets, tokens, private keys, credential values, or private customer data. Describe credential boundaries and required credential states without pasting values.

````markdown
## Problem / Goal

Describe the workflow-visible or user-visible problem and the intended outcome.

## Issue Contract

Every issue must include this fenced JSON block. Add one object to
`requirements` for each required obligation. Keep `id` values stable and unique
within the issue. Update `contractVersion` when obligations materially change.

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-04.1",
  "requirements": [
    {
      "id": "REQ-001",
      "requirement": "Concrete, reviewable obligation the worker must satisfy.",
      "proofHint": "Optional non-authoritative evidence guidance."
    }
  ]
}
```

## Touched Surfaces

Mark every surface that the issue is expected to touch.

- [ ] API/projection
- [ ] UI
- [ ] MCP/tool contract
- [ ] Runtime harness/transcript mapping
- [ ] Lifecycle/persistence/replay
- [ ] Writeback/tracker
- [ ] Publication/GitHub/merge gate
- [ ] Credentials/security
- [ ] Config/workflow prompt
- [ ] Docs only

## Acceptance Criteria

- A concrete, reviewable behavior or artifact that must exist when the issue is complete.
- Include externally visible side effects when applicable, not only internal implementation steps.

## Contract Checklist

Use this checklist as planning context for the JSON requirements and validation
plan. It is not a substitute for the fenced JSON contract.

- Happy path:
- Negative/error path:
- Adjacent sibling surface:
- Empty/missing/stale/fallback state:
- Replay/restart/idempotency:
- Credential/security boundary:
- Side-effect verification:

## Validation Requirements

- Name the smallest meaningful unit or integration tests.
- Name broader validation when shared orchestration, workflow, tracker, harness, or persistence code is touched.
- Include manual or API checks needed to verify side effects actually happened.

## Out Of Scope

- List related behavior that should not be implemented in this slice.

## Promotion Readiness

- Ready for `dogfood-ready`: yes/no
- Remaining blocker:
````

## Promotion Rules

An issue must not receive `dogfood-ready` until an operator has reviewed the
fenced JSON issue contract, completed checklist, and validation plan. If the
issue is still blocked, leave `dogfood-blocked` in place. Remove
`dogfood-blocked` and add `dogfood-ready` only after the operator confirms the
required JSON and prose sections are present, each JSON requirement has a
stable unique ID and non-empty text, the validation plan is concrete, and no
open blockers remain.

The template does not authorize automatic label changes. AI issue drafters should propose the contract and readiness recommendation, then leave promotion labels for operator review.
