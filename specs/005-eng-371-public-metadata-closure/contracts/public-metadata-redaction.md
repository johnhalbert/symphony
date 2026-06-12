# ENG-371 Public Metadata Redaction Child Contract Examples

Use these examples when drafting or reviewing ENG-371 follow-on child issues. They freeze stable requirement IDs and evidence expectations for the redaction-parity, repository-ambiguity, merge-gate-closure, and validation-evidence slices so future review can compare issue authoring against one canonical set of examples.

These are planning examples, not live issue records. Keep the requirement IDs stable if you copy an example into Linear.

## Example A — Redaction parity child issue

````markdown
## Problem / Goal

Close the remaining public-metadata gap so the same credential-bearing input redacts consistently across transcript, web projection, and status surfaces.

## Issue Contract

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-ENG371-REDACTION-PARITY-001",
      "requirement": "Public transcript, web projection, and status surfaces must emit the same redacted preview for the same credential-bearing input.",
      "proofHint": "Run the focused projection tests and cite the public-safe preview fields instead of raw payload text."
    }
  ]
}
```

## Touched Surfaces

- [X] API/projection
- [X] Runtime harness/transcript mapping
- src/app/WebTranscriptProjection.ts
- src/app/WebTranscriptProjectionCore.ts
- src/app/http.ts
- tests/web-transcript-projection-command-policy.test.ts

## Acceptance Criteria

- The same transcript event produces matching redacted preview text across every public metadata surface.
- Validation cites only sanitized preview fields.

## Contract Checklist

- Happy path: a redacted preview is present on every public surface.
- Negative/error path: missing preview text still returns a safe empty or omitted preview.
- Adjacent sibling surface: command-policy public output stays aligned with transcript projection behavior.
- Empty/missing/stale/fallback state: replayed historical events still flow through the same public sanitizers.
- Replay/restart/idempotency: rerendering the same event keeps the same redacted preview.
- Credential/security boundary: no raw token, private key, or credential-bearing URL appears in the cited evidence.
- Side-effect verification: inspect the public API payloads instead of inferring behavior from helper names.

## Validation Requirements

- npm test -- tests/web-transcript-projection-command-policy.test.ts
- GET /api/v1/runs/<runId>/transcript?offset=0&limit=200

## Out Of Scope

- Rewriting operator-only private logs.
- Adding new credential detectors outside the public metadata surfaces in scope.

## Promotion Readiness

- Ready for `dogfood-ready`: yes
- Remaining blocker: none
````

## Example B — Repository ambiguity child issue

````markdown
## Problem / Goal

Remove ambiguity from repository-facing public metadata so operator and reviewer views never require guessing whether a repository path, remote, or URL was omitted, sanitized, or unavailable.

## Issue Contract

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-ENG371-REPOSITORY-AMBIGUITY-001",
      "requirement": "Public metadata must distinguish configured-versus-omitted repository fields without leaking credential-bearing URLs or resolved secret values.",
      "proofHint": "Use status or doctor output that shows configured booleans and sanitized repository metadata only."
    }
  ]
}
```

## Touched Surfaces

- [X] API/projection
- [X] Credentials/security
- src/app/http.ts
- tests/project-contexts.test.ts

## Acceptance Criteria

- Public metadata reports whether repository configuration is present without echoing embedded credentials.
- Validation points to safe booleans or sanitized fields instead of printing raw repository URLs.

## Contract Checklist

- Happy path: configured repository metadata renders as safe public fields.
- Negative/error path: missing repository config remains explicit instead of fabricating values.
- Adjacent sibling surface: doctor summaries and issue-status API stay aligned on configured-versus-omitted state.
- Empty/missing/stale/fallback state: legacy single-project config still reports safe defaults.
- Replay/restart/idempotency: repeated reads keep the same sanitized metadata.
- Credential/security boundary: no embedded credentials, tokens, or env values appear in public evidence.
- Side-effect verification: verify the public API or doctor summary, not internal configuration structs.

## Validation Requirements

- npm test -- tests/project-contexts.test.ts tests/doctor.test.ts
- GET /api/v1/issues/<issue-identifier>

## Out Of Scope

- Changing the underlying credential-profile resolver.
- Expanding repository discovery beyond the public metadata fields under review.

## Promotion Readiness

- Ready for `dogfood-ready`: yes
- Remaining blocker: none
````

## Example C — Merge-gate closure child issue

````markdown
## Problem / Goal

Make the lifecycle-bound completion handoff evidence explicit enough that reviewers can tell whether merge-gate closure conditions were satisfied without re-reading internal implementation details.

## Issue Contract

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-ENG371-MERGE-GATE-CLOSURE-001",
      "requirement": "Public handoff metadata must let reviewers correlate the accepted completion report, worker run, and merge-gate closure state using public-safe identifiers only.",
      "proofHint": "Cite reviewLoop or lifecycle metadata plus the worker run status and terminal reason from the status API."
    }
  ]
}
```

## Touched Surfaces

- [X] Lifecycle/persistence/replay
- [X] Publication/GitHub/merge gate
- src/core/CompletionReportService.ts
- src/app/http.ts
- tests/completion-report-service.test.ts
- tests/status-api.test.ts

## Acceptance Criteria

- Reviewers can trace the accepted completion report and worker run from public-safe lifecycle fields.
- Validation evidence cites public metadata such as run ids, status, and terminal reason instead of private logs.

## Contract Checklist

- Happy path: accepted completion handoff exposes the expected public-safe identifiers.
- Negative/error path: incomplete or rejected handoffs stay distinguishable from successful closure.
- Adjacent sibling surface: status API and run detail views agree on the worker handoff identity.
- Empty/missing/stale/fallback state: issues with no accepted completion report remain explicit.
- Replay/restart/idempotency: repeated completion-report replays do not create ambiguous public metadata.
- Credential/security boundary: GitHub publication and review evidence remain summarized without secret material.
- Side-effect verification: inspect lifecycle or run responses rather than assuming a publish step occurred.

## Validation Requirements

- npm test -- tests/completion-report-service.test.ts tests/status-api.test.ts
- GET /api/v1/issues/<issue-identifier>
- GET /api/v1/runs/<handoffWorkerRunId>

## Out Of Scope

- Automatic merge execution.
- Reviewer-owned GitHub review feedback flows.

## Promotion Readiness

- Ready for `dogfood-ready`: yes
- Remaining blocker: none
````

## Example D — Validation evidence follow-up (protected docs)

````markdown
## Problem / Goal

Document the redaction-promotion evidence packet so manual reviewers can verify protected-surface and secret-hygiene checks without rediscovering the expected commands or safe fields.

## Issue Contract

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-ENG371-VALIDATION-EVIDENCE-001",
      "requirement": "The validation evidence packet must list the focused test command, the vendored-Hermes no-touch commands, and the public-safe issue/run/transcript fields to cite without pasting credential values.",
      "proofHint": "Keep the issue manual-only because it touches protected workflow documentation and capture the operator blocker explicitly."
    }
  ]
}
```

## Touched Surfaces

- [X] Docs only
- [X] Credentials/security
- docs/dogfood-runbook.md
- specs/005-eng-371-public-metadata-closure/quickstart.md

## Acceptance Criteria

- The evidence instructions identify the exact commands and public-safe fields reviewers should cite.
- The instructions tell reviewers to stop if credential values, private keys, or credential-bearing URLs appear.

## Contract Checklist

- Happy path: the evidence packet points to the exact commands and public-safe fields.
- Negative/error path: if redaction fails, promotion stops instead of recording unsafe evidence.
- Adjacent sibling surface: protected docs stay aligned with the quickstart evidence packet.
- Empty/missing/stale/fallback state: missing handoff metadata is called out explicitly.
- Replay/restart/idempotency: rerunning the evidence commands produces the same safe field set.
- Credential/security boundary: reviewers must never paste credential values into docs or comments.
- Side-effect verification: reviewers confirm vendored-Hermes no-touch and public transcript fields directly.

## Validation Requirements

- npm test -- tests/issue-contract-lint.test.ts
- git diff --name-only origin/main...HEAD -- hermes/upstream-src
- GET /api/v1/issues/<issue-identifier>
- GET /api/v1/runs/<handoffWorkerRunId>/transcript?offset=0&limit=200

## Out Of Scope

- Editing vendored Hermes source.
- Recording raw transcript payloads or credential material in docs.

## Promotion Readiness

- Ready for `dogfood-ready`: no
- Remaining blocker: Manual operator-authored update required for the protected workflow documentation in docs/dogfood-runbook.md.
````
