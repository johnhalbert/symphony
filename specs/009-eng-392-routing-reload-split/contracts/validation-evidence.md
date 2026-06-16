# ENG-392 validation evidence formats

Use this planning contract when drafting or reviewing future ENG-392 child-issue evidence packets. The goal is to make five proof categories easy to distinguish at a glance:

1. `base-behavior`
2. `failing-before`
3. `passing-after`
4. `surface-comparison`
5. `hygiene` (the publication-hygiene bucket)

A reviewer should be able to tell what the baseline was, what failed before the fix, what passed after the fix, which authorized surfaces were actually touched, and whether the final evidence stayed safe to publish without rereading raw logs or internal implementation details.

## ENG-2479 runtime child preflight proof matrix

Use this matrix before any execution-oriented runtime child or focused evidence-capture child resumes from the blocked ENG-392 split. It is a planning-only preflight contract for downstream work: define the expected proof first, then let the owning child issue execute or capture it.

### Authoritative fallback source order when `spec.md`, `plan.md`, or `tasks.md` are absent

1. `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` — stable child titles, requirement IDs, dependency order, and authorized surfaces.
2. `specs/009-eng-392-routing-reload-split/data-model.md` — runtime prerequisite families, decomposition state rules, and blocked transitions.
3. `specs/009-eng-392-routing-reload-split/quickstart.md` — blocked-state proof inventory, current coverage gaps, and focused validation command baselines.
4. `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` — required evidence categories, redaction rules, and intentionally-unverified boundary handling.
5. `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md` — publication-surface comparison rules, explicit exclusions, and vendored-source no-touch checks.

### Required evidence fields for every runtime-child preflight record

Every future runtime-child preflight entry must record the following minimum fields:

- `commandString` — the exact command string or safe repo-relative/file/API locator used to gather the proof.
- `outcomeStatus` — the outcome status, such as `recorded`, `pass`, `fail`, `blocked`, `not_applicable`, or `intentionally_unverified`.
- `coverageSignal` — the per-family coverage signal that proves the targeted runtime invariant.
- `findings` — concrete findings if any, or an explicit `none` / zero-findings statement.
- `redactionStatement` — the redaction statement: `none` or the class of secret/private content replaced with `[REDACTED]`.

### Approved execution and capture path for ENG-2479 focused preflight

- Restricted `worker` or `reviewer` runs may inspect local Git state or planning docs, but they must not treat direct `npm test`, `npx vitest`, package-script wrappers, shell wrappers, interpreter wrappers, or compound commands as the focused preflight evidence path. `AgentCommandPolicy` denies those command families for restricted roles, so repeating them only recreates the same blocker instead of producing new focused evidence.
- The approved executor for the focused ENG-2479 preflight is a Symphony service-owned execution path that runs outside the restricted worker/reviewer boundary: either an explicitly approved unrestricted `service` role or an equivalent Symphony service-owned GitHub workflow action that can execute the focused validation command on behalf of the child issue.
- The focused result must be captured in the accepted worker completion report for the owning child issue. Record the execution outcome in `validationEvidence` and the requirement-level proof in `acceptanceChecklist`, then rely on the persisted `IssueLifecycleRecord.completionReports[]`, `lastCompletionReportId`, and `summaryPointers.lastEvidenceCursor` entries as the lifecycle-bound evidence handle.
- Later workers and reviewers should reference the lifecycle surfaces that expose that accepted record — `lastCompletionReport` and `lastEvidenceCursor` — instead of retrying blocked package-command execution locally. If the service-owned preflight has not run yet, record a single `blocked` preflight entry and stop rather than re-entering the denied command loop.

### Focused runtime child preflight matrix

| Planned runtime child contract family | Dependency gate before execution or focused evidence capture proceeds | Per-family coverage signal to record | Later child that owns execution/evidence work |
| --- | --- | --- | --- |
| `REQ-392-RUNTIME-ROUTING` | Confirm the route-isolation prerequisite against the fallback sources above before any runtime-routing implementation or proof sweep resumes. | Two distinct project contexts keep distinct issue, workspace, and lifecycle buckets, and wrong-context or ambiguous routes fail closed instead of reusing another bucket. | `REQ-392-RUNTIME-ROUTING` owns the runtime implementation and focused routing validation once this preflight definition is accepted. |
| `REQ-392-RELOAD-PRESERVATION` | Reuse the routed identity defined by `REQ-392-RUNTIME-ROUTING`; do not capture reload proof until the same routed workspace/lifecycle identity is the prerequisite baseline. | The same project-context-qualified workspace, prompt/context identity, and lifecycle bucket survive reload or restart without duplicate redispatch or incomplete-turn burn while the run remains intentional. | `REQ-392-RELOAD-PRESERVATION` owns the reload/restart implementation and focused preservation validation after the routing child stabilizes the baseline. |
| `REQ-392-APPROVAL-WRITEBACK` | Treat routed approval and writeback recovery as downstream from both runtime routing and reload preservation; do not record approval proof as if those prerequisites were already implicit. | Pending, approved, rejected, cancelled, or replayed approval/writeback paths preserve one routed run lineage, one audit/writeback settlement story, and explicit terminal/recovery state instead of duplicating or losing state. | `REQ-392-APPROVAL-WRITEBACK` owns the approval/writeback implementation and focused recovery validation after the routing and reload prerequisites are stable. |

### Child issue dependency ownership for later execution or evidence work

- `REQ-392-RUNTIME-ROUTING` depends on `REQ-392-DECISION` and is the first runtime child allowed to own execution once the decomposition decision stays locked.
- `REQ-392-RELOAD-PRESERVATION` depends on `REQ-392-RUNTIME-ROUTING` and owns reload or restart execution only after routed identity is stable.
- `REQ-392-APPROVAL-WRITEBACK` depends on both `REQ-392-RUNTIME-ROUTING` and `REQ-392-RELOAD-PRESERVATION` and owns routed approval or writeback execution only after both prerequisites are stable.
- `REQ-392-TEST-PROOF` depends on `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, and `REQ-392-APPROVAL-WRITEBACK` and owns the focused orchestrator proof execution and evidence capture after those runtime prerequisites are satisfied.
- `REQ-392-PUBLICATION-HYGIENE` depends on `REQ-392-DECISION`, `REQ-392-APPROVAL-WRITEBACK`, and `REQ-392-TEST-PROOF` and owns the publication-facing evidence closure only after the runtime, approval, and proof families are complete.

### Out-of-scope boundary for this preflight matrix

- This matrix is planning-only. It does not authorize runtime implementation, focused preflight execution, focused evidence capture, live lifecycle state changes, publication, protected branch updates, or changes under `hermes/upstream-src/**`.
- `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, and `REQ-392-APPROVAL-WRITEBACK` own the later family-specific runtime implementation and validation execution.
- `REQ-392-TEST-PROOF` owns the focused orchestrator proof execution and evidence capture after the runtime prerequisites above are stable.
- `REQ-392-PUBLICATION-HYGIENE` owns the publication-surface comparison, final evidence hygiene, and publication-facing closure work after the runtime and proof families are satisfied.
- If future work would require protected branch updates or vendored upstream changes, stop and author a separate protected-surface contract first instead of treating this preflight matrix as authorization.

## Shared evidence-entry rules

Every evidence entry should record:

- `status`: one of `recorded`, `not_applicable`, or `intentionally_unverified`
- `surface`: a repo-relative path, API route, test name, command label, or review artifact label
- `proof`: stable fields, line ranges, assertion names, exit status, or another durable public-safe summary
- `why_it_matters`: the contract slice or reviewer question the entry answers
- `redactions`: `none` or a short note describing what was removed or replaced with `[REDACTED]`

Prefer compact durable identifiers over raw payload dumps. Good proof usually cites one of:

- repo-relative file paths plus line ranges
- exact focused test names
- exact command strings plus exit status
- API field names, status enums, ids, counts, and timestamps
- transcript event types or summary fields instead of full transcript bodies

## Evidence category definitions

| Category | Required when | What it must prove | Minimum proof shape |
| --- | --- | --- | --- |
| `base-behavior` | Always | The reviewer can see the starting contract, existing behavior, or current documented expectation before judging the change. | Baseline source + safe proof fields + why the baseline matters. |
| `failing-before` | Required for bug fixes, guardrail repairs, regression work, or tasks that claim a pre-change gap. | The relevant pre-change check really failed, or an existing review artifact already proved the gap. | Exact failing command/test/review artifact + failing symptom + why it blocks acceptance. |
| `passing-after` | Required whenever `failing-before` is required, and recommended for any change that adds or updates focused validation. | The same behavior now passes after the change. | Matching command/test/artifact family + passing signal + why that closes the gap. |
| `surface-comparison` | Always | The implemented/validated surface stayed aligned with the issue contract instead of silently drifting into adjacent paths. | Authorized surface map + observed change/inspection surface + adjacent exclusions or unverified boundaries. |
| `hygiene` | Always | The evidence packet is safe to publish, omits secrets and unnecessary operator-local details, and labels any intentionally unverified integration boundary explicitly. | Redaction summary + local-path handling + intentionally-unverified boundaries + findings or zero-findings statement. |

## Category-specific requirements

### `base-behavior`

Use this category to anchor the review in the pre-change reality.

Required contents:

- the baseline artifact or source under review
- the stable fields, line ranges, or assertion names that establish the baseline
- a short note explaining why this is the correct starting point for the issue contract

Allowed sources:

- the current contract or planning doc
- an existing focused validation artifact
- a focused test name or fixture that captures current behavior
- a status or transcript summary field when the task is lifecycle-facing

Do not use `base-behavior` as a substitute for a missing regression proof. If the issue claims a concrete failing behavior, record that under `failing-before` instead of describing it vaguely here.

### `failing-before`

Use this category only when the issue is supposed to repair a known failure, regression, missing guardrail, or stale proof gap.

Required contents when applicable:

- the exact failing command, test, API check, or existing review artifact
- the specific failure symptom the reviewer should look for
- the reason the failure matters for the issue contract

Allowed proof shapes:

- focused command plus exit status and the one failing assertion or summary line
- review comment or blocker link when the failure was already captured externally and rerunning it is out of scope
- doc line range showing a missing or contradictory requirement when the task fixes planning authoring rather than runtime behavior

Use the narrowest proof shape that matches the actual before-state:

| Before-state variant | Record under `surface` / `proof` | Why this is the right shape |
| --- | --- | --- |
| In-scope tests or runtime checks already fail without changing authorized surfaces | Cite the failing command or test family plus the failing assertion, summary line, or non-zero exit status. | This is a true pre-change failure inside the contracted validation surface. |
| The branch-tip tests pass, but only while out-of-contract runtime paths remain present | Record a **bounded contradiction proof** instead of pretending there was no failure. Pair the passing focused test family with one contradiction artifact showing the same behavior stops passing once the non-contract runtime paths are removed, restored to merge-base, or otherwise isolated. Name the blocked runtime prerequisite or surface family the contradiction exposes. | This distinguishes a tests-only proof gap from a genuine runtime prerequisite gap: the focused tests are green, but the candidate still depends on unauthorized runtime behavior. |
| Planning-only authoring gap with no runnable failure in scope | Cite the contradictory or missing requirement line range. | This keeps planning repairs bounded without inventing runtime failures. |

For bounded contradiction proofs, the cited artifact must stay public-safe and should include all of the following:

- the exact focused test, command, or review proof that passed on the candidate branch tip
- the restore, diff, review, or equivalent contradiction artifact proving the result stops holding once the non-contract runtime paths are removed or isolated
- the repo-relative runtime prerequisite, surface family, or protected path family that explains the dependency

When it is not applicable, record `status: not_applicable` and explain why. Typical examples:

- docs-only planning tasks with no runnable before-state check in scope
- issue-authoring cleanup that clarifies evidence formats rather than repairing a shipped behavior
- tasks whose validation requirements explicitly forbid running the live failing command

### `passing-after`

Use this category to show the repaired or finalized state after the change.

Required contents when applicable:

- the exact passing command, test, review artifact, or file inspection
- the stable pass signal, such as exit `0`, a passing test name, a resolved field set, or a finalized line range
- a short note connecting the passing proof back to the same contract slice tracked in `failing-before`

Rules:

- Prefer the same command, test, or artifact family used in `failing-before`.
- Do not replace focused proof with a vague claim such as "tests passed" or "docs updated".
- If `failing-before` is `not_applicable`, `passing-after` may also be `not_applicable`, but the reason must stay explicit.

#### Close/replace planning disposition

When an operator chooses the **close or replace** path instead of a resumed implementation candidate, record the proof bundle as a no-implementation disposition rather than pretending a code change was validated.

Required current-base proof in `base-behavior`:

- cite the current blocked candidate, diff reference, or review artifact that proved the original scope mismatch or protected-surface dependency
- name the coupled runtime, publication, or other protected surface families that explain why that candidate will not resume
- explain why this blocked baseline is the correct starting point for the close/replace decision

Required no-implementation proof in `passing-after`:

- record that the disposition is **close or replace** and that no implementation resumed from the blocked candidate
- cite the superseding issue, branch, PR, or explicit closure record that replaces the blocked candidate
- record what remains excluded after the decision, including runtime, publication, and debug-capture surfaces that still are not authorized
- confirm renewed worker or reviewer dispatch stays blocked until the superseding replacement is stable

Current ENG-392 planning baseline: this close/replace variant is **not currently selected**. `specs/009-eng-392-routing-reload-split/quickstart.md` records **split/retarget** as the selected decomposition decision, so any close/replace-specific evidence entry should currently use `status: not_applicable` and explicitly name `split/retarget` as the selected alternative until a later planning decision replaces it.

### `surface-comparison`

Use this category to keep the evidence packet honest about scope.

Required contents:

- the surface authorized by the issue contract
- the surface actually modified or inspected
- the validation surface used as proof
- any adjacent surface intentionally left untouched or intentionally unverified

Recommended shape:

| Contract surface | Observed surface | Validation surface | Status | Notes |
| --- | --- | --- | --- | --- |
| repo-relative path or surface family | repo-relative path or artifact | command, file inspection, or review artifact | `recorded` / `intentionally_unverified` | Explain whether the surface was changed, inspected-only, or explicitly excluded. |

This category should make scope drift obvious. If the issue authorizes one planning file but the evidence packet depends on several runtime paths, the mismatch should be visible here instead of hidden in prose.

### `hygiene`

Use this category to prove the evidence packet is safe for reviewers and ready for publication or handoff.

Required contents:

- a redaction summary
- confirmation that unnecessary operator-local filesystem paths were omitted
- `protectedSurfaceChecks`: `[]` when no protected-surface or no-touch check applies; otherwise one or more entries naming the protected/no-touch surface, the expectation, and the proof
- every live integration boundary that was intentionally not exercised
- a `findings` summary, even when it is an explicit zero-findings statement
- `status: recorded` only when no live boundary was intentionally skipped
- `status: intentionally_unverified` whenever the hygiene entry names one or more skipped live boundaries

Recommended shapes:

```yaml
status: recorded
surfacesChecked:
  - <repo-relative path or safe surface label>
redactions:
  - none
localPathHandling: repo-relative paths only
protectedSurfaceChecks: []
intentionallyUnverified: []
findings: []
```

Use the recorded variant only when the hygiene entry has no skipped live boundary to report.

```yaml
status: intentionally_unverified
surfacesChecked:
  - <repo-relative path or safe surface label>
redactions:
  - none
localPathHandling: repo-relative paths only
protectedSurfaceChecks: []
intentionallyUnverified:
  - boundary: <Linear writeback | GitHub publication | live tracker lookup>
    reason: <out of scope | manual-only | credentials intentionally unavailable>
    nearestLocalProof: <repo-relative path, test name, or safe artifact>
findings: []
```

Use the intentionally-unverified variant whenever any live boundary was skipped.

When protected-surface or no-touch checks are relevant, replace `protectedSurfaceChecks: []` with one or more entries in this shape:

```yaml
protectedSurfaceChecks:
  - surface: <repo-relative protected path or no-touch surface>
    expectation: <must remain untouched | protected/manual-only>
    proof: <safe artifact | command | line range>
```

## Redaction and safe-citation rules

Evidence packets must exclude secrets and unnecessary local paths.

Never record any of the following in validation evidence:

- raw tokens, API keys, session cookies, or private keys
- raw environment variable values
- repository URLs with embedded credentials
- raw prompt bodies, raw log bodies, or raw transcript payload bodies when a safe summary field would do
- operator-local absolute paths such as `C:\Users\...`, `/Users/...`, `/home/...`, `workspacePath`, or `repoPath` unless the issue contract explicitly requires them

Prefer these safe alternatives instead:

- repo-relative paths
- stable field names and ids
- status enums, counts, timestamps, and event types
- focused assertion names or line ranges
- `[REDACTED]` markers plus a short note naming the secret class that was removed

If a reviewer needs to know that sensitive content was present and handled safely, name only the pattern class, not the secret itself. Example: `credential-bearing URL -> [REDACTED]`.

## Intentionally-unverified integration rules

Some issues intentionally stop short of live integrations. In those cases, the evidence packet must be explicit rather than silent.

When a live boundary is not exercised:

1. set `status: intentionally_unverified` for the relevant comparison or hygiene entry
2. name the skipped boundary precisely, such as `Linear writeback`, `GitHub PR publication`, `live tracker routing`, or `operator approval transition`
3. explain why it was skipped, such as `out of scope`, `manual-only`, or `live credentials intentionally not used`
4. cite the nearest local proof, such as the repo-relative planning doc, focused test, or safe review artifact that still constrains the intended behavior
5. do not imply the skipped integration passed, failed, or was "effectively covered" unless a real execution artifact proves it

If promotion or reviewer signoff depends on that live boundary later, carry it forward as a manual follow-up or blocker instead of hiding it behind inferred success.

## Canonical reviewer packet skeleton

Use the following shape when recording future evidence:

````markdown
### base-behavior
- status: recorded
- surface: `<repo-relative path | API route | test name>`
- proof: `<line range | field set | assertion name>`
- why_it_matters: `<baseline contract or existing behavior>`
- redactions: none

### failing-before
- status: `<recorded | not_applicable>`
- surface: `<focused failing command/test | bounded contradiction pair | review artifact>`
- proof: `<failing assertion | blocker summary | contradiction artifact + runtime prerequisite/surface family | missing requirement lines>`
- why_it_matters: `<why the pre-change gap blocked acceptance>`
- redactions: `<none | note>`

### passing-after
- status: `<recorded | not_applicable>`
- surface: `<same command/test family or finalized file>`
- proof: `<exit 0 | passing test name | finalized lines>`
- why_it_matters: `<how the gap was closed>`
- redactions: `<none | note>`

### surface-comparison
| Contract surface | Observed surface | Validation surface | Status | Notes |
| --- | --- | --- | --- | --- |
| `<authorized surface>` | `<changed or inspected surface>` | `<proof artifact>` | `recorded` | `<scope note>` |
| `<adjacent excluded surface>` | `<none>` | `<n/a or safe note>` | `intentionally_unverified` | `<why it stayed out of scope>` |

### hygiene (no skipped live boundary)
- status: recorded
- surfacesChecked: [`<safe surface label>`]
- redactions: [`none`]
- localPathHandling: `repo-relative paths only`
- protectedSurfaceChecks: `[]` when none apply; otherwise one or more `{ surface, expectation, proof }` entries
- intentionallyUnverified: []
- findings: []

### hygiene (with intentionally unverified live boundary)
- status: intentionally_unverified
- surfacesChecked: [`<safe surface label>`]
- redactions: [`none`]
- localPathHandling: `repo-relative paths only`
- protectedSurfaceChecks: `[]` when none apply; otherwise one or more `{ surface, expectation, proof }` entries
- intentionallyUnverified:
  - boundary: `<live integration boundary>`
    reason: `<out of scope | manual-only | credentials intentionally unavailable>`
    nearestLocalProof: `<repo-relative path | focused test | safe review artifact>`
- findings: []
````

## Review checklist for this format

A finalized evidence packet based on this guide should let a reviewer answer yes to all of the following:

- Can I distinguish baseline proof from before-failure proof and after-pass proof?
- Can I see exactly which authorized surface was inspected or changed?
- Are adjacent untouched or intentionally unverified integrations called out explicitly?
- Are secrets, credential-bearing URLs, and unnecessary local paths absent from the cited evidence?
- Could I re-check the cited proof using stable paths, fields, commands, or artifact labels without reading raw private payloads?

## ENG-2474 T028 test-proof validation evidence snapshot

This packet uses the shared reviewer skeleton above to record the focused routing-isolation and reload-preservation proof already present in `tests/orchestrator.test.ts` for `REQ-392-TEST-PROOF`, plus the current status of broader same-file validation evidence without widening beyond the authorized orchestrator test surface.

### Test-proof scenario matrix

| Path | Evidence bucket | Branch-tip status | Primary proof | Child-work disposition |
| --- | --- | --- | --- | --- |
| focused routing isolation across project contexts | `base-behavior` + `passing-after` | `pass` | `tests/orchestrator.test.ts:2649-2826`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:357-395` | Satisfies the distinct-workspace/lifecycle-bucket half of `REQ-392-TEST-PROOF` within the authorized `tests/orchestrator.test.ts` surface. |
| focused reload preservation for an already-running routed context | `base-behavior` + `passing-after` | `pass` | `tests/orchestrator.test.ts:2504-2647`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:357-395` | Satisfies the reload-preservation/no-identity-drift half of `REQ-392-TEST-PROOF` within the same focused test surface. |
| broader full orchestrator-file validation | `passing-after` + `hygiene` | `blocked` | `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:397-400`; `package.json:25`; command labels `npm test -- tests/orchestrator.test.ts` and `./node_modules/.bin/vitest run --no-file-parallelism tests/orchestrator.test.ts` | Record the broader validation family and the local blocker note explicitly instead of implying a fresh full-file pass artifact that this worker run could not emit. |

### base-behavior
- status: recorded
- surface: `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:357-400`; `tests/orchestrator.test.ts:2504-2826`; `package.json:25`
- proof: `REQ-392-TEST-PROOF` requires one focused orchestrator scenario proving cross-project routing isolation and one proving reload preservation for an already-running routed context, while `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:397-400` names `npm test -- tests/orchestrator.test.ts` as the full orchestrator-file validation requirement. Branch tip now contains `tests/orchestrator.test.ts:2649-2826`, which routes duplicate identifiers from default and docs project contexts into distinct workspace keys, run-store records, and lifecycle buckets, plus `tests/orchestrator.test.ts:2504-2647`, which preserves the original docs project context and persisted routing snapshot across config reload while separately dispatching a rerouted candidate. `package.json:25` records the broader orchestrator-file validation family as `vitest run --no-file-parallelism`.
- why_it_matters: This anchors the exact focused proof T028 must record and names the broader full-file validation family without widening beyond the authorized orchestrator test surface.
- redactions: none

### failing-before
- status: recorded
- surface: `specs/009-eng-392-routing-reload-split/quickstart.md:163-164`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:357-395`
- proof: `quickstart.md` still records the original proof gap that no single existing test demonstrated cross-project workspace/state isolation and no explicit existing test demonstrated an already-running routed context surviving config reload. `REQ-392-TEST-PROOF` exists to close exactly those two focused orchestrator-proof gaps inside `tests/orchestrator.test.ts`.
- why_it_matters: `REQ-T028` is an evidence-capture task, so the relevant before-state is the previously documented proof gap that needed an explicit validation packet once the focused tests existed.
- redactions: none

### passing-after
- status: recorded
- surface: `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md#eng-2474-t028-test-proof-validation-evidence-snapshot`; `tests/orchestrator.test.ts:2504-2826`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:397-400`; `package.json:25`
- proof: The `ENG-2474 T028 test-proof validation evidence snapshot` section now records three explicit validation states for `REQ-392-TEST-PROOF`: `pass` for focused routing isolation from `tests/orchestrator.test.ts:2649-2826`, `pass` for focused reload preservation from `tests/orchestrator.test.ts:2504-2647`, and `blocked` for a fresh broader orchestrator-file run because the child contract's required command (`npm test -- tests/orchestrator.test.ts`) and its package-level implementation (`vitest run --no-file-parallelism`) could be identified but this worker run's package/script execution boundary blocked emitting a new `tests/orchestrator.test.ts` full-file exit artifact.
- why_it_matters: The after-state reviewers need for `REQ-T028` is an evidence packet that makes the focused proof pass signals and the broader full-file blocker note explicit instead of implying unrecorded coverage.
- redactions: none

### surface-comparison
| Contract surface | Observed surface | Validation surface | Status | Notes |
| --- | --- | --- | --- | --- |
| `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | file inspection plus `git diff -- specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | `recorded` | T028 records only the evidence artifact. |
| `tests/orchestrator.test.ts` | `tests/orchestrator.test.ts:2504-2826` | focused file inspection of the two `REQ-392-TEST-PROOF` scenarios | `recorded` | The authorized orchestrator proof surface was inspected without editing runtime or harness sources. |
| broader `tests/orchestrator.test.ts` validation family | `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:397-400`; `package.json:25`; `tests/orchestrator.test.ts` | command labels `npm test -- tests/orchestrator.test.ts` and `./node_modules/.bin/vitest run --no-file-parallelism tests/orchestrator.test.ts` plus the recorded blocker note in this packet | `intentionally_unverified` | T028 names the broader same-file validation path, but this worker run did not produce a fresh full-file exit artifact because package/script test invocations were blocked locally. |
| `hermes/upstream-src/**` | `none` | `git diff -- specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | `recorded` | Vendored Hermes upstream sources stay untouched. |

### hygiene (with intentionally unverified local execution boundary)
- status: intentionally_unverified
- surfacesChecked: [`specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`, `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`, `specs/009-eng-392-routing-reload-split/quickstart.md`, `tests/orchestrator.test.ts`, `package.json`]
- redactions: [`none`]
- localPathHandling: `repo-relative paths only`
- protectedSurfaceChecks:
  - surface: `hermes/upstream-src/**`
    expectation: `must remain untouched`
    proof: `git diff -- specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` is the only scoped diff expected from T028; no vendored path is cited or modified in this packet.
- intentionallyUnverified:
  - boundary: `fresh full orchestrator-file test execution`
    reason: `this worker run could inspect the focused proof lines and the canonical orchestrator test command family, but package/script test invocations were blocked before they could emit a new full-file result artifact`
    nearestLocalProof: `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:397-400`; `package.json:25`; `tests/orchestrator.test.ts:2504-2826`
- findings:
  - `Focused REQ-392-TEST-PROOF routing-isolation and reload-preservation scenarios are present in tests/orchestrator.test.ts, while the broader full-file orchestrator validation state is recorded here as blocked rather than implied.`

## ENG-2476 T030 runtime routing evidence snapshot

This packet uses the shared reviewer skeleton above to record which runtime-routing prerequisites already have branch-tip evidence and which gaps must stay mapped to prerequisite child work instead of being implied away by the test-proof issue.

### Runtime routing scenario matrix

| Path | Evidence bucket | Branch-tip status | Primary proof | Child-work disposition |
| --- | --- | --- | --- | --- |
| dispatch | `base-behavior` | `recorded` | `src/core/orchestrator/Orchestrator.ts:1487-1520`, `1859-1923`; `tests/orchestrator.test.ts:1500-1567`, `2434-2502` | No new prerequisite identified beyond the existing `REQ-392-RUNTIME-ROUTING` family mapping. |
| retry | `base-behavior` | `recorded` | `src/core/orchestrator/Orchestrator.ts:3008-3052`; `src/core/config/Config.ts:1390-1403`; `tests/orchestrator.test.ts:2336-2371` | No new prerequisite identified beyond the existing `REQ-392-RUNTIME-ROUTING` family mapping. |
| reconciliation | `base-behavior` | `recorded` | `src/core/orchestrator/Orchestrator.ts:1628-1665`, `3468-3567` | No new prerequisite identified beyond the existing `REQ-392-RUNTIME-ROUTING` family mapping. |
| handoff | `base-behavior` | `recorded` | `src/core/orchestrator/Orchestrator.ts:3468-3567`, `4005-4039`; `tests/orchestrator.test.ts:3988-4097`, `5514-5600` | No new prerequisite identified beyond the existing `REQ-392-RUNTIME-ROUTING` family mapping. |
| continuation | `base-behavior` + `failing-before` | Pointer-based continuation and scoped summary reuse are recorded; rich continuation-context routing remains blocked child work. | `src/core/orchestrator/Orchestrator.ts:2987-3005`, `3831-3914`; `tests/orchestrator.test.ts:7356-7606`; `tests/continuation-roadmap.test.ts:5-32`; `tests/continuation-summarizer.test.ts:4-53` | Keep continuation enrichment explicitly blocked under `REQ-392-RUNTIME-ROUTING`; do not fold it into `REQ-T030`. |
| readback | `base-behavior` | `recorded` | `src/core/workspace/WorkspaceManager.ts:60-99`, `350-391`, `623-657`; `tests/status-api.test.ts:545-818` | No new prerequisite identified beyond the existing `REQ-392-RUNTIME-ROUTING` family mapping. |

### base-behavior
- status: recorded
- surface: `src/core/orchestrator/Orchestrator.ts:1487-1520`, `1628-1665`, `1859-1923`, `2987-3052`, `3468-3567`, `3831-3914`, `4005-4039`; `src/core/config/Config.ts:927-939`, `1390-1403`, `2286-2320`; `src/core/workspace/WorkspaceManager.ts:60-99`, `350-391`, `623-657`; `tests/orchestrator.test.ts:1500-1630`, `2336-2502`, `3988-4097`, `5514-5600`, `7356-7606`; `tests/status-api.test.ts:545-818`
- proof: `dispatch` reconciles running work before polling, refreshes candidate state inside the requested project context, reroutes worker work through `resolveWorkerDispatchDecision`, and fails closed for wrong-context issue-breakdown lookups; `retry` stores `projectContext` on retry attempts, re-fetches through routed lookups, and stops retrying once refreshed state enters a handoff state; `reconciliation` refreshes running entries grouped by project context and terminates or preserves them based on terminal, handoff, blocked, or route-changed state; `handoff` reconciliation re-reads accepted completion reports, merge-conflict reports, issue-breakdown plans, and review verdicts before writeback or merge-policy follow-up; `continuation` prompts reuse lifecycle, run-store, transcript, status, and summary pointers while scoped summary creation excludes sibling project contexts; `readback` exact-id status/workspace/open-workspace lookups return the routed workspace and run, while ambiguous identifier reads fail with `409 conflict` instead of crossing buckets. Focused validation commands exited `0`: `npm test -- tests/orchestrator.test.ts -t 'fails closed for direct issue-breakdown lookups when the direct tracker hit resolves outside the requested project context|does not retry after a handoff state|propagates non-default project context through dispatch harness, run records, and lifecycle state|does not redispatch issues with .* pending publication approval before Linear reaches Blocked|treats accepted completion reports as live handoff and suppresses continuation/no-report writeback|uses pointers instead of raw run history in continuation prompts below the event threshold|scopes continuation summaries to the lifecycle project context when duplicate identifiers collide'`; `npm test -- tests/status-api.test.ts -t 'resolves exact-id status lookups by lifecycle project context when visible identifiers collide|reopens exact issue-id collision fallback workspaces from persisted workspace keys before contextual alias derivation'`; `npm test -- tests/continuation-roadmap.test.ts tests/continuation-summarizer.test.ts`.
- why_it_matters: Branch-tip routing evidence already covers dispatch, retry, reconciliation, handoff, pointer-based continuation reuse, and exact-id readback without requiring T030 to invent a new runtime child issue for those already-proven paths.
- redactions: none

### failing-before
- status: recorded
- surface: `tests/continuation-roadmap.test.ts:5-32`; `tests/continuation-summarizer.test.ts:4-53`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:141-201`; `specs/009-eng-392-routing-reload-split/quickstart.md:122-126`
- proof: `tests/continuation-roadmap.test.ts` proves continuation search remains `dispatchPolicy = "no_orchestrator_dispatch"`, summarization remains `not_implemented`, and the orchestrator must not import or schedule roadmap placeholders; `tests/continuation-summarizer.test.ts` proves the placeholder summarizer still returns only transcript/status pointers with the summary text `Continuation history summarization is not automated yet`; the runtime-routing child contract (`REQ-392-RUNTIME-ROUTING`) remains the authorized owner of routed worker/reviewer/open-workspace identity proof, and `quickstart.md` keeps reload-preservation plus orchestrator-proof work downstream from that child.
- why_it_matters: This is the explicit remaining prerequisite child work surfaced by T030: richer continuation-context routing cannot be claimed as complete here and must stay mapped to `REQ-392-RUNTIME-ROUTING` instead of being hidden inside the test-proof issue.
- redactions: none

### passing-after
- status: recorded
- surface: `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md#eng-2476-t030-runtime-routing-evidence-snapshot`
- proof: The `ENG-2476 T030 runtime routing evidence snapshot` section now records the runtime-routing matrix, the branch-tip base-behavior proof for dispatch/retry/reconciliation/handoff/continuation/readback, and the continuation roadmap gap that remains prerequisite child work under `REQ-392-RUNTIME-ROUTING`.
- why_it_matters: `REQ-T030` is an evidence-capture task, so the relevant after-state is a finalized, reviewable packet that exposes prerequisite status rather than pretending the runtime gap was repaired here.
- redactions: none

### surface-comparison
| Contract surface | Observed surface | Validation surface | Status | Notes |
| --- | --- | --- | --- | --- |
| `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | file inspection plus `git diff -- specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | `recorded` | T030 changes only the evidence artifact. |
| `routing-reload-core` | `src/core/orchestrator/Orchestrator.ts`; `src/core/config/Config.ts` | cited line ranges plus `npm test -- tests/orchestrator.test.ts -t 'fails closed for direct issue-breakdown lookups when the direct tracker hit resolves outside the requested project context|does not retry after a handoff state|propagates non-default project context through dispatch harness, run records, and lifecycle state|does not redispatch issues with .* pending publication approval before Linear reaches Blocked|treats accepted completion reports as live handoff and suppresses continuation/no-report writeback|uses pointers instead of raw run history in continuation prompts below the event threshold|scopes continuation summaries to the lifecycle project context when duplicate identifiers collide'` | `recorded` | Dispatch, retry, reconciliation, handoff, and continuation routing were inspected without changing protected runtime code. |
| `workspace-lifecycle` | `src/core/workspace/WorkspaceManager.ts` | `tests/status-api.test.ts:545-818`; `tests/orchestrator.test.ts:2434-2502`, `7496-7606` | `recorded` | Workspace keys, branch scoping, and scoped summary/readback stay project-context-qualified. |
| `operator-http-entrypoints` | `tests/status-api.test.ts:545-818` | `npm test -- tests/status-api.test.ts -t 'resolves exact-id status lookups by lifecycle project context when visible identifiers collide|reopens exact issue-id collision fallback workspaces from persisted workspace keys before contextual alias derivation'` | `recorded` | T030 is evidence-only, so readback/open-workspace proof is cited from existing tests instead of reopening `src/app/http.ts` or `cursor/src/CursorWorkspaceOpener.ts` for implementation edits. |
| `REQ-392-RUNTIME-ROUTING` prerequisite child work | `tests/continuation-roadmap.test.ts:5-32`; `tests/continuation-summarizer.test.ts:4-53`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:141-201` | file inspection plus `npm test -- tests/continuation-roadmap.test.ts tests/continuation-summarizer.test.ts` | `recorded` | Rich continuation search/summarization remains blocked child work and must stay separated from `REQ-T030`. |

### hygiene (with intentionally unverified live boundary)
- status: intentionally_unverified
- surfacesChecked: [`specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`, `src/core/orchestrator/Orchestrator.ts`, `src/core/config/Config.ts`, `src/core/workspace/WorkspaceManager.ts`, `tests/orchestrator.test.ts`, `tests/status-api.test.ts`, `tests/continuation-roadmap.test.ts`, `tests/continuation-summarizer.test.ts`]
- redactions: [`none`]
- localPathHandling: `repo-relative paths only`
- protectedSurfaceChecks:
  - surface: `hermes/upstream-src/**`
    expectation: `must remain untouched`
    proof: `git diff -- specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` is the only scoped diff expected from T030; no vendored path is cited or modified in this packet.
  - surface: `src/app/http.ts`; `cursor/src/CursorWorkspaceOpener.ts`
    expectation: `analysis-only under T030`
    proof: Readback/open-workspace evidence is cited from `tests/status-api.test.ts:545-818` instead of changing operator entrypoint sources.
- intentionallyUnverified:
  - boundary: `live tracker routing and live open-workspace HTTP execution`
    reason: `evidence-only task; focused unit tests and source inspection were used instead of live credentials`
    nearestLocalProof: `tests/orchestrator.test.ts:1500-1630`; `tests/status-api.test.ts:545-818`
  - boundary: `live GitHub publication or Linear writeback outside focused unit tests`
    reason: `out of scope for REQ-T030`
    nearestLocalProof: `tests/orchestrator.test.ts:3988-4097`; `tests/orchestrator.test.ts:5514-5600`
- findings:
  - `Continuation history summarization and routed search remain explicit prerequisite child work under REQ-392-RUNTIME-ROUTING; current branch-tip continuation proof is limited to pointer-based reuse and scoped summary/readback.`

## ENG-2477 T031 reload preservation redispatch evidence snapshot

This packet uses the shared reviewer skeleton above to record whether branch-tip reload-preservation proof already covers routed worker retry redispatch and routed reviewer redispatch, or whether either slice must stay mapped to prerequisite child work instead of being implied from adjacent routing or approval-recovery coverage.

### Reload preservation redispatch scenario matrix

| Path | Evidence bucket | Branch-tip status | Primary proof | Child-work disposition |
| --- | --- | --- | --- | --- |
| worker retry redispatch after config reload | `base-behavior` | `recorded` | `src/core/orchestrator/Orchestrator.ts:532-535`, `3008-3104`; `tests/orchestrator.test.ts:2504-2647`, `3073-3209` | No new prerequisite identified for worker retry-after-reload proof; current branch tip already records both preserved in-progress worker routing identity and routed retry redispatch through config reload. |
| reviewer redispatch after config reload or restart | `base-behavior` + `failing-before` | Routed reviewer dispatch is recorded, but explicit reload/restart redispatch proof remains missing. | `src/core/orchestrator/Orchestrator.ts:1475-1519`, `1926-1957`, `2211-2268`; `tests/orchestrator.test.ts:5762-5892`; `specs/009-eng-392-routing-reload-split/quickstart.md:165-167`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:230-268`, `368-384` | Keep the reviewer reload-preservation gap mapped to `REQ-392-RELOAD-PRESERVATION` and `REQ-392-TEST-PROOF`; do not imply it from ordinary routed reviewer dispatch or approval-recovery tests. |

### base-behavior
- status: recorded
- surface: `src/core/orchestrator/Orchestrator.ts:532-535`, `1475-1519`, `1926-1957`, `2211-2268`, `3008-3104`; `tests/orchestrator.test.ts:2504-2647`, `3073-3209`, `5762-5892`
- proof: `updateConfig()` swaps the active config and prompt template without clearing in-memory `running` or `retryAttempts`, and the retry path stores `projectContext` on each retry entry before `onRetryTimer()` re-fetches and redispatches through routed project-context lookups. `tests/orchestrator.test.ts:2504-2647` proves an already-running routed worker keeps the same project-context-qualified run and lifecycle snapshot across config reload while a rerouted candidate dispatches separately. `tests/orchestrator.test.ts:3073-3209` proves a routed worker retry scheduled before `updateConfig()` redispatches after config reload with the same docs project context, docs tracker active states, and persisted lifecycle project context, which supersedes the earlier worker-gap note in `quickstart.md`. On the reviewer side, `tick()` still polls review states after worker polling, `tryDispatchReviewerIssue()` refreshes and revalidates the routed review candidate in project context before dispatch, and `runReviewer()` reloads the harness with reviewer role plus routed review evidence. `tests/orchestrator.test.ts:5762-5892` proves that routed reviewer dispatch path resolves `Docs Review` via the docs tracker, reloads the harness with the reviewer role and docs review state, and carries forward completion-report plus run-digest evidence into the reviewer prompt.
- why_it_matters: This establishes the branch-tip baseline that T031 can safely claim today: worker reload-preservation and retry redispatch already have explicit routed proof, and reviewer redispatch has a concrete routed baseline to compare against the missing reload-specific proof.
- redactions: none

### failing-before
- status: recorded
- surface: `specs/009-eng-392-routing-reload-split/quickstart.md:165-167`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md:230-268`, `368-384`
- proof: `quickstart.md` still records that no explicit reviewer redispatch-after-reload or restart scenario appears for a routed review issue and that the broader reload/restart plus approval combination remains uncovered. The reload-preservation child contract (`REQ-392-RELOAD-PRESERVATION`) still requires config reload/restart handling to preserve an already-running routed worker or reviewer context with non-redispatch invariants, and the focused-proof child contract (`REQ-392-TEST-PROOF`) still requires a proof path showing reload preservation without duplicate redispatch or identity drift.
- why_it_matters: The remaining reviewer reload-preservation proof gap must stay visible as prerequisite child work instead of being inferred from ordinary routed reviewer dispatch or adjacent approval-recovery coverage.
- redactions: none

### passing-after
- status: recorded
- surface: `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md#eng-2477-t031-reload-preservation-redispatch-evidence-snapshot`
- proof: The `ENG-2477 T031 reload preservation redispatch evidence snapshot` section now records that worker retry redispatch already has branch-tip reload-preservation evidence, while reviewer reload/restart redispatch remains explicit prerequisite child work owned by `REQ-392-RELOAD-PRESERVATION` and `REQ-392-TEST-PROOF` rather than being implied from adjacent routed-review coverage.
- why_it_matters: `REQ-T031` is an evidence-capture task, so the relevant after-state is a finalized packet that distinguishes satisfied worker proof from the remaining reviewer proof gap.
- redactions: none

### surface-comparison
| Contract surface | Observed surface | Validation surface | Status | Notes |
| --- | --- | --- | --- | --- |
| `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | file inspection plus `git diff -- specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` | `recorded` | T031 changes only the evidence artifact. |
| `routing-reload-core` | `src/core/orchestrator/Orchestrator.ts`; `tests/orchestrator.test.ts` | cited line ranges and focused test-name inspection | `recorded` | Worker reload preservation, worker retry redispatch, and routed reviewer dispatch were inspected without editing runtime code. |
| `reload-preservation child contracts` | `specs/009-eng-392-routing-reload-split/quickstart.md`; `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` | file inspection of the gap note plus child-contract ownership | `recorded` | Reviewer reload/restart redispatch remains mapped to prerequisite child work instead of being folded into T031. |
| `publication-handoff` | `none` | `n/a` | `intentionally_unverified` | Approval-recovery scenarios were considered only as adjacent contrast; T031 does not reopen approval/writeback implementation surfaces or treat after-worker-exit recovery as reload-preservation proof. |

### hygiene (with intentionally unverified live boundary)
- status: intentionally_unverified
- surfacesChecked: [`specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`, `src/core/orchestrator/Orchestrator.ts`, `tests/orchestrator.test.ts`, `specs/009-eng-392-routing-reload-split/quickstart.md`, `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`]
- redactions: [`none`]
- localPathHandling: `repo-relative paths only`
- protectedSurfaceChecks:
  - surface: `hermes/upstream-src/**`
    expectation: `must remain untouched`
    proof: `git diff -- specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` is the only scoped diff expected from T031; no vendored path is cited or modified in this packet.
- intentionallyUnverified:
  - boundary: `live tracker routing, live config reload, and live reviewer redispatch execution`
    reason: `evidence-only task; source and focused test-artifact inspection were used instead of live runtime mutation`
    nearestLocalProof: `tests/orchestrator.test.ts:2504-2647`; `tests/orchestrator.test.ts:3073-3209`; `tests/orchestrator.test.ts:5762-5892`
- findings:
  - `Worker retry redispatch after config reload already has branch-tip proof, while explicit reviewer redispatch-after-reload or restart proof remains mapped to REQ-392-RELOAD-PRESERVATION and REQ-392-TEST-PROOF.`

## ENG-2507 T033C focused runtime child preflight evidence

This packet records the focused ENG-2479 runtime-child preflight status through the approved lifecycle-bound capture path defined in `## ENG-2479 runtime child preflight proof matrix`. The accepted worker completion report for ENG-2507 is the authoritative evidence handle; this repo-side packet is the matching public-safe summary and must not be treated as a substitute for the lifecycle-bound completion-report record.

Because restricted worker runs cannot use direct package-command execution as the focused preflight path, and no service-owned execution artifact was attached to this worker run before handoff, the current focused preflight outcome is recorded as `blocked` with concrete findings instead of a success claim.

### Focused runtime child preflight status matrix

| Planned runtime child contract family | commandString | outcomeStatus | coverageSignal | Concrete findings |
| --- | --- | --- | --- | --- |
| `REQ-392-RUNTIME-ROUTING` | `npm test -- tests/issue-contract-lint.test.ts` | `blocked` | Two distinct project contexts keep distinct issue, workspace, and lifecycle buckets, and wrong-context or ambiguous routes fail closed instead of reusing another bucket. | Existing branch-tip routing evidence is summarized in `## ENG-2476 T030 runtime routing evidence snapshot`, but the approved focused preflight result must come from the service-owned execution/capture path in this issue's accepted completion report. Broad public CI or adjacent routed orchestrator coverage is not recorded here as focused preflight success. |
| `REQ-392-RELOAD-PRESERVATION` | `npm test -- tests/issue-contract-lint.test.ts` | `blocked` | The same project-context-qualified workspace, prompt/context identity, and lifecycle bucket survive reload or restart without duplicate redispatch or incomplete-turn burn while the run remains intentional. | Existing reload-preservation evidence is summarized in `## ENG-2477 T031 reload preservation redispatch evidence snapshot`, including the still-open reviewer redispatch-after-reload gap. That branch-tip evidence is background only and is not promoted to focused preflight success without the approved service-owned capture path. |
| `REQ-392-APPROVAL-WRITEBACK` | `npm test -- tests/issue-contract-lint.test.ts` | `blocked` | Pending, approved, rejected, cancelled, or replayed approval/writeback paths preserve one routed run lineage, one audit/writeback settlement story, and explicit terminal/recovery state instead of duplicating or losing state. | `quickstart.md` records broad approval-recovery coverage, but this file did not yet contain a dedicated focused approval/writeback snapshot before ENG-2507. Broad approval-recovery/public CI coverage therefore remains insufficient as focused preflight proof until the service-owned result is attached through the accepted completion report. |

### lifecycle-bound capture record

- `status`: `recorded`
- `surface`: `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md#eng-2507-t033c-focused-runtime-child-preflight-evidence`; accepted worker completion report fields `validationEvidence` and `acceptanceChecklist`; lifecycle persistence handles `IssueLifecycleRecord.completionReports[]`, `lastCompletionReportId`, and `summaryPointers.lastEvidenceCursor`
- `proof`: The approved-path contract at `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md:35-40` requires service-owned execution/capture for the focused command string `npm test -- tests/issue-contract-lint.test.ts` and directs workers to record a single `blocked` entry when that service-owned preflight has not run yet. This ENG-2507 section records that blocked state, exact command string, and per-family coverage signals without claiming that adjacent branch-tip test coverage or broad public CI satisfied the focused preflight.
- `why_it_matters`: ENG-2507 must capture exact command, outcome status, and family coverage signals through the approved path while preserving a durable lifecycle-bound review handle.
- `redactions`: none

### hygiene

- `status`: `recorded`
- `surfacesChecked`: [`specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`, `specs/009-eng-392-routing-reload-split/quickstart.md`, `tests/issue-contract-lint.test.ts`]
- `redactions`: [`none`]
- `localPathHandling`: `repo-relative paths only`
- `broadPublicCiDisposition`: `Broad public CI and adjacent branch-tip orchestrator coverage are cited only as background findings and are explicitly not treated as focused preflight proof.`
- `findings`:
  - `Focused runtime-child preflight remains blocked pending the approved service-owned execution/capture path; this packet records the blocker once and preserves the lifecycle-bound handoff path instead of looping on restricted local package-command execution.`
