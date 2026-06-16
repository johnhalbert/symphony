# ENG-392 publication surface gate

This gate freezes the comparison format and pass/fail rules for any future ENG-392 child issue, review packet, or publication candidate. Its job is to stop the contract/publication mismatch seen on PR #286 from recurring.

Treat a **publication surface** as every tracked file, untracked artifact, cited proof artifact, and vendored subtree that would ship in the child diff or be quoted as evidence.

## Gate inputs

Gather all of the following before deciding whether a child change is publication-ready:

- The child issue's fenced JSON Issue Contract, including every stable requirement ID.
- The child issue's `Touched Surfaces` section and any stricter allowlist such as `Expected Surfaces`.
- The repo-relative tracked diff for the publication candidate.
- The repo-relative untracked/modified artifact list so scratch captures and debug leftovers are visible.
- The proof artifacts that will be cited in review or handoff evidence.
- The protected surface inventory and exclusions recorded in `specs/009-eng-392-routing-reload-split/quickstart.md`.

If the child contract is tests-only, the publication candidate is tests-only unless the contract is expanded first. Passing tests do not implicitly authorize coupled runtime, CLI, writeback, or workspace changes.

## Authorized surface family labels

Use the same family vocabulary recorded in the quickstart inventory when a child issue explicitly authorizes protected runtime surfaces:

| Family label | Use when the child contract intentionally authorizes changes to... |
| --- | --- |
| `routing-reload-core` | Project-context resolution, routed issue/workspace lookup, reload-safe runtime state, and redispatch preservation. |
| `publication-handoff` | Completion-report acceptance, pending publication approval, pull-request discovery/publication, and approval terminalization or recovery. |
| `writeback-guardrails` | Durable writeback records, lifecycle-bound tracker mutation checks, and PR-handoff audit/writeback validity. |
| `workspace-lifecycle` | Workspace key/path/branch/base-ref derivation, workspace metadata persistence, and workspace root safety. |
| `operator-http-entrypoints` | Authenticated approval and open-workspace HTTP routes plus their route-evidence or recovery behavior. |

Everything else stays excluded unless the child contract names it directly. In particular:

- `hermes/upstream-src/**` remains out of scope for ENG-392 child work and is never implicitly authorized by this gate.
- Adjacent PR #286 paths such as `src/app/ProjectContextRuntime.ts`, `src/cli.ts`, `src/core/approval/OperatorApprovalService.ts`, `tests/orchestrator.test.ts`, `tests/status-api.test.ts`, `tests/cursor-workspace-opener.test.ts`, and ad-hoc debug capture directories stay excluded unless a later child contract explicitly adds them.

## Surface comparison format

Use one row per published surface or cited artifact. Do not collapse multiple paths into a single row.

| Surface | Kind | Source of discovery | Requirement ID(s) | Authorized by | Evidence to cite | Gate disposition | Required action before publication |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `path/to/file.ts` or stable artifact label | `tracked file`, `untracked artifact`, `cited proof`, or `vendored source` | `git diff`, `git status`, review packet, or manual artifact inventory | One or more fenced JSON requirement IDs | Exact touched surface path, `Expected Surfaces` entry, or authorized family label | Public-safe repo-relative path, focused test name, safe metadata field, or review URL | `PASS`, `FAIL-unmapped`, `FAIL-debug`, `FAIL-vendored`, or `FAIL-redaction` | `none`, `remove surface`, `split into child`, `update contract`, `revert vendored path`, or `sanitize evidence` |

### Row completion rules

1. `Surface` must be repo-relative or a stable artifact label such as `review evidence excerpt` or `tmp-debug-docs-reviewer-redispatch-state/`.
2. `Requirement ID(s)` must cite at least one requirement from the child issue's fenced JSON contract. Never leave the field blank or justify a row as `implicit`.
3. `Authorized by` must name the exact touched path, expected surface, or one of the family labels above. `Needed for the tests` is not a valid authorization.
4. `Evidence to cite` must use public-safe fields only: repo-relative paths, sanitized metadata, stable IDs, safe URLs, and focused test names.
5. `Gate disposition` must be final. `TBD`, `maybe`, `coupled`, or `needs follow-up` are all failures until resolved.
6. Any row with a `FAIL-*` disposition blocks publication until the repair is complete and the row is rewritten to `PASS`.

### Copy-paste review template

````markdown
## Publication surface comparison

| Surface | Kind | Source of discovery | Requirement ID(s) | Authorized by | Evidence to cite | Gate disposition | Required action before publication |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `...` | `...` | `...` | `REQ-...` | `...` | `...` | `PASS` or `FAIL-*` | `...` |

Gate result: `PASS` or `FAIL`
Blocking rows: `<none>` or a repo-relative list of every `FAIL-*` row
````

## Recorded comparison — active test-proof contract (`REQ-392-TEST-PROOF`)

This recorded comparison applies the gate to the active Family E child contract in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`. It uses the widened PR #286 surface inventory in `specs/009-eng-392-routing-reload-split/quickstart.md` only as an exclusion baseline; those extra runtime, workspace, writeback, and status surfaces are not part of the active test-proof publication candidate.

Validation evidence in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` also keeps reviewer reload/restart redispatch proof mapped to prerequisite child work instead of treating adjacent routed-runtime behavior as implicitly authorized publication scope.

### Active candidate comparison

| Surface | Kind | Source of discovery | Requirement ID(s) | Authorized by | Evidence to cite | Gate disposition | Required action before publication |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tests/orchestrator.test.ts` | `tracked file` | Family E child contract plus the focused proof command inventory | `REQ-392-TEST-PROOF` | Exact touched surface `tests/orchestrator.test.ts` | `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E — `REQ-392-TEST-PROOF`); `specs/009-eng-392-routing-reload-split/quickstart.md` (`REQ-392-TEST-PROOF` focused proof command) | `PASS` | `none` |

Gate result: `PASS` only when the publication candidate contains the single `tests/orchestrator.test.ts` surface above.
Blocking rows: every additional runtime, CLI, workspace, writeback, status, adjacent non-contract test, debug, or vendored surface.

### Blocked dependency and exclusion inventory (must stay absent from the active candidate)

No unmapped surfaces remain in the active test-proof comparison: every historical extra surface from PR #286 is classified below as either a prerequisite dependency owned by another child family or an explicit exclusion that must stay out of `REQ-392-TEST-PROOF` publication.

| Surface that must stay absent | Why it is blocked from `REQ-392-TEST-PROOF` publication | Dependency or exclusion proof |
| --- | --- | --- |
| `cursor/src/CursorWorkspaceOpener.ts` | Workspace-opening behavior belongs to the protected `workspace-lifecycle` family, not the test-proof child's single test surface. | `specs/009-eng-392-routing-reload-split/quickstart.md` (T004 protected publication surface inventory for `cursor/src/CursorWorkspaceOpener.ts`); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E authorized surfaces list only `tests/orchestrator.test.ts`) |
| `src/app/ProjectContextRuntime.ts` | The original widened runtime file stays explicitly excluded from the active test-proof publication surface until a later child contract names it directly. | `specs/009-eng-392-routing-reload-split/quickstart.md` (explicit exclusions from the original mismatch surface); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E authorized surfaces list only `tests/orchestrator.test.ts`) |
| `src/cli.ts` | CLI wiring stays explicitly excluded from the active test-proof publication surface. | `specs/009-eng-392-routing-reload-split/quickstart.md` (explicit exclusions from the original mismatch surface); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E authorized surfaces list only `tests/orchestrator.test.ts`) |
| `src/core/CompletionReportService.ts` | Completion-report publication handling belongs to the protected `publication-handoff` family, not the focused proof child. | `specs/009-eng-392-routing-reload-split/quickstart.md` (T004 protected publication surface inventory for `src/core/CompletionReportService.ts`); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E dependency list keeps approval/writeback work prerequisite) |
| `src/core/approval/OperatorApprovalService.ts` | Approval-service runtime edits stay explicitly excluded from the active test-proof publication surface. | `specs/009-eng-392-routing-reload-split/quickstart.md` (explicit exclusions from the original mismatch surface); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E dependency list keeps approval/writeback work prerequisite) |
| `src/core/orchestrator/Orchestrator.ts` | Routed runtime, reload-preservation, and publication-handoff behavior remain prerequisite child work; the focused proof child may cite those invariants but may not publish the runtime file. | `specs/009-eng-392-routing-reload-split/quickstart.md` (T004 protected publication surface inventory for `src/core/orchestrator/Orchestrator.ts` and the PR #286 mismatch summary); `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` (ENG-2477 T031 reviewer reload/restart redispatch gap stays mapped to `REQ-392-RELOAD-PRESERVATION` and `REQ-392-TEST-PROOF`) |
| `src/core/workspace/WorkspaceManager.ts` | Workspace creation/path/branch metadata belongs to the protected `workspace-lifecycle` family, not the focused proof child. | `specs/009-eng-392-routing-reload-split/quickstart.md` (T004 protected publication surface inventory for `src/core/workspace/WorkspaceManager.ts`); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E authorized surfaces list only `tests/orchestrator.test.ts`) |
| `src/core/writeback/WritebackOutbox.ts` | Durable writeback settlement belongs to the protected `writeback-guardrails` family, not the focused proof child. | `specs/009-eng-392-routing-reload-split/quickstart.md` (T004 protected publication surface inventory for `src/core/writeback/WritebackOutbox.ts`); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E dependency list keeps approval/writeback work prerequisite) |
| `tests/cursor-workspace-opener.test.ts` | Adjacent workspace-opener test coverage stays explicitly excluded from the active test-proof publication surface. | `specs/009-eng-392-routing-reload-split/quickstart.md` (explicit exclusions from the original mismatch surface); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E authorized surfaces list only `tests/orchestrator.test.ts`) |
| `tests/status-api.test.ts` | Adjacent status API coverage stays explicitly excluded from the active test-proof publication surface. | `specs/009-eng-392-routing-reload-split/quickstart.md` (explicit exclusions from the original mismatch surface); `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` (Family E authorized surfaces list only `tests/orchestrator.test.ts`) |
| `tmp-debug-docs-reviewer-redispatch-state/` or other ad-hoc debug captures | Review-only scratch artifacts are never valid test-proof publication surfaces. | `specs/009-eng-392-routing-reload-split/quickstart.md` (contract/publication mismatch sources call out `tmp-debug-docs-reviewer-redispatch-state/` as non-fixture debug state); this gate's `Debug artifact` fail rule |
| `hermes/upstream-src/**` | Vendored source stays globally excluded and cannot be pulled into a focused proof publication candidate. | This gate's authorized-surface exclusions and vendored-source fail rule |

## Scenario matrix and explicit pass/fail criteria

| Scenario | Pass when... | Fail when... | Required repair |
| --- | --- | --- | --- |
| Happy-path mapped surface | Every changed or cited surface has a row, maps to at least one requirement ID, and is explicitly authorized by path, expected surface, or family label. | A row is missing, a requirement ID is blank, or the authorization is ambiguous. | Add the missing mapping, split the surface into a new child, or update the child contract before publication. |
| Unmapped surface | No tracked path, untracked artifact, or cited proof artifact is left outside the comparison table. | Any surface is absent from the table, marked `implicit`, or justified only by coupling to another authorized change. | Remove the surface from the publication candidate or expand the contract so the surface is explicitly authorized and validated. |
| Debug artifact | No ad-hoc captures, scratch outputs, or debug directories appear in the diff, status output, or cited evidence. | Any `tmp-`, `debug`, scratch, or reviewer-only capture artifact would publish or be cited as proof. | Delete it, convert it into an intentional fixture with explicit contract coverage, or keep it out of the publication candidate. |
| Vendored source | No path under `hermes/upstream-src/**` or other vendored source subtree appears in the diff or proof inventory. | Any vendored source path appears in the candidate diff, artifact list, or evidence packet. | Revert the vendored path. If the work truly depends on it, stop and author a separate protected-surface contract first. |
| Redaction and evidence hygiene | Every cited proof uses public-safe identifiers, repo-relative paths, safe URLs, and sanitized metadata only. | Any secret, token, private key, raw profile value, credential-bearing URL, raw environment value, or local absolute filesystem path appears in the comparison packet. | Sanitize or regenerate the evidence, then rerun the gate with the redacted proof set. |

## Gate decision rules

Declare the publication surface gate `PASS` only when all of the following are true:

- Every tracked changed path, untracked artifact, and cited proof surface has exactly one comparison row.
- Every row maps to at least one requirement ID and one explicit authorization source.
- Every row is `PASS`; there are zero remaining `FAIL-*` rows.
- No excluded adjacent surface appears unless the child contract names it directly.
- No vendored source path appears under `hermes/upstream-src/**` or another vendored subtree.
- No debug artifact remains in the candidate diff, artifact list, or evidence packet.
- No cited evidence leaks secret material, credential-bearing URLs, raw environment values, or local absolute filesystem paths.

Declare the publication surface gate `FAIL` if any of the following are true:

- A row is missing, unmapped, still ambiguous, or justified only by coupling.
- A tests-only child candidate includes runtime, CLI, writeback, workspace, HTTP, or other non-test surfaces that are not explicitly authorized.
- A debug artifact or scratch capture remains.
- A vendored source path is present.
- A cited proof artifact is not safely redacted.

## Recording rules

- Cite repo-relative paths, stable requirement IDs, focused test names, safe metadata fields, and public URLs only.
- Never paste secrets, tokens, raw credential values, private keys, raw environment values, or credential-bearing URLs.
- Never use local absolute filesystem paths in the comparison packet; convert them to repo-relative paths or stable artifact labels.
- If a row would require private implementation detail to justify publication, the row is not ready to pass the gate yet.
- When the gate fails, record the exact blocking rows and stop publication until the contract or diff is repaired.
