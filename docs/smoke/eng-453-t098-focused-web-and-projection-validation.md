# ENG-453 T098 Focused Web And Projection Validation

Captured on `2026-07-07T06:54:10Z` for branch `sinfonista/eng-453-t098-run-focused-web-and-projection-validation`.

## Purpose

Record the focused validation required by ENG-453 / `REQ-T098`:

- run `npm test -- tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts`
- capture durable evidence that operator views, filters, aliases, routes, and status responses preserve project attribution, including duplicate issue identifier and legacy/default attribution coverage

## Scenario Matrix Covered

- **Happy path / operator views**: durable status API and web projection surfaces still return project-attributed dashboard, issue-board, issue-detail, history, sidebar, and transcript views.
- **Negative / ambiguity path**: ambiguous duplicate identifiers and ambiguous legacy aliases still fail closed while context-qualified lookups continue to resolve.
- **Sibling / duplicate path**: same visible issue identifiers across project contexts still retain exact-id routing, attribution, and alias separation instead of collapsing sibling records.
- **Legacy / compatibility path**: legacy default-context records, unqualified aliases, and historical runs still project compatible project attribution without losing context-aware behavior.
- **Boundary / integration path**: focused route-contract, history-projection, transcript-projection, and projection-context tests exercise operator-facing API contracts together instead of only isolated helpers.
- **Status / response path**: status API and transcript projection coverage continues to surface attribution-safe public status messages and route metadata.
- **Intentionally out of scope**: orchestration, worktree, MCP/harness, approval/publication, database/full-repository, quickstart, typecheck, and broader end-to-end validation remain covered by adjacent tasks outside T098.

## Validation Command

```text
$ npm test -- tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts
> symphony@0.1.0 test
> vitest run --no-file-parallelism tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts

RUN  v4.1.5 C:/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-453

✓ tests/status-api.test.ts (70 tests) 10054ms
    ✓ serves a redacted globally sorted activity feed from persisted transcripts  3888ms
    ✓ derives terminal activity from transcript events when activitySnapshot is absent  3814ms
✓ tests/web-route-contract.test.ts (39 tests) 699ms
✓ tests/web-transcript-projection.test.ts (33 tests) 54ms
✓ tests/web-projection.test.ts (31 tests) 42ms
✓ tests/web-projection-context.test.ts (13 tests) 49ms
✓ tests/web-history-projection.test.ts (13 tests) 14ms

Test Files  6 passed (6)
Tests       199 passed (199)
Start at    01:50:37
Duration    14.15s
# exit 0
```

## Coverage Pointers

### Status API operator views, filters, aliases, duplicate identifiers, and legacy/default attribution (`tests/status-api.test.ts`)

- `545` — `resolves exact-id status lookups by lifecycle project context when visible identifiers collide`
- `2709` — `surfaces legacy/default project context attribution across durable status records`
- `2934` — `resolves legacy unqualified status and transcript aliases through the configured default project context`
- `6399` — `accepts context-qualified activity filters and project context filters while rejecting ambiguous duplicate identifiers and emitting exact-id activity links`

### Web route contracts and alias safety (`tests/web-route-contract.test.ts`)

- `62` — `serves the frontend GET route matrix with stable JSON top-level contracts`
- `1841` — `resolves legacy web transcript aliases through the compatibility default context`
- `1888` — `fails closed for ambiguous legacy web transcript aliases while qualified aliases still resolve`
- `2019` — `resolves context-qualified issue, run, workspace, transcript, and approval routes safely across project-context siblings`

### Web issue-board/detail projection attribution (`tests/web-projection.test.ts`)

- `548` — `projects project attribution for duplicate issue identifiers on the React issue board`
- `866` — `projects legacy default tracker attribution onto board and detail issues without changing blank project labels or unqualified ids`

### Web history projection filters and public attribution (`tests/web-history-projection.test.ts`)

- `56` — `projects public project context attribution for explicit and historical runs`
- `94` — `filters sessions and timeline to matching project context records`

### Web transcript projection status and legacy/default compatibility (`tests/web-transcript-projection.test.ts`)

- `667` — `adds service-owned project context attribution to projected system and status messages`
- `1636` — `preserves legacy default context attribution while omitting local repo paths`

### Web projection context alias generation (`tests/web-projection-context.test.ts`)

- `405` — `adds context-qualified source aliases when duplicate identifiers appear across project contexts`
- `524` — `keeps shared raw issue aliases scoped to the configured default project context when non-default siblings also have contextual aliases`

## Reviewer Notes

- This issue is validation-only. No production code changes were required; this document is the durable evidence artifact needed to make the focused validation committable in the assigned worktree.
- The focused command was run unchanged from the ENG-453 issue packet.
- Before writing this document, `git status --short` returned no modified files, confirming the assigned worktree was otherwise clean after the validation command.
