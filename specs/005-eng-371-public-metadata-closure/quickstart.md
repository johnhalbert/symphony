# ENG-371 Public Metadata Closure Quickstart

This quickstart records the focused validation and promotion-evidence packet for the ENG-371 child contract examples in [`contracts/public-metadata-redaction.md`](./contracts/public-metadata-redaction.md).

## Scope

Use this packet when a reviewer needs to confirm that ENG-371 child issues cover:

- redaction parity
- repository ambiguity
- merge-gate closure
- validation evidence and secret-hygiene expectations

## Child Requirement IDs To Keep Stable

| Example | Requirement ID | Purpose |
| --- | --- | --- |
| Redaction parity | `REQ-ENG371-REDACTION-PARITY-001` | Keep transcript, projection, and status previews aligned on redaction behavior. |
| Repository ambiguity | `REQ-ENG371-REPOSITORY-AMBIGUITY-001` | Distinguish configured-versus-omitted repository metadata without leaking secrets. |
| Merge-gate closure | `REQ-ENG371-MERGE-GATE-CLOSURE-001` | Let reviewers correlate accepted completion evidence with the worker run using public-safe identifiers. |
| Validation evidence | `REQ-ENG371-VALIDATION-EVIDENCE-001` | Keep the protected-surface evidence packet explicit and secret-safe. |

## Focused Lint Coverage

Run the narrow authoring check first so the child examples stay pinned to the required headings and fenced JSON contract shape.

```text
npm test -- tests/issue-contract-lint.test.ts
```

Passing coverage should prove that the copied child issue examples:

- keep every required authoring section
- keep fenced JSON `Issue Contract` blocks with positive `schemaVersion`
- keep non-empty `contractVersion`
- keep stable unique requirement IDs
- keep a manual-only blocker whenever a protected path is intentionally listed

## Promotion Evidence Packet

Record promotion evidence with public-safe fields only. Do not paste credential values, raw environment values, private keys, or repository URLs with embedded credentials. For lifecycle-bound handoff proof, start from the top-level `reviewLoop.lastCompletionReport` fields on the issue response. On follow-up repair turns, `latestRun.runId` can point at a newer active run instead of the accepted handoff run you need to cite.

### Commands

Resolve `<handoffWorkerRunId>` from `reviewLoop.lastCompletionReport.runId` in the issue response, then use the run's `transcriptEventCount` to request a tail window that reaches the final `completed` event instead of `offset=0` (clamp the offset at `0` on shorter runs).

```text
curl -sS http://127.0.0.1:7331/api/v1/issues/<issue-identifier>
curl -sS http://127.0.0.1:7331/api/v1/runs/<handoffWorkerRunId>
curl -sS 'http://127.0.0.1:7331/api/v1/runs/<handoffWorkerRunId>/transcript?offset=<max(transcriptEventCount-15,0)>&limit=15'
```

### Public-safe fields to cite

From `GET /api/v1/issues/<issue-identifier>`:

- `issueDetails.issue.title`
- `issueDetails.issue.labels`
- `issueDetails.blockers.openCount`
- `reviewLoop.phase`
- `reviewLoop.reviewRound`
- `reviewLoop.incompleteTurnCount`
- `reviewLoop.lastCompletionReport.id`
- `reviewLoop.lastCompletionReport.runId`
- `reviewLoop.lastCompletionReport.acceptedAt`
- `reviewLoop.lastCompletionReport.pullRequest.number`
- `reviewLoop.lastCompletionReport.pullRequest.url`
- `reviewLoop.lastCompletionReport.writebackOperationKeys`

From `GET /api/v1/runs/<handoffWorkerRunId>`:

- `runId`
- `status`
- `completedAt`
- `terminalReason`
- `runPhase`
- `runKind`
- `role`
- `transcriptEventCount`
- `lastEvidenceCursor`
- `prUrl`
- `prNumber`
- `prHeadSha`
- `gitBranchName`
- `baseRef`

Do not cite `workspacePath` or `repoPath`; those are operator-local filesystem details, not public-safe promotion evidence.

From `GET /api/v1/runs/<handoffWorkerRunId>/transcript?offset=<max(transcriptEventCount-15,0)>&limit=15`:

- the final `completed` event that confirms the run reached terminal handoff output
- the nearby `message_complete` event when reviewers need the closing assistant output without paging through the transcript head
- `reviewLoop.lastCompletionReport` plus `lastEvidenceCursor` as the public handoff metadata, rather than searching the transcript head for tool events

### Reviewer summary template

Use a summary in this shape:

```text
Scenario matrix covered: happy path, negative/error path, adjacent public metadata surfaces, replay/idempotency, credential boundary, and protected-surface no-touch checks.
Validation completed: npm test -- tests/issue-contract-lint.test.ts; vendored-Hermes no-touch checks; public issue `reviewLoop.lastCompletionReport`, run summary, and transcript-tail inspection.
Secret-hygiene result: no credential values, private keys, or credential-bearing repository URLs were recorded in the cited public fields.
Out of scope: operator-only private logs and any follow-on implementation outside the ENG-371 child issue slice under review.
```

## Protected-Surface No-Touch Check

The public metadata closure examples must not rely on vendored Hermes edits. Confirm both the merge-base diff and the current worktree remain empty under `hermes/upstream-src`.

```text
git diff --name-only origin/main...HEAD -- hermes/upstream-src
git status --short -- hermes/upstream-src
```

If either command prints a path, stop and treat that as a protected-surface regression for this slice.

## Secret-Hygiene Stop Conditions

Stop promotion if any public evidence or docs output includes:

- a raw API key, token, or private key block
- a repository URL with embedded credentials
- a transcript payload that prints raw credential material instead of a sanitized preview
- a workflow, doctor, prompt, transcript, or documentation excerpt that pastes resolved secret values

When that happens, record only the safe location of the regression and fix the redaction path before promotion continues.
