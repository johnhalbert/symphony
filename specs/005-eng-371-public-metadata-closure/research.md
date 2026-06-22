# Research: ENG-371 Public Metadata Redaction Closure

## Decision: Treat public project-context metadata as a single service-owned contract

**Rationale**: Review churn showed that direct helper usage and normalized configuration paths can diverge. A single public metadata contract keeps prompts, logs, summaries, transcripts, projections, and comments aligned.

**Alternatives considered**:

- Let each consumer redact independently. Rejected because it repeats the discovered review failures and makes proof incomplete.
- Expose raw normalized context and rely on reviewers to notice secret fields. Rejected by the constitution secret-hygiene rule.

## Decision: Parse repository/source values as untrusted display inputs

**Rationale**: Repository-like values may include user-info, query, fragment, pathless forms, single-label hosts, or ambiguous `@` placement. Public output must preserve useful non-secret routing hints without assuming every string is safe.

**Alternatives considered**:

- Preserve repository values verbatim. Rejected because review found credential leakage risk.
- Omit every repository/source value. Rejected because operators still need non-secret context for diagnosis.

## Decision: Redact or omit when safety cannot be determined

**Rationale**: A false positive leak is worse than losing a diagnostic hint. Ambiguous credential-like values should fail closed into a redacted summary.

**Alternatives considered**:

- Attempt best-effort string cleanup for all inputs. Rejected because query, fragment, and user-info boundaries can be subtle and brittle.
- Throw on any ambiguous value. Rejected because public metadata creation should not block unrelated safe context display.

## Decision: Separate merge-gate repair from redaction behavior

**Rationale**: ENG-371's current blocker is merge-gate conflict cleanup after review. The closure path should make any behavior change explicit; otherwise reviewers cannot distinguish conflict repair from new scope.

**Alternatives considered**:

- Restart broad implementation. Rejected because the issue already has reviewed behavior and would likely churn again.
- Close the issue without validation. Rejected because merge-gate repair still needs current-base evidence.

## Decision: Use synthetic redaction fixtures only

**Rationale**: Validation can prove redaction with fake tokens, private keys, profile values, and repository credentials. Real secrets are unnecessary and must not appear in artifacts.

**Alternatives considered**:

- Validate against local real configuration. Rejected because it risks copying secrets into test output or issue evidence.
