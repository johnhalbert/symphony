# ENG-392 validation evidence formats

Use this planning contract when drafting or reviewing future ENG-392 child-issue evidence packets. The goal is to make five proof categories easy to distinguish at a glance:

1. `base-behavior`
2. `failing-before`
3. `passing-after`
4. `surface-comparison`
5. `hygiene` (the publication-hygiene bucket)

A reviewer should be able to tell what the baseline was, what failed before the fix, what passed after the fix, which authorized surfaces were actually touched, and whether the final evidence stayed safe to publish without rereading raw logs or internal implementation details.

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
- any protected-surface or no-touch checks relevant to the issue
- every live integration boundary that was intentionally not exercised
- a `findings` summary, even when it is an explicit zero-findings statement

Recommended shape:

```yaml
status: recorded
surfacesChecked:
  - <repo-relative path or safe surface label>
redactions:
  - none
localPathHandling: repo-relative paths only
intentionallyUnverified:
  - boundary: <Linear writeback | GitHub publication | live tracker lookup | none>
    reason: <out of scope | manual-only | credentials intentionally unavailable>
    nearestLocalProof: <repo-relative path, test name, or safe artifact>
findings: []
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
- surface: `<focused command | test | review artifact>`
- proof: `<failing assertion | blocker summary | missing requirement lines>`
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

### hygiene
- status: recorded
- surfacesChecked: [`<safe surface label>`]
- redactions: [`none`]
- localPathHandling: `repo-relative paths only`
- intentionallyUnverified:
  - boundary: `<live integration boundary | none>`
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
