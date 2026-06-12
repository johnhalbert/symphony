# ENG-450 T095 Focused Config And Doctor Validation

Captured on `2026-06-11T16:12:02Z` for branch `sinfonista/eng-450-t095-run-focused-config-and-doctor-validation`.

## Purpose

Record the focused validation required by ENG-450 / `REQ-T095`:

- run `npm test -- tests/workflow.test.ts tests/doctor.test.ts`
- capture durable evidence for multi-project configuration loading, safe validation errors, doctor redaction behavior, and normalization performance coverage

## Scenario Matrix Covered

- **Happy path / compatibility**: valid multi-context loading plus legacy single-project compatibility remain covered.
- **Negative / error path**: duplicate normalized project-context ids and enabled-context validation failures remain covered with redacted/safe error reporting.
- **Boundary / performance**: three configured project contexts still normalize within the performance budget without network calls.
- **Security / redaction**: doctor summaries still avoid leaking secret values and still mark omitted workspace source fields as unconfigured instead of fabricating values.
- **Adjacent / sibling surfaces**: workflow normalization and doctor summaries were both exercised by the focused suite so the shared project-context invariants remain covered across config parsing and operator-facing checks.
- **Intentionally out of scope**: broader orchestration, workspace, MCP, projection, and full-repository validation tasks belong to ENG-450 follow-on tasks `T096` through `T105`.

## Validation Command

```text
$ npm test -- tests/workflow.test.ts tests/doctor.test.ts
> symphony@0.1.0 test
> vitest run --no-file-parallelism tests/workflow.test.ts tests/doctor.test.ts

RUN  v4.1.5 C:/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-450

Test Files  2 passed (2)
Tests       111 passed (111)
Duration    2.54s
# exit 0
```

## Coverage Pointers

### Workflow validation (`tests/workflow.test.ts`)

- `2329` — `normalizes legacy single-project workflows without project_contexts into one default context`
- `2361` — `normalizes project context ids into safe workflow identifiers`
- `2690` — `normalizes three configured project contexts within the performance budget without network calls`
- `985` / `1044` / `1134` — duplicate normalized project-context id reload failures stay redacted and explicit

### Doctor validation (`tests/doctor.test.ts`)

- `368` — `summarizes configured project contexts without leaking secret values`
- `496` — `treats omitted workspace source fields as unconfigured in doctor summaries`
- `563` — `surfaces context-specific enabled project context validation errors through doctor parse checks`

## Reviewer Notes

- The live Symphony status API for `GET /api/v1/issues/ENG-450` exposed the issue title `T095 Run focused config and doctor validation`, the fenced JSON Issue Contract containing `REQ-T095`, labels `dogfood-ready` and `dogfood`, and zero open blockers at validation time.
- This issue is validation-only. No production code changes were required; this document is the durable evidence artifact for the focused validation run.
