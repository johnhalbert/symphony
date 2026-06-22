# Research: ENG-372 Context Credential Routing

## Decision: Resolve credentials by context and capability before service use

**Rationale**: Context-specific multi-project operation requires each service path to know which credential profile is authorized for the target context and capability. This keeps workers from inheriting a global default by accident.

**Alternatives considered**:

- Keep one global credential profile per service. Rejected because it breaks least privilege across projects.
- Let issue text or labels choose credentials. Rejected because agent-visible issue data must not own credential selection.

## Decision: Structured profile overrides inherit safe top-level fields

**Rationale**: Review found that context-specific structured profile overrides can accidentally drop required fields. Partial overrides should inherit non-overridden required fields while still keeping secret values private.

**Alternatives considered**:

- Require each context override to restate every field. Rejected because it is error-prone and increases secret-copying risk.
- Deep-merge without validation. Rejected because it can hide missing required fields.

## Decision: Route all live tracker reads through the issue's resolved context

**Rationale**: Candidate polling, reviewer polling, status lookup, workspace actions, and issue-breakdown services all need live tracker data. If any path falls back to the default tracker, non-default projects can fail or mutate the wrong target.

**Alternatives considered**:

- Patch only the latest failing status route. Rejected because review history already showed multiple sibling paths with the same assumption.
- Instantiate one tracker and filter locally. Rejected because credentials and Linear projects differ by context.

## Decision: Identifier-only actions must resolve to canonical tracker identity first

**Rationale**: Visible identifiers are not enough in a multi-project system. Status/open-workspace mutations that receive `DOCS-1` need a context and tracker-side identity before making live state calls.

**Alternatives considered**:

- Treat visible identifier as Linear id. Rejected because Linear id and visible identifier are distinct and review found this bug.
- Query all trackers and pick the first match. Rejected because duplicate identifiers become unsafe and ordering-dependent.

## Decision: Validation must prove real routing behavior

**Rationale**: A stub can pass while the real Linear id-filtered behavior remains broken. The validation matrix needs to prove the routes and fallback behavior that caused review churn.

**Alternatives considered**:

- Rely on unit tests for helper functions only. Rejected because the failure was in integration path selection.
- Rely on manual dogfood observation only. Rejected because child issues need repeatable proof.
