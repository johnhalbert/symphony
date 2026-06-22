# Research: Symphony Owned Tracker

## Decision: Keep `TrackerClient` and `TrackerWriter` as the replacement seam

**Rationale**: Core orchestration, web/status issue refresh, writeback processing, and merge-policy checks already consume tracker data through `TrackerClient` and tracker mutations through `TrackerWriter`. Reusing those contracts gives the MVP a small runtime integration surface and avoids touching worker/reviewer prompts, orchestration dispatch semantics, or projection code.

**Alternatives considered**:

- Replace Linear-specific calls throughout the orchestrator. Rejected because the core loop is already tracker-shaped and broader edits would increase regression risk.
- Introduce a new higher-level issue service before adding the native tracker. Rejected for MVP because it adds abstraction before there is a second provider implementation to validate.

## Decision: Use a provider switch at runtime construction and config parsing

**Rationale**: `RuntimeDependencies.ts` currently constructs Linear directly, and `Config.ts` currently normalizes `tracker.kind` to Linear and requires Linear credentials/project slug. A provider switch at this boundary lets Linear continue unchanged while the Symphony-owned tracker can be selected without Linear credentials.

**Alternatives considered**:

- Replace `LinearTrackerClient` in place. Rejected because existing Linear users must remain unaffected.
- Select the tracker by probing available credentials. Rejected because ambiguous credential behavior violates fail-closed configuration expectations.

## Decision: Require configured Postgres when `tracker.kind` is `symphony`

**Rationale**: The feature requires the Symphony-owned tracker to encode native `Issue` and `IssueBlockerRef` in the Symphony datastore. When the native tracker is selected, Postgres is the authority for tracker data and missing datastore configuration must fail closed before dispatch.

**Alternatives considered**:

- Fall back to file-backed issue data. Rejected because the feature explicitly targets the Symphony datastore and fallback would create a second tracker authority.
- Use projection tables as tracker storage. Rejected because projections are rebuildable read models and are explicitly out of scope.

## Decision: Add a checksum-safe follow-up migration for native tracker tables

**Rationale**: Existing migration `0002_symphony_owned_state.sql` is published and checksum-stable. The plan must not rewrite it. A new migration can preserve existing deployments while adding or revising the minimum tracker-owned schema needed for native `Issue`, `IssueBlockerRef`, comment idempotency, and transition audit.

**Alternatives considered**:

- Rewrite `0002_symphony_owned_state.sql` comments and table definitions. Rejected because existing migration checksums are published.
- Store all blocker/comment data in existing JSON snapshots. Rejected because blocker semantics, point lookups, and idempotent comments need authoritative queryable records for a tracker source of truth.

## Decision: Store native issues separately from projection behavior

**Rationale**: The user explicitly scoped out projection-layer work. The native tracker should serve runtime reads directly from authoritative tracker tables and leave current status/projection behavior unchanged except where existing runtime endpoints already ask the selected tracker for live issues.

**Alternatives considered**:

- Update issue-board projections to use native tracker storage. Rejected as scope expansion.
- Add a projection rebuild for tracker state. Rejected because dispatch and writeback must not depend on projection freshness.

## Decision: Support transitions and comments in MVP; fail closed for optional issue creation/relation creation

**Rationale**: Normal runtime replacement needs state transitions and comments. Optional issue breakdown application can request child issue creation and blocker relation creation, but the spec allows deferring those when unsupported operations are explicit and safe. This keeps the MVP tight while preserving operator safety.

**Alternatives considered**:

- Implement all `TrackerWriter` optional methods immediately. Rejected because child issue creation and relation authoring expand schema, validation, and operator UX beyond the minimum replacement path.
- Silently ignore unsupported optional writes. Rejected because silent loss violates durable audit and fail-closed behavior.

## Decision: Resolve issue refresh by durable ID and human identifier for native tracker

**Rationale**: Some runtime/operator flows accept `issueIdOrIdentifier` and call `fetchIssueStatesByIds`. Linear currently filters by ID, but the native tracker can satisfy the higher-level runtime expectation by resolving both values. Duplicate identifiers must fail closed.

**Alternatives considered**:

- Preserve ID-only lookup semantics. Rejected because it leaves existing `issueIdOrIdentifier` APIs brittle.
- Treat identifier as primary key. Rejected because durable IDs are already the lifecycle/writeback correlation key.
