# Orchestrated Workflow Revision Analysis

Date: 2026-06-01

## Purpose

This note captures the revision-pattern analysis from local Symphony dogfood
state and turns it into durable design context. The goal is to separate agent
implementation quality from orchestration, merge-gate, CI, publication, and
writeback friction before changing workflow behavior.

This is not a final refactor spec. It is a working analysis document for
discussion.

## Local Evidence Snapshot

Source data:

- `symphony_workspaces/.symphony/runs`
- `symphony_workspaces/.symphony/issue-lifecycle`

Snapshot summary from the local state:

- 1,007 persisted run records.
- 726 runs with non-zero token telemetry.
- 134 lifecycle records.
- 200 persisted `fail` verdict-like records in the broad failure audit.
- 83 issues with at least one failed verdict-like record.
- 33 observed merge-gate fail records had no reviewer-style `findings` or
  `acceptanceResults`, with the actionable reason encoded in the
  `merge-gate:*` id or idempotency key.

Example persisted shape from local state:

```text
id: merge-gate:<issue-id>:pr-126:<head-sha>
idempotencyKey: merge-gate:<...>:repair:<head-sha>:mergeability:dirty:Pull request has merge conflicts with the base branch
verdict: fail
findings: []
acceptanceResults: []
```

The important point is not that merge-gate lacks information. The information
exists, but in some records it is not in the same fields used by normal reviewer
feedback. That makes analytics and operator interpretation too dependent on
parsing ids and special cases.

## Current Code Shape

### Lifecycle Record

`IssueLifecycleRecord` in `src/core/persistence/IssueLifecycleStore.ts` is the
main durable issue workflow record. It currently carries:

- `phase`
- `reviewRound`
- `incompleteTurnCount`
- `completionReports`
- `reviewVerdicts`
- `reviewFeedback`
- `mergeGate`
- `merge`
- `mergeConflict`
- `mergeConflictResolutionReports`
- `handoff`

`IssueMergeGateState` is already a structured durable model with fields for:

- gate status
- PR/head metadata
- required checks
- check states
- mergeability state
- repair run/report ids
- blocker fingerprint
- writeback keys
- supersession metadata

So the system already has a structured merge-gate state model. The ambiguity is
that merge-gate outcomes are also represented as `reviewVerdicts`.

### Reviewer Verdict Path

`ReviewVerdictService.submitReviewVerdict()` handles reviewer-submitted pass or
fail verdicts.

For a reviewer `fail`:

- `reviewRound` increments.
- `phase` returns to `implementation`, or `blocked` if the max review round
  ceiling is reached.
- `incompleteTurnCount` resets to `0`.
- a reviewer-authored `IssueReviewVerdictRecord` is appended to
  `reviewVerdicts`.
- writeback plans a revision-request comment and state transition.

This is a true "reviewer requested a code revision" path.

### Merge-Gate Path

`MergePolicyService.handleMergeGateFailure()` is an automated gate path, not a
reviewer-agent judgment.

It is driven by tooling checks such as:

- required check failure or actionable missing check
- PR mergeability conflict
- stale or superseded head conditions

For a merge-gate failure, the service currently:

- computes a merge-gate repair or blocked state
- writes Linear comments/transitions through service-owned writeback
- creates an `IssueReviewVerdictRecord` with `reviewer:
  "symphony-merge-gate"` and an id starting with `merge-gate:`
- stores `acceptanceResults`, `findings`, and `evidence` from helper functions
  such as `mergeGateFindings()` and `mergeGateEvidence()`
- updates `mergeGate` with structured gate state
- increments or reuses `reviewRound` depending on the repair cycle

Current code is better than some older persisted records: it does populate
merge-gate findings/evidence for new failures. The local persisted state still
contains records where the merge-gate reason is effectively only in the
idempotency key and `mergeGate`.

### Read Models Already Special-Case Merge Gate

`src/app/http.ts` contains `isMergeGateVerdict()` logic and skips merge-gate
verdicts when selecting the latest reviewer verdict for issue details. That is
evidence the code already treats merge gate as semantically different from
reviewer feedback, even though both live in `reviewVerdicts`.

## Clarification: "Empty Findings"

"Empty findings" means a persisted `fail` record looked empty when analyzed as a
normal reviewer verdict:

- `findings` empty
- `acceptanceResults` empty or no unsatisfied acceptance result
- no reviewer-authored change request body

Most of those were not reviewer-agent failures. They were automated merge-gate
records. The reason could still be recovered from:

- the `mergeGate` state
- the `merge-gate:*` id or idempotency key
- check/mergeability metadata

The suggested improvement is not to make agents explain merge-gate failures.
The suggested improvement is to make Symphony persist and expose the source and
reason as first-class structured fields so analytics and operators do not need
to infer it.

## Why This Matters

The current broad metric "failed verdict" mixes at least three different
failure domains:

1. Reviewer requested implementation revisions.
2. Automated merge-gate or CI repairs.
3. Platform/process/tooling blockers.

Those domains have different owners, prompts, routing, and success metrics.
Keeping them conflated causes bad conclusions:

- Agent revision averages blame workers for merge conflicts and CI state.
- Reviewers may spend tokens re-reviewing code when the blocker is PR
  mergeability.
- Operators see "failed review" instead of "merge conflict" or "CI failure".
- Max review-round limits can be consumed by merge repair loops.
- Workflow improvement work gets misprioritized because implementation defects
  and orchestration defects look the same.

## Proposed Refactor Direction

### Classification Before Data Movement

The first refactor should be classification, not a wholesale lifecycle rewrite.

Add structured classification to persisted workflow events and read models:

```ts
type WorkflowFailureSource =
  | "reviewer"
  | "merge_gate"
  | "merge_conflict"
  | "ci"
  | "publication"
  | "writeback"
  | "credential"
  | "orchestrator";

type WorkflowFailureDomain =
  | "implementation"
  | "integration"
  | "platform"
  | "process"
  | "user";

type WorkflowFailureReasonKind =
  | "acceptance_criteria_not_satisfied"
  | "missing_tests"
  | "merge_conflict"
  | "required_check_failed"
  | "required_check_missing"
  | "stale_pr_head"
  | "review_feedback_approval_failed"
  | "publication_failed"
  | "writeback_failed"
  | "credential_resolution_failed";
```

Candidate derived booleans:

- `requiresImplementationRevision`
- `requiresMergeRepair`
- `requiresServiceRepair`
- `requiresUserDecision`
- `countsTowardAgentRevisionRate`
- `countsTowardMergeGateRepairBudget`

This classification can initially be derived at read time from existing
records, then written durably once stable.

### Revision Reason Telemetry

This is a relatively direct data-model improvement. Today the durable reviewer
verdict shape has `verdict`, `acceptanceResults`, `findings`, `evidence`,
`reviewer`, and `idempotencyKey`. Merge-gate compatibility verdicts can often
be distinguished by `reviewer: "symphony-merge-gate"`, `id:
"merge-gate:*"`, `idempotencyKey: "merge-gate:*"`, or the separate `mergeGate`
state. That is parseable, but it puts analytics and workflow routing in the
wrong place: idempotency keys should dedupe operations, not explain ownership or
revision reason.

Add structured reason telemetry to fail verdicts and fail-like compatibility
records:

```ts
interface RevisionReasonTelemetry {
  source: WorkflowFailureSource;
  reasonKind: WorkflowFailureReasonKind;
  isImplementationDefect: boolean;
  isProcessGate: boolean;
  requiresCodeChange: boolean;
  requiresUserOrServiceFix: boolean;
  classificationSource: "explicit" | "derived_legacy";
}
```

Field semantics:

- `reasonKind`: the primary enum for the failure reason. This is the field
  analytics should group by.
- `isImplementationDefect`: true when the reviewer found a code, test,
  acceptance, or behavior problem in the implementation that should count as an
  implementation revision.
- `isProcessGate`: true when the failure came from workflow infrastructure,
  merge gate, CI gate, publication, writeback, credential, orchestration, or
  other non-reviewer process checks.
- `requiresCodeChange`: true when the next successful attempt requires worktree
  changes from a worker or repair worker.
- `requiresUserOrServiceFix`: true when the next successful attempt requires
  user action, service-owned action, credential repair, GitHub/Linear writeback
  repair, or orchestration/tooling repair rather than ordinary implementation
  changes.
- `classificationSource`: `explicit` for new records that carry first-class
  telemetry, `derived_legacy` for old records classified by compatibility
  heuristics.

Important invariants:

- Do not infer primary reason from `idempotencyKey` for new records.
- Do not treat freeform `findings` as the primary machine-readable
  classification.
- Keep `findings`, `acceptanceResults`, and `evidence` as user-facing and
  reviewer-facing narrative/detail.
- Compute the boolean flags service-side from `source` and `reasonKind` where
  possible, rather than trusting an agent to set mutually consistent booleans.
- Allow multiple booleans to be true when reality requires it. For example, a
  merge conflict is a process gate and also requires code changes, but it is not
  a reviewer-identified implementation defect.

Suggested write behavior:

- Reviewer-agent fail verdicts must provide an enum `reasonKind` through the MCP
  payload. Symphony validates it and computes the booleans.
- Merge-gate failures are authored by Symphony, so the service should set
  `source: "merge_gate"` and the exact `reasonKind` deterministically from check
  and mergeability evidence.
- Publication, credential, GitHub review feedback, and Linear writeback failures
  should be represented as process/tooling blockers or compatibility fail-like
  records with explicit telemetry, not as generic reviewer failures.
- Legacy records should be classified in read models with
  `classificationSource: "derived_legacy"` until migrated or superseded.

This makes the metrics direct:

- Implementation revision rate: records where `isImplementationDefect` is true.
- Merge/CI repair pressure: records where `isProcessGate` is true and
  `requiresCodeChange` is true.
- Platform/writeback friction: records where `isProcessGate` is true and
  `requiresUserOrServiceFix` is true.
- Ambiguous legacy debt: records where `classificationSource` is
  `derived_legacy`.

### Split Counters

`reviewRound` currently measures reviewer revision loops and is also used by
merge-gate repair handling. That is operationally useful for blocking repeated
repair loops, but analytically ambiguous.

Proposed future counters:

- `reviewRevisionRound`: reviewer-requested implementation revisions.
- `mergeGateRepairRound`: automated merge-gate repair attempts.
- `processBlockerCount`: service/tooling blocker occurrences.
- `incompleteTurnCount`: keep as-is for worker runs that end without accepted
  handoff.

If changing the durable schema is too large at first, expose these as derived
read-model fields while leaving `reviewRound` intact.

### Keep `mergeGate` Canonical For Gate State

The existing `mergeGate` object should remain the canonical structured gate
state. The question is what to do with the compatibility `reviewVerdict`
representation.

Options:

1. Keep merge-gate records in `reviewVerdicts`, but require explicit fields:
   `source: "merge_gate"` and `reasonKind`.
2. Move automated gate events to a separate collection such as
   `workflowBlockers` or `gateEvents`, and keep `reviewVerdicts` for reviewer
   agents only.
3. Do both temporarily: write the new collection, keep compatibility verdicts,
   and migrate read models gradually.

Recommendation: start with option 1 plus derived read models. Move to option 3
if the UI and analytics remain hard to reason about.

### Routing After Classification

Desired behavior after classification:

- Reviewer fail with implementation findings -> implementation worker receives
  reviewer findings and acceptance gaps.
- Merge conflict or stale PR head -> merge repair worker receives merge-gate
  prompt and current PR/base details.
- CI failure or missing required check -> check repair worker receives failed
  check details and validation target.
- Review-feedback approval failure -> service/platform repair path, not worker
  implementation revision.
- Publication/writeback/credential failure -> service/platform repair path or
  user escalation, not reviewer rerun.

This should reduce token spend by avoiding repeated general-purpose review and
implementation loops for blockers that can be routed directly.

## Other Revision Patterns To Discuss

The remaining clusters from the local audit need their own detailed review.

### Merge Gate, CI, And Branch Conflict

Observed as the largest cluster. Many failures are PR conflicts, stale heads, or
missing/failing `Typecheck and test`.

Current prompt and routing shape:

- The normal dogfood worker prompt in `WORKFLOW.md` requires focused changes,
  meaningful validation, and service-owned PR publication via
  `submit_completion_report`.
- It does not currently require the normal implementation worker to prove that
  the branch has latest upstream `main` applied before requesting review.
- It also does not require the worker to prove the lifecycle-bound PR's required
  GitHub checks are already passing before requesting review.
- `hermes/templates/worker/SOUL.md` reinforces the handoff contract: leave
  changes uncommitted/unpushed and let Symphony publish after accepting the
  completion report.
- `renderCompletionMcpHandoffPrompt()` repeats the same service-owned
  publication handoff instructions.
- `formatWorkerMergeGatePromptResult()` injects a dedicated "Symphony Merge Gate
  Repair" section only after `lifecycle.mergeGate.status` is
  `repair_dispatched` or `blocked`.
- That merge-gate repair prompt tells the worker to reconcile with
  `origin/main`, resolve conflicts, fix failing/missing checks, validate, leave
  changes uncommitted/unpushed, and submit a new completion report.
- The codebase also has a scoped `merge_conflict_resolution` run phase and
  `submit_merge_conflict_resolution` MCP tool, but the current orchestrator
  method `isMergeConflictState()` returns `false`, so the dogfood path does not
  appear to route ordinary merge-gate conflicts into that separate phase today.

This means there are two distinct places where merge and CI responsibility can
live:

1. Normal worker completion-readiness checks, before the first completion report.
2. Orchestrator merge-gate checks, after publication/review or before gated
   merge.

Both are useful, but they should not be treated as interchangeable. Worker
checks are heuristic and workspace-local. Orchestrator checks are authoritative
because they run against the lifecycle-bound PR, service-owned publication
result, GitHub mergeability, required checks, and current base head.

Likely improvement areas:

- preflight mergeability and required checks before reviewer dispatch
- route gate failures directly to merge repair
- avoid consuming reviewer revision budget for merge repair attempts
- expose gate failure source and actionable state in the dashboard

Proposed responsibility split:

- Normal implementation worker: before `submit_completion_report`, run local
  validation and report whether upstream/base freshness was checked. If it can
  safely fetch and compare against the configured base, it should detect obvious
  drift. It should not commit, push, or mutate the lifecycle-bound PR.
- Completion-report service: after accepting a report and doing service-owned
  publication, record the exact PR/head/base metadata. This is the first point
  where Symphony can make authoritative statements about the lifecycle-bound PR
  head.
- Reviewer dispatch gate: before starting an expensive reviewer run, Symphony
  should check whether the lifecycle-bound PR is mergeable enough and whether
  configured checks are passing, pending, missing, or failing. If not reviewable,
  do not dispatch a reviewer just to rediscover the gate failure.
- Merge-gate repair worker: when the issue is blocked by branch/CI state, inject
  a focused repair prompt. This can initially remain the same worker role and
  implementation phase with a merge-gate repair prompt. A separate run phase or
  role should be introduced only if it materially changes permissions, MCP tools,
  metrics, or dispatch rules.
- Gated merge: keep the final authoritative check at merge time. Even if the
  worker and pre-review gate were clean earlier, the base branch or CI state can
  change later.

### Option: Post-Publication Pre-Review Gate

The current dogfood flow already publishes or reuses the service-owned PR inside
`submit_completion_report` when `github.publish_pull_requests` is enabled and
operator approval is not required. However, with `github.pr_handoff.enabled:
false`, the completion report finalization path accepts the report, records PR
metadata, and transitions directly to review without waiting for required GitHub
checks. The required `Typecheck and test` check is enforced later by gated
merge, not by worker submission.

Creating or updating the PR before returning from worker submission is therefore
not a new publication concept. The design question is whether
`submit_completion_report` should also run a bounded authoritative gate before
declaring the worker handoff accepted for review.

Potential streamlined flow:

1. Worker finishes local implementation and calls `submit_completion_report`.
2. Symphony commits, pushes, and creates or updates the lifecycle-bound PR.
3. Symphony records the exact PR number, branch, head SHA, and base metadata.
4. Symphony checks PR mergeability and required checks for that exact head.
5. If the PR is mergeable enough and required checks pass, Symphony finalizes the
   completion report and moves the issue to review.
6. If mergeability is conflicted or a required check fails quickly, Symphony
   returns a structured repair result to the still-running worker session and
   keeps the lifecycle in an implementation or merge-gate repair phase.
7. If checks are still pending or GitHub mergeability is still unknown after a
   configured timeout, Symphony persists `published_pending_checks` state and
   returns a non-terminal result. The orchestrator can later resume or dispatch
   a focused repair only if the pending state becomes actionable.

This could let the same worker fix immediate merge conflicts and fast CI
failures in the same session, but only if the MCP/tool contract is changed. The
current `CompletionReportResult` is a terminal accepted/replayed shape:

```ts
interface CompletionReportResult {
  accepted: true;
  replayed: boolean;
  report: IssueCompletionReportRecord;
  writebackOperations: WritebackOperation[];
}
```

For same-session repair, the result needs explicit non-terminal states, for
example:

```ts
type CompletionReportResult =
  | { status: "accepted_for_review"; ... }
  | { status: "published_pending_checks"; pullRequest: ...; headSha: string; ... }
  | { status: "repair_required"; reasonKind: "merge_conflict" | "required_check_failed" | "required_check_missing"; ... };
```

The worker prompt would also need to say that `submit_completion_report` can
return a repair-required result and that the worker must continue only when that
structured result is returned. Otherwise agents may treat a tool error or
non-accepted response as a failed handoff instead of as actionable repair input.

Recommended constraints if we add this:

- Use a bounded wait, not an indefinite CI wait. Long CI runs should not keep an
  agent session idle for tens of minutes.
- Distinguish `failed`, `conflicted`, `missing_actionable`, `pending`, and
  `unknown`; only the first three should normally ask the same worker to repair.
- Keep the lifecycle-bound PR and head SHA canonical. If the worker edits after a
  repair result, Symphony must republish and re-check the new head, not reuse
  stale check results.
- Do not transition to review until the post-publication gate has either passed
  or intentionally timed out into a durable pending state.
- Keep final gated merge checks even if this pre-review gate passes, because the
  base branch and CI state can change after reviewer dispatch.
- Count same-session gate repairs separately from reviewer-requested
  implementation revisions.

Open implementation questions:

- Should this be modeled by extending `submit_completion_report`, or by adding a
  distinct `prepare_review_handoff`/`finalize_review_handoff` style contract?
- What timeout is acceptable for dogfood CI before the worker session should be
  released?
- Should `published_pending_checks` keep the issue in implementation, move it to
  a new waiting phase, or use a merge-gate repair phase only after failure
  becomes actionable?
- What check-log evidence should be returned to the worker for a same-session CI
  repair?
- How should duplicate PR comments, writeback operations, and completion report
  ids be deduped across publish, repair, and republish cycles?

### Option: Local CI Parity And Upstream Rebase Preflight

The main CI workflow is intentionally plain. The required `Typecheck and test`
job runs on Ubuntu with Node `22.12`, sets `SYMPHONY_REAL_SMOKE=0`, and executes
the repository, web, and extension npm commands directly. The separate
`real-smoke` job is manual and secret-backed; it is not part of the normal PR
required check.

That means local CI parity is practical, but the command list should not be
copied into Symphony prompts, MCP handlers, and GitHub Actions independently.
That would create a drift point every time CI changes.

Recommended source-of-truth shape:

- Add one repository-owned command, for example `npm run ci:required`, that runs
  the complete normal PR check locally.
- Change `.github/workflows/ci.yml` so the required `Typecheck and test` job
  invokes that command instead of spelling out every npm step.
- Have Symphony's worker prompt, MCP submission gate, or service-owned
  validation helper invoke the same command.
- Keep the command runnable before dependencies are installed. A plain npm
  script that starts with `npm ci` is acceptable; a Node/tsx script that depends
  on repo dependencies before install would not be.

Today that canonical command would expand to:

```sh
npm ci
npm run typecheck
npm test
npm ci --prefix web
npm run typecheck --prefix web
npm test --prefix web
npm run build --prefix web
npm run smoke:browser --prefix web
npm run smoke:browser-production --prefix web
npm run extension:ci
npm run extension:typecheck
npm run extension:test
npm run extension:build
```

This should materially reduce CI repair churn. It catches most deterministic
typecheck, unit, build, extension, and browser smoke failures before Symphony
spends reviewer tokens or waits on GitHub checks.

The design should still treat local parity as a readiness gate, not as a
replacement for PR checks:

- GitHub Actions runs on a clean Ubuntu runner with Node `22.12`; local workers
  may run on Windows, macOS, or an already-mutated dependency tree. `npm ci`
  helps, but it does not erase every platform difference.
- Required GitHub checks attach to the published PR head SHA. Local validation
  can prove the worker workspace passed, but only GitHub can prove the exact
  lifecycle-bound PR head has the required status.
- Base branch state can advance after the worker fetches or rebases. Final
  mergeability and CI still need to be checked after publication and again at
  merge time.
- Browser smoke can be locally deterministic only if the worker host has a
  Chromium-compatible browser available through the script's normal discovery or
  `SYMPHONY_WEB_BROWSER_EXECUTABLE`/`CHROME_BIN`.

The upstream rebase part needs structure because Symphony's normal worker
contract leaves changes uncommitted and unpushed. A naive `git rebase
origin/main` against a dirty worktree is easy to get wrong.

Safer models:

1. Worker-owned preflight: the prompt explicitly allows local-only fetch/rebase
   preparation, such as fetching `origin/main`, applying the current worktree
   changes onto the latest base through a documented stash or validation branch
   flow, resolving conflicts locally, then running the full CI parity suite.
   The worker still must not push or create/update the lifecycle PR.
2. Service-owned preflight: after `submit_completion_report`, Symphony creates a
   temporary local validation commit or isolated validation worktree, rebases or
   reapplies the patch onto `origin/main`, runs the full CI parity suite, and
   only then publishes the lifecycle-bound PR. This is more deterministic and
   less dependent on agent discipline.
3. Hybrid: worker runs a fast local readiness subset during implementation, and
   Symphony runs the exact full CI parity plus upstream rebase preflight before
   publication or before reviewer dispatch.

Recommended direction:

- Add a first-class `ci:required` command and make both GitHub Actions and
  Symphony call it. The workflow file should become an entrypoint, not the only
  source of truth.
- Treat `.github/workflows/ci.yml` parsing as a fallback or audit aid, not the
  primary contract. Workflow YAML is good orchestration metadata; package
  scripts or checked-in scripts are better local execution APIs.
- Capture the base ref, base SHA, head SHA or patch fingerprint, command list,
  exit status, elapsed time, and log artifact pointer in the completion report
  or lifecycle validation evidence.
- Treat a local rebase conflict or local CI failure as `repair_required` before
  reviewer dispatch, with reason kinds such as `local_rebase_conflict` and
  `local_required_check_failed`.
- Still publish and observe the lifecycle-bound PR head afterward, because the
  GitHub required check is the authoritative external gate.

Recommended caution:

- Do not rely only on the worker prompt for branch freshness or CI readiness.
  Agents can miss checks, use stale local refs, or validate the wrong head.
- Do not rely only on orchestrator gates either. If workers routinely submit
  stale branches, the orchestrator will save correctness but waste review and
  repair cycles.
- Add structure before adding another agent type. The first step should be
  explicit gate classification, pre-review gating, and clearer prompt
  obligations. A dedicated "merge repair" agent/phase can come after the routing
  model is proven.

### Review Feedback Approval Gate

Several loops reported no implementation defect, but could not pass because the
reviewer could not create a whole-PR `APPROVE` review through
`submit_pull_request_review_feedback`.

Current split:

- `submit_pull_request_review_feedback` owns the GitHub write path. It uses
  reviewer-scoped GitHub credentials, resolves the lifecycle-bound PR/head SHA,
  posts PR review feedback to GitHub, and returns durable GitHub URLs.
- `submit_review_verdict` owns the Symphony review decision. It records the
  pass/fail verdict, acceptance results, findings, and evidence without exposing
  GitHub write credentials to the verdict path.

That split is conservative, but it couples a reviewer pass to an upstream
GitHub write succeeding first. If GitHub rejects the approval, for example with
HTTP 422/self-approval/permission/payload errors, the implementation review can
be correct while the workflow still cannot advance.

Direction:

- Treat the reviewer decision as separate from GitHub PR feedback publication.
- It is acceptable for a future tool shape to combine the verdict and intended
  PR feedback into one call, as long as the handler records the verdict and the
  GitHub publication result as separate outcomes.
- Do not add a durable feedback retry queue yet. That would be useful later, but
  it is more workflow machinery than needed for the immediate dogfood fix.

Proposed near-term behavior:

- Pass verdict + GitHub `APPROVE`/feedback failure:
  - record the pass verdict durably
  - write the pass verdict and review summary to Linear
  - move the issue to `Blocked`, not `Ready to Merge`
  - state that GitHub PR approval/review feedback could not be posted
  - include the failed GitHub call details in the Linear comment/blocker:
    operation, endpoint or high-level action, PR number, head SHA, event,
    response status, sanitized GitHub message/errors, credential profile or
    capability used, and any returned request/correlation id
  - tell the user that they must add the PR approval, merge the PR, and advance
    the issue manually
  - keep auto-merge gated, because there is no service-recorded GitHub approval
- Fail verdict + GitHub `REQUEST_CHANGES`/feedback failure:
  - record the fail verdict durably
  - write the findings and acceptance gaps to Linear
  - continue the normal worker repair path
  - add an audit note that GitHub PR feedback could not be posted, with the same
    sanitized failed-call details
  - do not block solely on GitHub feedback write failure

Likely improvement areas:

- preflight reviewer identity and permission against lifecycle-bound PR/head
- validate the MCP payload shape before the reviewer spends a full review turn
- persist a distinct `review_feedback_approval_failed` process blocker
- do not count this as implementation revision

### Publication, Writeback, And Credentials

Repeated findings involve GitHub App vs static token selection, private key
propagation, service-owned publication, Linear Done transition verification,
and skipped/dry-run writebacks.

This is not just a request for more unit tests. The underlying issue is a
credential and writeback boundary: the workflow needs to prove that the right
service capability performed the right external write, using the intended
credential profile, and that the result was durably recorded without exposing
secret material to the wrong process, prompt, transcript, Linear comment, or
status projection.

Current shape:

- `GitHubCredentialResolver` already assigns GitHub capabilities to roles:
  worker-owned discovery, reviewer-owned review evidence and review feedback,
  and service-owned publication and merge.
- `LinearCredentialResolver` treats `linear.writeback` as service-owned.
- `McpSubprocessEnvironment` builds a reduced environment for MCP subprocesses
  instead of passing the whole parent environment:
  - `completion-report-mcp` receives GitHub publication credentials only when
    PR publication is enabled and operator approval does not intentionally hold
    those credentials back.
  - `review-feedback-mcp` receives reviewer-scoped GitHub review feedback
    credentials.
  - `review-verdict-mcp` does not need GitHub write credentials.
- For GitHub App credentials, the subprocess environment may propagate private
  key material by env var or private key path when the selected profile requires
  it. That propagation is expected for the service/reviewer write path, but it
  is also the sensitive boundary that needs explicit policy and regression
  coverage.

Policy improvements:

- Treat credential routing as a fail-closed capability contract, not a best
  effort convenience:
  - publication and merge credentials are service-owned only
  - review feedback credentials are reviewer-owned only
  - Linear writeback credentials are service-owned only
  - worker sessions should not receive publication, merge, review feedback, or
    Linear writeback credentials
- Prefer named credential profiles over ambient fallback credentials for
  write-capable operations. If a capability-specific profile is configured but
  cannot be resolved, fail with a process blocker instead of falling back to a
  broader `GITHUB_TOKEN` or default app credential.
- That fallback concern is primarily about Symphony runtime/service credential
  resolution: `parseServiceConfig` reads `github.token` and, when absent,
  resolves `$GITHUB_TOKEN`; `CredentialProfileRegistry` then uses that legacy
  GitHub token for unassigned GitHub capabilities; `McpSubprocessEnvironment`
  may pass that resolved token into the specific MCP subprocess that needs a
  write-capable GitHub client. This is distinct from agent shell behavior.
- Agent shell behavior is a separate control plane. A worker or reviewer can
  invoke `git`, `gh`, `ssh`, `curl`, or PowerShell GitHub API calls from its
  terminal tool. Those commands may use ambient desktop/user credentials,
  credential managers, existing `gh` auth, SSH keys, or inherited env if the
  harness process exposes them. That is why the command-blocking proposal also
  includes PATH shims, non-interactive Git/GitHub env, and service-owned
  replacement tools.
- Never place raw tokens, private keys, authorization headers, or signed request
  details in prompts, MCP context files, run transcripts, lifecycle records,
  Linear comments, GitHub comments, status APIs, or telemetry.
- Selected-credential telemetry should record only non-secret metadata:
  capability, role, profile name, credential kind, source, GitHub App
  installation id when safe, external operation, request/correlation id, and
  sanitized upstream status/error message.
- External writeback failures should become process/tooling blockers or audit
  notes, not implementation revision requests, unless the failure exposes an
  actual defect in the worker's code.

Writeback outcome improvements:

- Distinguish these outcomes durably:
  - `not_attempted_policy`: skipped because dry-run, operator approval, or a
    disabled publication/writeback mode intentionally prevented the external
    write
  - `not_attempted_missing_credential`: skipped because the required
    service-owned credential was unavailable
  - `failed_external_call`: attempted but GitHub or Linear rejected the request
  - `succeeded_unverified`: the call returned success but the desired remote
    state could not be confirmed
  - `succeeded_verified`: the call succeeded and follow-up verification observed
    the expected PR, review, comment, merge state, or Linear transition
- Do not treat skipped or dry-run writebacks as successful live writebacks.
  Existing tests already guard some of this for the outbox; the workflow should
  carry the distinction all the way into lifecycle state and user-facing status.
- Linear Done / Ready-to-Merge transitions should verify the resulting state, or
  record a process blocker that includes the sanitized failed Linear operation.
- GitHub publication, review feedback, and merge writebacks should similarly
  verify the expected remote state when practical.

Test and smoke coverage improvements:

- Keep the existing resolver/unit tests, but add an end-to-end credential
  smoke layer that exercises the real config, MCP subprocess environment,
  selected client construction, and writeback processor boundary together.
- The smoke layer should use fake GitHub/Linear servers or sandbox fixtures, not
  real production secrets in CI.
- It should assert both positive and negative credential space:
  - `completion-report-mcp` has service publication credentials only in the
    modes where it is supposed to publish
  - `review-feedback-mcp` has reviewer feedback credentials and lacks
    publication/merge credentials
  - `review-verdict-mcp` lacks GitHub write credentials
  - worker/reviewer agent shells do not receive service publication, merge, or
    Linear writeback secrets
  - status/activity projections redact writeback bodies and secret-looking
    values
- The smoke layer should cover publication, review feedback, merge, Linear
  tracker reads, Linear comments/transitions, dry-run/skipped writebacks, and
  failure paths with sanitized upstream error details.

Likely improvement areas:

- clearer credential policy for service-owned vs agent-owned capabilities
- fail-closed credential profile resolution for write-capable operations
- end-to-end credential/writeback smoke coverage across MCP subprocesses and
  service-owned clients
- explicit selected-credential telemetry without secret material
- durable writeback outcome categories instead of conflating skipped, dry-run,
  failed, unverified, and verified writes
- separate platform/tooling blockers from reviewer verdicts
- retry semantics for recoverable writeback failures

### Durability, Replay, And Terminal State

Many implementation defects are in the form "live behavior works, but replay
from persisted records/events after restart does not reconstruct the same
terminal state."

Definitions:

- `live state` means the state Symphony has while the current Node process,
  orchestrator instance, harness run, approval handler, or writeback processor is
  actively executing. This includes in-memory objects such as active run entries,
  pending callbacks, freshly returned service results, abort signals, provider
  limit signals, and recently observed harness/tool events.
- `replay/restart state` means the state a fresh Symphony process can recover
  later without those in-memory objects. It is reconstructed from durable
  records such as `issue-lifecycle/*.json`, run `meta.json`, run `events.jsonl`,
  writeback outbox records, and verified remote tracker/GitHub state.

The invariant is that any workflow decision that matters after the current call
returns must be represented durably enough for a new process to make the same
decision. A same-process code path may know "the worker handoff was accepted,"
"the issue is terminal," or "this run was cancelled because of provider limits"
because it still has a result object or callback in memory. After restart, that
knowledge disappears unless the lifecycle record, run record, transcript event,
or writeback record captured it with enough structure.

Confidence and scope:

- The current analysis identifies a recurring defect pattern and representative
  replay-sensitive areas from observed revision reasons and targeted code
  inspection.
- It should not be treated as an exhaustive inventory of every missing required
  state field. That would require a dedicated replay-state audit.
- Confidence is high that durability/replay is a real workflow weakness.
  Confidence is medium that the examples below cover the dominant observed
  cases. Confidence is intentionally low on "the list is complete" until the
  audit is done.

To make the list exhaustive, build a replay decision matrix:

- Enumerate every decision Symphony can make after a call returns or after
  process restart: dispatch, resume, retry, cancel, terminalize, writeback,
  publish, merge-gate repair, review handoff, issue-breakdown application,
  status projection, and duplicate MCP submission handling.
- For each decision, record:
  - the durable source of truth used after restart
  - the facts required to make the decision
  - where those facts are written
  - the idempotency key or duplicate-detection rule
  - terminal precedence when multiple outcomes are possible
  - the restart/replay test that proves the behavior
- Treat any decision that depends on in-memory state, ambiguous transcript text,
  or a best-effort remote lookup without durable correlation as a candidate
  defect.
- Add crash-boundary tests around important seams: after the durable write
  before the external side effect, after the external side effect before the
  durable write, after terminalization before writeback drain, and after
  writeback success before verification/projection.

Examples:

- Accepted completion report:
  - Live path: `submit_completion_report` returns accepted and the orchestrator
    immediately knows to enqueue review/writeback.
  - Restart path: a fresh process must read the lifecycle record and outbox and
    avoid treating the worker as still active or enqueueing duplicate handoff
    side effects.
- Failed planning:
  - Live path: the planner run fails and the current orchestrator instance marks
    the run terminal.
  - Restart path: run metadata and lifecycle state must still explain that
    planning failed and should not be retried or displayed as an active plan.
- Cancellation/provider limits:
  - Live path: the abort signal or provider-limit event is observed in the
    harness loop.
  - Restart path: persisted run metadata must preserve the cancellation outcome
    or provider-limit blocker, so the status API does not show a stale active
    run or dispatch an inappropriate retry.
- Merge-conflict repair:
  - Live path: the merge gate observes a conflict and dispatches a repair run.
  - Restart path: lifecycle merge-gate/merge-conflict fields must still show
    whether repair is pending, resolved, still conflicted, or blocked, including
    attempt counts and blocker reason.
- Terminal ordering:
  - Live path: multiple terminal-ish signals can arrive close together, such as
    SDK wait error, cancellation, provider limit, or state transition.
  - Restart path: persisted terminal precedence must be deterministic, so the UI
    and orchestrator do not flip between failed, cancelled, blocked, and
    succeeded depending on which projection was rebuilt first.

Likely improvement areas:

- make terminal orchestration decisions durable as normalized events
- replay tests for accepted completion report, PR handoff, issue breakdown,
  merge conflict repair, provider-limit failure, cancellation, and no-plan
  planning failure
- explicit rule for terminal event precedence and idempotency

### Runtime Harness, ACP, RunActivity, And Transcript Mapping

Failures repeatedly mention ACP/RunActivity mapping, tool-call correlation,
protocol-specific event leakage, duplicate persistence, and message reduction.

Likely improvement areas:

- one canonical normalized event taxonomy
- harness-provided normalized activity consumed by the orchestrator/run store
- structured tool-call ids and bounded payload previews
- tests that go through the real persistence/projection boundary, not only the
  harness helper

### API Projection And UI Contract

Failures often involve dashboard, issue-board, sidebar, history, liveness,
empty/stale/fallback behavior, and mock-data boundaries.

The current worker prompt is not weak in the generic sense. It already includes
review-loop hardening from `ReviewLoopPromptGuidance`: happy and negative paths,
integration boundaries, persistence/recovery, credential variants,
idempotency/replay, and verification that side effects actually happen. The
dogfood `WORKFLOW.md` also adds Symphony-specific worker extensions for
lifecycle fields, transcript events, PR metadata, tracker/writeback
comments/transitions, MCP, HTTP/status API, orchestrator, writeback/outbox,
tracker, harness, persistence, approval/publication variants, and dispatch
invariants.

The gap is specificity and enforcement. The prompt asks the worker to build a
small scenario matrix for the touched behavior, but it does not give a
surface-indexed contract checklist that says, for example, "if you touch a web
projection, also check the sibling detail/collection route, empty result,
missing lifecycle store, stale tracker data, fallback source metadata, and
mock-data boundary." Agents can satisfy the general instruction with a narrow
unit test and still miss the adjacent public contract that reviewers keep
finding later.

The improvement is to keep the generic matrix, but add surface-specific
checklists that are triggered by the touched area:

- API/projection changes: route contract, sibling route, empty/no-store state,
  stale/fallback metadata, liveness fields, and no production mock fallback.
- MCP/harness changes: tool exposure, payload schema, terminal events,
  duplicate calls, transcript mapping, and replay/restart behavior.
- Writeback/tracker changes: planned vs processed side effects, dry-run/skipped
  outcomes, verified remote state, duplicate idempotency, and failure comments.
- Publication/credential changes: missing/empty/invalid/valid credentials,
  selected capability/profile, service-owned vs agent-owned boundaries, and
  sanitized error reporting.

That should be a contract-test checklist, not just more prose. The worker
completion report should either list the applicable checklist items with
validation evidence or explicitly mark them out of scope with a reason.

Likely improvement areas:

- contract tests for each public `/api/v1/web/*` shape
- sibling-route tests when adding or modifying a projection
- explicit stale/fallback/empty metadata rules
- no production fallback to mock/demo data

### Linear Issue Authoring Contract

This should become an issue-writing policy, not only a worker prompt policy. The
worker can only reliably cover the right contract surface if the Linear issue
names that surface and defines what "done" means beyond the happy path.

The issue author, whether user or AI, should include these sections before an
issue receives `dogfood-ready`:

- `Problem / Goal`: the user-visible or workflow-visible problem being solved.
- `Touched surfaces`: explicit checklist of likely affected areas, such as API
  projection, UI, MCP, harness, lifecycle, writeback, tracker, publication,
  credentials, merge gate, configuration, workflow prompt, persistence, or docs.
- `Acceptance criteria`: observable behavior, not implementation preference.
- `Contract checklist`: surface-specific sibling, negative, stale/fallback,
  replay/restart, credential, and side-effect cases that must be considered.
- `Validation requirements`: concrete tests or smoke checks expected before
  completion.
- `Out of scope`: adjacent cases intentionally excluded, with reasons.
- `Promotion readiness`: whether this is ready for agent implementation, blocked
  pending design, or user-owned/manual work.

For AI issue drafting, the rule should be fail-closed:

- If the touched surface is clear, the AI must fill in the applicable contract
  checklist instead of leaving generic "add tests" language.
- If the touched surface is unclear, the AI must either ask a clarifying
  question before creating the issue or mark the issue as not ready for
  `dogfood-ready`.
- If the issue touches protected or high-risk workflow areas, the AI should keep
  `dogfood-blocked` or an equivalent blocked label unless the user explicitly
  promotes it after reviewing the contract checklist.
- The AI should not add `dogfood-ready` to a newly drafted issue unless the issue
  has the required sections, no open blockers, and a concrete validation plan.

Recommended template:

```md
## Problem / Goal

...

## Touched Surfaces

- [ ] API/projection
- [ ] UI
- [ ] MCP/tool contract
- [ ] Runtime harness/transcript mapping
- [ ] Lifecycle/persistence/replay
- [ ] Writeback/tracker
- [ ] Publication/GitHub/merge gate
- [ ] Credentials/security
- [ ] Config/workflow prompt
- [ ] Docs only

## Acceptance Criteria

- ...

## Contract Checklist

- Happy path:
- Negative/error path:
- Adjacent sibling surface:
- Empty/missing/stale/fallback state:
- Replay/restart/idempotency:
- Credential/security boundary:
- Side-effect verification:

## Validation Requirements

- ...

## Out Of Scope

- ...

## Promotion Readiness

- Ready for `dogfood-ready`: yes/no
- Remaining blocker:
```

To make this robust instead of etiquette:

- Add the template to the dogfood runbook and any issue-creation prompt used by
  AI assistants.
- Add a promotion checklist: do not remove `dogfood-blocked` or add
  `dogfood-ready` unless the issue contains the required sections.
- Add a lightweight issue-lint/doctor check that flags agent-eligible issues
  missing `Touched Surfaces`, `Contract Checklist`, or `Validation
  Requirements`.
- Teach worker prompts that if the issue lacks a contract checklist, the worker
  must derive one conservatively and mention the issue-authoring gap in the
  completion report. This prevents bad issue authoring from silently reducing
  validation scope.
- Teach reviewer prompts that a missing or under-scoped issue contract is not by
  itself an implementation defect, but any resulting untested required behavior
  is a valid fail finding.

## Ordered Linear Implementation Issues

Created on 2026-06-01 under the Symphony project and parent epic `ENG-29`.
Every issue starts in Backlog with `dogfood-blocked` and without
`dogfood-ready`. Except for the first issue, each issue is blocked by the
previous item so local promotion can happen one change at a time after the
predecessor has landed. The canonical item 11 is `ENG-252`; a duplicate issue
created during drafting, `ENG-253`, was marked Duplicate of `ENG-252`.

The ordering is intentional:

1. Improve issue authoring first so every later agent task carries the contract
   checklist and validation detail we want to dogfood.
2. Add command guardrails before sending more workers/reviewers into the queue,
   reducing upstream GitHub prompts and credential risk during the rest of the
   refactor.
3. Add the canonical local CI command before behavior changes that need
   repeatable validation evidence.
4. Add telemetry before changing more workflow behavior, so later changes
   produce structured evidence instead of more freeform inference.
5. Split counters after telemetry exists, preserving compatibility while making
   performance reporting clearer.
6. Make review verdict/writeback failure handling durable before deeper
   credential and PR-gate changes.
7. Harden credential/writeback boundaries after the failure behavior is known,
   so tests can assert the intended blocked/audit outcomes.
8. Gate reviewer dispatch on lifecycle-bound PR health once command ownership,
   CI, telemetry, and writeback behavior are structured.
9. Add replay/durability coverage after the main workflow state categories are
   explicit.
10. Normalize harness/activity mapping before projection contract tests depend
    on those events.
11. Add API projection contract tests last, using the normalized durable sources
    from the preceding issues.

Issue queue:

1. [`ENG-242`](https://linear.app/john-halbert/issue/ENG-242/01-require-contract-checklists-for-agent-eligible-issues):
   Require contract checklists for agent-eligible issues.
2. [`ENG-243`](https://linear.app/john-halbert/issue/ENG-243/02-block-workerreviewer-upstream-github-commands):
   Block worker/reviewer upstream GitHub commands.
3. [`ENG-244`](https://linear.app/john-halbert/issue/ENG-244/03-add-canonical-local-ci-command-and-validation-handoff):
   Add canonical local CI command and validation handoff.
4. [`ENG-245`](https://linear.app/john-halbert/issue/ENG-245/04-add-structured-revision-reason-telemetry):
   Add structured revision reason telemetry.
5. [`ENG-246`](https://linear.app/john-halbert/issue/ENG-246/05-split-reviewer-revision-counters-from-merge-gate-and-process-gates):
   Split reviewer revision counters from merge-gate and process gates.
6. [`ENG-247`](https://linear.app/john-halbert/issue/ENG-247/06-make-review-feedbackverdict-writeback-failure-safe):
   Make review feedback/verdict writeback failure-safe.
7. [`ENG-248`](https://linear.app/john-halbert/issue/ENG-248/07-harden-credentialwriteback-boundaries-and-smoke-coverage):
   Harden credential/writeback boundaries and smoke coverage.
8. [`ENG-249`](https://linear.app/john-halbert/issue/ENG-249/08-gate-reviewer-dispatch-on-lifecycle-bound-pr-health):
   Gate reviewer dispatch on lifecycle-bound PR health.
9. [`ENG-250`](https://linear.app/john-halbert/issue/ENG-250/09-build-replay-decision-matrix-and-durability-tests):
   Build replay decision matrix and durability tests.
10. [`ENG-251`](https://linear.app/john-halbert/issue/ENG-251/10-normalize-harness-activity-and-terminal-event-mapping):
    Normalize harness activity and terminal event mapping.
11. [`ENG-252`](https://linear.app/john-halbert/issue/ENG-252/11-add-api-projection-contract-tests-for-stalefallbackno-mock-behavior):
    Add API projection contract tests for stale/fallback/no-mock behavior.

## Post-Rebase Local Baseline Assessment

Assessment date: 2026-06-01.

Local baseline after catching `main` up:

- `main` was rebased onto `origin/main` at `11ecc05`.
- Local commit `8928a39` (`Document workflow planning and service-owned
  publication`) now sits on top of `origin/main`.
- The commit preserves the working analysis docs plus a small implementation
  change that tells implementation and merge-gate repair workers to leave
  changes uncommitted and unpushed, call `submit_completion_report`, and let
  Symphony perform service-owned commit, push, and PR creation/reuse.

Already covered by the local commit:

- `WORKFLOW.md`, `docs/dogfood-runbook.md`, `docs/trust-and-safety.md`, and
  `hermes/templates/worker/SOUL.md` now document the service-owned publication
  boundary.
- `renderCompletionMcpHandoffPrompt` and the completion-report MCP tool
  description now tell implementation workers that the completion report is the
  publication handoff.
- Merge-gate repair prompt generation in `ReviewVerdictService` and
  `TransitionPolicy` now says workers should leave repaired changes uncommitted
  and unpushed.
- Prompt-level regression tests now assert that merge-gate repair instructions
  do not say to commit and push the repaired branch.
- Planning evidence docs now exist for state representation, state ownership
  and durability, frontend projection performance, Hermes ACP integration, and
  workflow revision analysis.

Not covered by the local commit:

- There is no process/tool enforcement yet for denied upstream commands.
  Workers and reviewers could still try `git fetch`, `git push`, `gh pr ...`,
  `ssh git@github.com`, or raw GitHub API calls if their shell/tool surface
  permits them.
- There are no PATH shims, non-interactive Git/SSH environment hardening,
  Hermes terminal command-policy checks, or `execute_code` inheritance tests.
- Reviewer-specific command restrictions are not enforced beyond general prompt
  policy.
- There is no canonical local CI command shared with GitHub Actions.
- Revision reason telemetry, counter splitting, verdict/writeback failure-safe
  handling, credential/writeback smoke coverage, PR-health pre-review gating,
  replay matrix tests, harness activity normalization, and projection contract
  tests remain unimplemented.

Important tension introduced by the local baseline:

- The merge-gate repair prompt now says not to commit or push, but it still says
  to "fetch the latest upstream changes from origin/main".
- The planned command policy in `ENG-243` denies worker/reviewer-owned
  `git fetch`, `git pull`, `git remote update`, `git ls-remote`, and comparable
  upstream reads.
- `ENG-243` and `ENG-249` therefore need to replace worker-owned fetching with a
  service-owned ref refresh and a prepared local repair base. Workers should be
  able to inspect already-refreshed local refs and worktree state, not trigger
  upstream GitHub auth from their shells.

Adjusted issue impact:

- `ENG-242` remains first. The analysis doc now contains the issue-authoring
  contract, but the work still needs to productize it in the dogfood runbook,
  AI issue-creation prompt, promotion checklist, and issue-lint/doctor path.
- `ENG-243` should be narrowed away from prompt-only work. The prompt/docs
  baseline exists; remaining work is enforceable command blocking across
  terminal, subprocess, `execute_code`, `gh`, `ssh`, raw GitHub API shells, and
  reviewer surfaces. It must also remove or replace remaining worker-owned
  "fetch latest upstream" instructions.
- `ENG-244` is unchanged. It should create the canonical local CI command and
  wire worker completion reports to cite that command when applicable.
- `ENG-245`, `ENG-246`, and `ENG-247` are unchanged by this baseline.
- `ENG-248` should treat the current trust-and-safety text as documentation
  baseline only. The remaining work is fail-closed credential selection,
  sanitized selected-credential/writeback evidence, and end-to-end smoke
  coverage.
- `ENG-249` should not spend effort adding "do not push" language that already
  exists. Its remaining work is lifecycle-bound PR health gating, service-owned
  ref/check refresh before reviewer dispatch, and clear routing of merge/CI
  blockers to either local repair or service/user blocked states.
- `ENG-250` can use `docs/state-representation.md` and
  `docs/state-ownership-and-durability.md` as source evidence, but still needs
  executable replay/restart tests and any missing persisted fields.
- `ENG-251` is unchanged except that terminal command-denial events from
  `ENG-243` should be included in the normalized activity taxonomy.
- `ENG-252` can use `docs/frontend-projection-performance-inventory.md` as
  source evidence, but still needs route/projection contract tests and
  production no-mock assertions.

## Proposed Metrics After Refactor

Report these separately:

- average reviewer-requested implementation revisions per ticket
- average merge-gate repair attempts per ticket
- average CI repair attempts per ticket
- average process/tooling blockers per ticket
- token cost by failure source/domain
- reviewer rerun rate caused by process blockers
- worker rerun rate caused by merge/CI blockers
- time spent in each lifecycle phase and blocker category

The current single "revision average" should remain available for continuity,
but should be labeled as broad workflow churn, not implementation revision rate.

## Agent Git And GitHub Command Audit

Audit date: 2026-06-01.

Evidence sources:

- `symphony_workspaces/.symphony/runs/*/events.jsonl`
- `symphony_workspaces/.symphony/runs/*/meta.json`
- `symphony_workspaces/.symphony/hermes/profiles/**/state.db`

Extraction method:

- Parsed Cursor-style `tool_call` events with shell command arguments.
- Parsed Hermes SQLite `messages.tool_calls` entries where the tool was
  `terminal` or `shell`.
- Counted observed command invocations, not guaranteed successful remote
  effects.
- Classified commands by whether they were local git inspection, local
  `origin/*` ref inspection, remote/auth-risk reads, or remote writes.

Aggregate results from the local state snapshot:

- 5,820 terminal/shell command calls parsed.
- 3,370 command calls referenced `git`, `gh`, GitHub URLs, or SSH/GitHub remote
  forms.
- 821 command calls had upstream network or authentication risk.
- 363 distinct run/session ids and 125 distinct issues used at least one
  git/GitHub-related command.
- Role split for git/GitHub-related commands:
  - worker: 3,290
  - reviewer: 63
  - unknown role in persisted source: 17

Worker upstream/auth-risk command families:

| Family | Observed calls |
| --- | ---: |
| `git fetch` / `git pull` / `git ls-remote` | 176 |
| `gh pr view` | 81 |
| `git push` | 33 |
| `gh api` | 31 |
| `gh auth status` | 30 |
| `gh run view` | 13 |
| `gh auth setup-git` | 9 |
| `gh pr checks` | 4 |
| `gh repo view` | 1 |

Reviewer command families:

| Family | Observed calls |
| --- | ---: |
| local git inspection (`status`, `diff`, `log`, etc.) | 30 |
| `gh pr view` | 16 |
| `gh pr diff` | 6 |
| local `origin/*` ref inspection | 5 |
| raw GitHub API via PowerShell `Invoke-RestMethod` / `Invoke-WebRequest` | 4 |
| `git remote -v` style local remote inspection | 2 |

The reviewer pattern is mostly read-only PR inspection. I did not observe
reviewer `git push` attempts in this snapshot.

Observed worker `git push` attempts came from these issues:

- `ENG-106`
- `ENG-108`
- `ENG-109`
- `ENG-117`
- `ENG-120`
- `ENG-124`
- `eng-150`
- `ENG-176`
- `eng-189`
- `eng-194`
- `eng-196`
- `eng-197`

Representative high-risk worker commands:

```sh
git push origin HEAD:<branch>
git push --force-with-lease origin HEAD:<branch>
git push https://github.com/johnhalbert/symphony.git HEAD:refs/heads/<branch>
GIT_TERMINAL_PROMPT=0 git push --force-with-lease ... https://github.com/johnhalbert/symphony.git ...
GIT_SSH_COMMAND='ssh ...' git push --force-with-lease ... origin HEAD:<branch>
gh auth setup-git && git push https://github.com/johnhalbert/symphony.git ...
mkdir -p ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts && git push origin ...
```

Representative upstream read/auth-risk commands:

```sh
git fetch origin main
git fetch origin main --prune
git ls-remote https://github.com/johnhalbert/symphony.git refs/heads/main
gh auth status
gh auth setup-git
gh api repos/johnhalbert/symphony/branches/main --jq '.commit.sha'
gh pr view <number> --json ...
gh pr checks <number> --watch --interval 10
gh run view <run> --job <job> --log
```

Interpretation:

- The desktop SSH-key and GitHub OAuth prompts are consistent with the observed
  commands. Workers are attempting direct upstream publication and GitHub CLI
  authentication setup despite the current handoff contract saying Symphony
  owns commit, push, and PR publication.
- Some commands set `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`, or
  `GIT_SSH_COMMAND` batch flags, but the pattern is inconsistent. Other commands
  call plain `git push`, `git fetch`, `gh auth status`, or `gh auth setup-git`.
- Reviewer runs also call `gh`, so reviewers can trigger GitHub auth dialogs
  even when they are only reading PR metadata or diffs.

Likely improvement areas:

- Enforce the no-direct-upstream rule at the tool/runtime layer, not only in the
  prompt.
- Deny or intercept `git push`, `gh auth setup-git`, `gh pr create`, `gh pr
  edit`, `gh pr review`, `gh pr merge`, and write-capable `gh api` calls from
  worker/reviewer shells.
- Route publication, PR metadata, CI status, and review evidence through
  Symphony-owned MCP tools or service APIs.
- For allowed read-only local git operations, keep `git status`, `git diff`,
  `git log`, `git rev-parse`, `git merge-base`, and local `origin/*` ref checks
  available.
- For controlled upstream reads such as base freshness or PR metadata, prefer
  service-owned fetch/inspect helpers with non-interactive credentials and
  recorded evidence.
- Set non-interactive guardrails in agent environments where direct git/gh
  remains available: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
  `GH_PROMPT_DISABLED=1`, and a failing `GIT_ASKPASS`/`SSH_ASKPASS`. These are
  guardrails, not substitutes for command interception.

## Command Tool Surface And Blocking Options

Follow-up audit date: 2026-06-01.

Question being answered:

- Are the risky commands coming only through terminal/shell-like tools?
- Where can Symphony disallow specific commands?
- What enforcement shape avoids making the orchestrated workflow sloppier?

### Observed Tool Surface

From persisted Hermes state and run event logs, direct shell command execution is
concentrated in two tool names:

| Tool | Harness/source | Observed command calls | Notes |
| --- | --- | ---: | --- |
| `terminal` | Hermes | 5,426 | Current dominant command surface. |
| `shell` | Cursor SDK | 394 | Older Cursor runs; Symphony records payloads but does not own this tool. |

Role split from the same snapshot:

| Role | Tool | Observed command calls |
| --- | --- | ---: |
| worker | `terminal` | 5,420 |
| reviewer | `terminal` | 6 |
| worker | `shell` | 258 |
| reviewer | `shell` | 73 |
| unknown persisted role | `shell` | 63 |

So the answer is "mostly yes" for direct command execution: the commands that
produced the upstream GitHub/Git prompts came through terminal-like surfaces.
But command policy cannot stop there, because Hermes also exposes adjacent
escape hatches:

- `execute_code` appeared 698 times in Hermes tool calls.
- `execute_code` can call Hermes `terminal()` through its RPC stub when
  `terminal` is available in the session.
- `execute_code` also runs arbitrary Python in a child process. That Python can
  call `subprocess.run(["git", ...])`, `subprocess.run(["gh", ...])`, or similar
  unless the child process environment is also constrained.
- In the audited snapshot, `execute_code` contained 15 direct Python subprocess
  uses of `git` and 16 calls to `hermes_tools.terminal(...)` with git commands.
  These were local inspection commands in the sampled examples, not observed
  `git push`, `git fetch`, `gh auth`, or `gh pr` attempts. Still, the route is
  real.
- Delegation/task tools matter indirectly because child agents inherit their own
  tool surfaces. Reviewer profiles currently disable `delegation`; worker
  profiles do not.

### Current Code Shape

Relevant current files:

- `hermes/templates/worker/SOUL.md`
- `hermes/templates/reviewer/SOUL.md`
- `hermes/templates/worker/config.yaml`
- `hermes/templates/reviewer/config.yaml`
- `cursor/src/CursorHarness.ts`
- `hermes/src/HermesHarness.ts`
- `hermes/src/GatewayFacade.ts`
- `hermes/upstream-src/tools/terminal_tool.py`
- `hermes/upstream-src/tools/approval.py`
- `hermes/upstream-src/tools/code_execution_tool.py`
- `hermes/upstream-src/model_tools.py`
- `hermes/upstream-src/toolsets.py`

The worker profile already has the right prompt-level instruction for
publication:

```text
For implementation and merge-gate repair runs, leave changes uncommitted and
unpushed in the assigned worktree. Do not run git commit, git push, or
create/update GitHub pull requests directly; Symphony performs service-owned
commit, push, and PR creation/reuse after accepting the completion report.
```

That instruction is necessary, but the audit shows it is not sufficient.

Hermes role templates currently use `toolsets: [hermes-cli]`. In upstream
Hermes, `hermes-cli` includes `terminal`, `process`, `execute_code`, and
`delegate_task` alongside file/search/web tools. The reviewer profile disables
`tts` and `delegation`; the worker profile disables only `tts`. Neither profile
currently disables `terminal` or `code_execution`.

Hermes does have a pre-exec guard in `terminal_tool.py`, delegated to
`tools/approval.py`. That guard has an unconditional "hardline" blocklist for
catastrophic host commands and a dangerous-command approval flow. It does not
currently encode Symphony's workflow-specific policy: no service-owned git
publication, no GitHub CLI auth setup, no raw GitHub API calls from workers or
reviewers, and no agent-owned base ref fetching unless explicitly routed
through a service action.

For Cursor, `CursorHarness` creates/resumes Cursor SDK agents with local cwd,
settings sources, and Symphony MCP servers. Symphony observes Cursor `shell`
tool calls in events, but this harness does not wrap or pre-authorize the SDK's
built-in shell execution. That means a Symphony-side command policy must either
run below Cursor's shell via environment/PATH hardening, use Cursor-supported
tool restrictions if available, or avoid Cursor for workflows that require
strict command denial.

### Blocking Options

#### Option 1: Prompt-Only Policy

Keep strengthening worker/reviewer instructions.

This is not enough. The worker prompt already forbids direct commit, push, and
PR mutation, yet workers still attempted `git push`, `gh auth setup-git`, and
related commands. Prompt text should remain, but only as the user-readable
contract and model guidance.

#### Option 2: Disable Command Toolsets By Role

For Hermes, `agent.disabled_toolsets` can remove whole toolsets such as
`terminal`, `code_execution`, or `delegation`.

This is the strongest simple switch, but it is too blunt for workers if they
must run tests, typechecks, builds, smoke checks, and local CI parity. It may be
reasonable for some reviewer modes, but reviewer agents often need bounded local
inspection and validation too.

If `terminal` is disabled, `execute_code`'s generated Hermes tool stub no
longer advertises `terminal()`. However, `execute_code` itself still runs Python
and can spawn subprocesses directly unless `code_execution` is also disabled or
the subprocess environment is constrained.

#### Option 3: Hermes Terminal Command Policy

Add a Symphony-specific command policy check inside the Hermes terminal
execution path, before command execution and before generic approval handling.

Example shape:

- Symphony materializes a command-policy JSON file for each agent profile/run.
- `HermesHarness` passes the policy path through gateway environment variables.
- Hermes `terminal_tool.py` or `approval.py` checks that policy before executing
  commands.
- Denials return structured tool output, not an interactive prompt.

This would cover:

- direct Hermes `terminal` calls
- `execute_code` scripts that call `hermes_tools.terminal(...)`, because those
  RPC calls dispatch through the normal terminal tool
- child/delegated Hermes agents, if they inherit the same profile policy

This would not cover:

- Python inside `execute_code` calling `subprocess.run(["git", ...])`
- Cursor SDK `shell`
- commands invoked by absolute executable path, unless the policy check parses
  and blocks the full command before shell execution

#### Option 4: PATH Shims For `git`, `gh`, And `ssh`

Prepend a Symphony-controlled directory to agent `PATH` that contains wrapper
executables/scripts for sensitive commands. The wrappers inspect argv, deny
disallowed operations, and delegate allowed operations to the real binary.

This is the best cross-surface enforcement layer because it can catch:

- Hermes `terminal`
- Cursor `shell`, if the Cursor agent process receives the hardened `PATH`
- Python `execute_code` subprocesses
- shell scripts that call plain `git`, `gh`, or `ssh`
- delegated agents that inherit the same environment

It does not catch every possible bypass:

- absolute paths to `git.exe`, `gh.exe`, or `ssh.exe`
- copied binaries
- raw HTTPS calls through `curl`, `node`, PowerShell, or custom scripts
- shell aliases/functions if a shell startup file deliberately overrides the
  shim

Still, it is a practical enforcement layer and should be paired with explicit
runtime policy checks and environment hardening.

On Windows, the shim set needs to cover both Windows and Git Bash lookup forms,
for example `git`, `git.cmd`, possibly `git.exe` depending on implementation,
plus equivalent wrappers for `gh` and `ssh`. The wrapper should locate the real
binary through a sanitized fallback path that excludes the shim directory.

#### Option 5: Non-Interactive Environment Hardening

Set agent environment variables to prevent credential prompts and desktop
dialogs:

```text
GIT_TERMINAL_PROMPT=0
GCM_INTERACTIVE=never
GH_PROMPT_DISABLED=1
GIT_ASKPASS=<failing helper>
SSH_ASKPASS=<failing helper>
GIT_SSH_COMMAND=ssh -o BatchMode=yes
```

This reduces or eliminates SSH key confirmation and GitHub OAuth popups. It
does not disallow the command itself, and it does not stop already-authenticated
commands from succeeding. Treat it as a UX and defense-in-depth layer, not the
primary policy.

#### Option 6: Service-Owned Replacements

Blocking is only clean if the agent still has an approved path to do legitimate
work. The service should provide explicit alternatives for actions that agents
currently reach for with `git fetch`, `gh pr view`, or `gh pr checks`.

Useful service-owned surfaces:

- refresh or materialize the latest base ref before worker/reviewer starts
- provide lifecycle-bound PR metadata and head/base SHAs
- provide required-check status and check logs through scoped GitHub clients
- provide a canonical local `ci:required` command invocation and result capture
- publish commits, push branches, create/update PRs, and write reviewer
  feedback through MCP/service-owned APIs

This is the structural fix: agents should not need repo-level GitHub
credentials to know whether they are fresh, mergeable, or green.

#### Option 7: Post-Hoc Detection Only

Continue parsing transcripts and flagging bad commands after the run.

This is useful for telemetry and regression tests, but it will not prevent
desktop prompts, upstream effects, or credential use. It should be retained as
audit evidence, not relied on for control.

### Recommended Policy Boundary

Allowed directly in worker/reviewer shells:

- `git status`
- `git diff`
- `git log`
- `git show`
- `git rev-parse`
- `git branch --show-current`
- `git merge-base`
- `git diff --check`
- local `origin/*` ref inspection when the service has already refreshed refs

Denied directly in worker/reviewer shells:

- `git commit`
- `git push`
- `git fetch`
- `git pull`
- `git ls-remote`
- `git remote update`
- `git submodule update --remote`
- `git credential ...`
- `git config credential.* ...`
- `gh auth ...`
- `gh pr create/edit/comment/review/merge/checks`
- `gh api ...`
- `gh run view ...` and `gh pr view ...` unless replaced by a strictly
  read-only service-owned PR/check metadata tool
- `ssh git@github.com`, `ssh -T git@github.com`, and shell commands that mutate
  `~/.ssh/known_hosts` for GitHub such as `ssh-keyscan github.com >> ...`
- raw GitHub API calls from shell tools, such as `curl https://api.github.com`
  or PowerShell `Invoke-RestMethod` / `Invoke-WebRequest` to GitHub, when they
  are substituting for service-owned GitHub reads or writes

The important distinction is local repository inspection versus upstream
network/auth access. Workers and reviewers can inspect local changes; Symphony
should own upstream state refresh, publication, PR metadata, CI metadata, and
writeback.

### Recommended Implementation Shape

Use layered enforcement:

1. Keep the prompt contract.
2. Add non-interactive environment hardening to every worker/reviewer run.
3. Add PATH shims for `git`, `gh`, and `ssh` in the agent environment.
4. Add a Hermes terminal command-policy check so `terminal` returns a structured
   policy denial before execution.
5. Constrain or disable `execute_code` where necessary, or ensure its child
   process inherits the same PATH shims and non-interactive environment.
6. Replace legitimate upstream reads with service-owned MCP tools.
7. Add regression tests that attempt denied commands through each available
   surface: Hermes `terminal`, `execute_code` subprocess, `execute_code`
   `terminal()`, worker delegation if enabled, and Cursor `shell` if Cursor
   remains supported for this workflow.

This gives the workflow a clear contract:

- Agents do local implementation and local validation.
- Symphony performs all upstream GitHub and publication actions.
- Merge-gate/CI freshness is represented as service evidence, not agent shell
  side effects.

## Open Questions

- Should merge-gate repair attempts ever increment `reviewRound`, or should they
  move to a dedicated `mergeGateRepairRound`?
- Should automated gate failures remain in `reviewVerdicts` for compatibility,
  or should they move to `workflowBlockers`/`gateEvents`?
- Which blocker categories should automatically dispatch a worker, and which
  should block for service/user action?
- Should a reviewer be dispatched only after mergeability and required checks
  are already clean?
- What is the minimal migration path for existing local lifecycle records?
