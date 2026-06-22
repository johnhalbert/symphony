# Research: ENG-393 Workspace Collision Disambiguation

## Decision: Exact issue identity is the workspace discriminator

**Rationale**: Visible identifiers can duplicate across Linear projects. Workspace keys, paths, summaries, and cleanup need exact issue identity plus project context to avoid cross-project reuse.

**Alternatives considered**:

- Continue using visible issue identifier alone. Rejected because it caused the class of collisions under review.
- Use only project context id. Rejected because multiple issues in the same context still need distinct workspaces.

## Decision: Branch fallback must include context-sensitive issue inputs

**Rationale**: Tracker branch metadata may be null. A fallback branch derived from visible identifier alone can collide across contexts or after branch-template changes.

**Alternatives considered**:

- Require tracker branch metadata for all issues. Rejected because null metadata is a real supported condition.
- Append a random suffix. Rejected because replay and diagnosis need deterministic branch naming.

## Decision: Branch safety cache keys must include issue identity or be removed

**Rationale**: Review found a cache can be primed by one issue and then incorrectly reused for another issue. Safety decisions are only valid for the template, context, issue identity, and candidate branch that produced them.

**Alternatives considered**:

- Keep the existing cache and add comments. Rejected because the bug is behavioral.
- Disable all caching globally. Acceptable only if the implementation stays simple and performance remains local; otherwise key the cache by full safety input.

## Decision: Legacy artifacts read through compatibility rules

**Rationale**: Existing workspaces and summaries may use older names or reserved prefixes. Operators still need historical readability, but legacy names must not block new context-safe workspaces.

**Alternatives considered**:

- Eagerly rename every legacy artifact. Rejected because it mutates operator-controlled state and creates rollback risk.
- Ignore legacy artifacts. Rejected because historical workspaces and summaries remain part of Symphony diagnosis.

## Decision: Validation must prime unsafe orderings

**Rationale**: The latest review finding depends on order: one contextual issue primes a safety result and a later duplicate-context issue misuses it. Tests must intentionally reproduce the unsafe order.

**Alternatives considered**:

- Only test two simultaneous duplicate workspaces. Rejected because it may miss the cached safety poisoning path.
