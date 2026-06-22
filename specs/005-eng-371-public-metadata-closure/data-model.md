# Data Model: ENG-371 Public Metadata Redaction Closure

## ProjectContextPrivateConfig

Operator-authored or normalized project-context configuration before redaction.

**Fields**:

- `id`: Stable context identifier.
- `label`: Optional operator-facing label.
- `tracker`: Tracker settings and credential references.
- `workspace`: Workspace source, repository, branch, and cleanup settings.
- `github`: Publication and review settings.
- `credentialProfiles`: Capability-to-profile assignments.

**Validation Rules**:

- Raw secret-bearing values are allowed only in private runtime configuration paths that already permit them.
- Public metadata creation must never return raw values from secret-bearing fields.

## PublicProjectContextMetadata

The safe metadata shape allowed in prompts, logs, summaries, transcripts, projections, and issue comments.

**Fields**:

- `id`: Context identifier.
- `label`: Display label when non-secret.
- `trackerSummary`: Non-secret tracker identity such as project slug or label.
- `codebaseSummary`: Non-secret repository or workspace summary.
- `capabilities`: Capability names or profile labels without profile contents.
- `redactions`: Optional safe indicators that values were omitted.

**Validation Rules**:

- Must omit tokens, private keys, environment values, credential profile contents, and repository credentials.
- Must preserve enough non-secret identity for operator diagnosis.

## RepositoryPublicSummary

Redacted summary of repository or source location.

**Fields**:

- `kind`: Source kind.
- `display`: Safe display value.
- `redacted`: Whether potentially sensitive material was removed.
- `reason`: Safe redaction reason when useful.

**Validation Rules**:

- User-info, query, fragment, and credential-like path components must not leak.
- Ambiguous values redact or omit sensitive portions.

## RedactionFixtureCase

Synthetic validation case used to prove public metadata safety.

**Fields**:

- `name`: Stable fixture name.
- `privateInput`: Synthetic secret-bearing input.
- `expectedPublicOutput`: Safe output expectation.
- `forbiddenSubstrings`: Values that must not appear.

**Validation Rules**:

- Must use synthetic secrets only.
- Must cover direct helper and normalized configuration paths.

## MergeGateClosureEvidence

Evidence attached to ENG-371 or its child issue when the current blocker is repaired.

**Fields**:

- `baseRevision`: Base branch or merge-gate revision.
- `changeClassification`: `conflict_only`, `redaction_fix`, or `mixed`.
- `validationCommands`: Commands run.
- `resultSummary`: Redacted pass/fail summary.

**Validation Rules**:

- Must distinguish behavior changes from conflict-only repair.
- Must not include secrets or raw workflow values.
