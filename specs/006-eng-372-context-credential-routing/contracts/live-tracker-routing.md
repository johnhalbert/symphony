# ENG-372 child contract examples — live tracker routing

These fenced examples are issue-authoring references for the ENG-372 child issues that validate credential routing, route-evidence redaction, and issue-contract lint coverage.

## Example A — Credential routing matrix

````markdown
# ENG-372C Example A — Credential routing matrix

## Problem / Goal
Validate the worker tracker credential routing matrix across the Symphony and docs project contexts with distinct credentials, and prove live tracker routing through both direct ID lookup and candidate-identifier fallback.

## Touched Surfaces
- `tests/linear.test.ts`
- `tests/status-api.test.ts`

## Expected Surfaces
* tests/linear.test.ts
* tests/status-api.test.ts

## Acceptance Criteria
- Worker tracker validation proves distinct credential selection across Symphony and docs contexts.
- Live tracker routing proves both direct lookup and candidate-identifier fallback in project-context-aware flows.

## Issue Contract
```json
{"schemaVersion":1,"contractVersion":"2026-06-11.1","requirements":[{"id":"REQ-ENG372C-001","requirement":"Validation must prove the full credential and live tracker routing matrix across at least two project contexts with distinct credentials.","proofHint":"Show end-to-end matrix coverage in Linear/tracker tests."}]}
```

## Contract Checklist
- [ ] REQ-ENG372C-001 — Distinct worker tracker credentials and live tracker routing are proven across at least two project contexts.

## Validation Requirements
* npm test -- tests/linear.test.ts tests/status-api.test.ts

## Out Of Scope
- Introducing new credential capabilities beyond tracker routing.
- Adding operator-only documentation outside the routing quickstart.

## Promotion Readiness
- Ready for dogfood-ready promotion: Yes
````

## Example B — Redacted route evidence

````markdown
# ENG-372C Example B — Redacted route evidence

## Problem / Goal
Record resolved, ambiguous, missing, wrong-context, and credential-unavailable route evidence for issue breakdown, issue-breakdown apply, and open-workspace routing without exposing tokens, raw profile values, or environment-backed secrets.

## Touched Surfaces
- `src/core/orchestrator/Orchestrator.ts`
- `src/app/http.ts`
- `tests/orchestrator.test.ts`
- `tests/status-api.test.ts`

## Expected Surfaces
* src/core/orchestrator/Orchestrator.ts
* src/app/http.ts
* tests/orchestrator.test.ts
* tests/status-api.test.ts

## Acceptance Criteria
- Route evidence is emitted for resolved, ambiguous, missing, wrong-context, and credential-unavailable outcomes.
- Public evidence remains redacted and excludes tokens, private keys, raw profile values, and environment values.

## Issue Contract
```json
{"schemaVersion":1,"contractVersion":"2026-06-11.1","requirements":[{"id":"REQ-ENG372C-002","requirement":"Route evidence for resolved, ambiguous, missing, and credential-unavailable cases must be recorded without tokens, private keys, raw profile values, or environment values.","proofHint":"Show redacted evidence assertions and route evidence emitted from orchestrator/status paths."}]}
```

## Contract Checklist
- [ ] REQ-ENG372C-002 — Route evidence remains redacted while covering the required success and fail-closed routing outcomes.

## Validation Requirements
* npm test -- tests/orchestrator.test.ts tests/status-api.test.ts

## Out Of Scope
- Returning raw credential-profile assignments in public API payloads.
- Expanding redaction coverage beyond routing evidence for this child issue.

## Promotion Readiness
- Ready for dogfood-ready promotion: Yes
````

## Example C — Issue-contract lint coverage

````markdown
# ENG-372C Example C — Issue-contract lint coverage

## Problem / Goal
Keep the ENG-372 child contract examples lintable and map the validation tasks to stable requirement identifiers in both the contract examples and the operator quickstart.

## Touched Surfaces
- `tests/issue-contract-lint.test.ts`
- `specs/006-eng-372-context-credential-routing/contracts/live-tracker-routing.md`
- `specs/006-eng-372-context-credential-routing/quickstart.md`

## Expected Surfaces
* tests/issue-contract-lint.test.ts
* specs/006-eng-372-context-credential-routing/contracts/live-tracker-routing.md
* specs/006-eng-372-context-credential-routing/quickstart.md

## Acceptance Criteria
- ENG-372 child contract examples pass lint coverage.
- Validation tasks map cleanly to stable requirement identifiers in both contract examples and the quickstart.

## Issue Contract
```json
{"schemaVersion":1,"contractVersion":"2026-06-11.1","requirements":[{"id":"REQ-ENG372C-003","requirement":"ENG-372 child contract examples must pass issue-contract lint coverage and map validation tasks to stable requirement IDs.","proofHint":"Show issue-contract lint coverage for ENG-372 child contract examples."}]}
```

## Contract Checklist
- [ ] REQ-ENG372C-003 — Contract examples and quickstart remain lint-clean and keep stable requirement IDs in sync.

## Validation Requirements
* npm test -- tests/issue-contract-lint.test.ts

## Out Of Scope
- Adding unrelated spec-kit planning artifacts.
- Renumbering requirement identifiers for already-published ENG-372 child work.

## Promotion Readiness
- Ready for dogfood-ready promotion: Yes
````
