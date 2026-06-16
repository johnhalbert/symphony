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

## Adjacent surface findings that need separate child authorization

Some adjacent surfaces share files or tests with routed runtime work, but they still require their own explicit child authorization. Do not treat file adjacency or "needed for the same test" as sufficient authorization.

| Adjacent behavior | Why it stays separate | Which child contract, if any, should authorize it | If not authorized |
| --- | --- | --- | --- |
| Read-only status and workspace HTTP payloads in `src/app/http.ts` and `tests/status-api.test.ts` | `StatusServer` co-locates issue status, workspace lookup, diagnostics, and other externally visible HTTP payload shapes with unrelated mutation routes. A runtime child does not implicitly authorize edits to status/workspace payloads or alias-resolution behavior. | Only a child contract that explicitly names those paths or explicitly scopes status/workspace HTTP payload behavior. The `operator-http-entrypoints` family label is **not** blanket authorization for every `StatusServer` route; by itself it covers authenticated approval and open-workspace route behavior, not broad status payload changes. | Exclude the status/workspace API edits or split them into a dedicated status/API child. |
| `POST /api/v1/issues/:issueId/open-workspace` token, route-evidence, and `workspace_path` behavior in `src/app/http.ts` and `tests/status-api.test.ts` | This mutation resolves workspace paths from live/durable state, consumes `X-Symphony-Token`, emits redacted route evidence, and triggers local workspace opening. It is an operator-facing side effect, not generic runtime work. | A child contract may authorize this surface through `operator-http-entrypoints`, but it should also explicitly list the touched `src/app/http.ts` and `tests/status-api.test.ts` paths when response shape, route evidence, or token semantics change. | Split the open-workspace mutation into its own child or keep it out of the publication candidate. |
| Cursor/editor launch and workspace-root enforcement in `cursor/src/CursorWorkspaceOpener.ts` and `tests/cursor-workspace-opener.test.ts` | This surface spawns `cursor`/`cursor.cmd` as a detached editor process and enforces workspace-root plus symlink-escape safety. Those are editor-adjacent local side effects, not routine runtime changes. | Require a child contract that explicitly names these paths. Pair it with `workspace-lifecycle` only when the change is about workspace root/path safety, and pair it with `operator-http-entrypoints` only when the HTTP trigger is also in scope. Do not treat either family label as implicit authorization for editor-launch changes unless the child contract names these paths directly. | Exclude the Cursor/editor launcher change or split it into a dedicated child. |

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

## Scenario matrix and explicit pass/fail criteria

| Scenario | Pass when... | Fail when... | Required repair |
| --- | --- | --- | --- |
| Happy-path mapped surface | Every changed or cited surface has a row, maps to at least one requirement ID, and is explicitly authorized by path, expected surface, or family label. | A row is missing, a requirement ID is blank, or the authorization is ambiguous. | Add the missing mapping, split the surface into a new child, or update the child contract before publication. |
| Unmapped surface | No tracked path, untracked artifact, or cited proof artifact is left outside the comparison table. | Any surface is absent from the table, marked `implicit`, or justified only by coupling to another authorized change. | Remove the surface from the publication candidate or expand the contract so the surface is explicitly authorized and validated. |
| Adjacent status/workspace API surface | A child that edits `src/app/http.ts` or `tests/status-api.test.ts` states whether it authorizes read-only status/workspace payloads, open-workspace mutation behavior, or both, and the comparison rows match that scope exactly. | Runtime or workspace work edits status payloads, alias-resolution behavior, token checks, or route-evidence output without explicit status/API or open-workspace authorization. | Split the status/API or open-workspace work into a dedicated child, or amend the contract to name the exact surfaces and validation required. |
| Cursor/editor launch surface | Any change to `cursor/src/CursorWorkspaceOpener.ts` or `tests/cursor-workspace-opener.test.ts` is explicitly authorized as editor-launch or workspace-root-safety work. | Cursor/editor launch changes are justified only by adjacency to runtime routing, workspace lookup, or HTTP route changes. | Split the Cursor/editor change into its own child or expand the contract to name those exact paths. |
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
