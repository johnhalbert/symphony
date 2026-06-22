# Orchestration Transition Execution Audit

Date: 2026-06-21

## Scope

This report audits the current bridge between the new ruleset/history model and
the pre-existing orchestrator side-effect methods.

Current execution path:

1. `tick()` fetches issues for a lane.
2. `processIssueTransitionCandidate()` calls `processIssueTransitionEvent()`.
3. `decideIssueTransition()` builds an immutable `IssueCurrentStateSnapshot`.
4. `IssueOrchestrationEngine.decide()` selects the first matching ruleset.
5. The resulting `IssueHistorySnapshot` is persisted.
6. `executeIssueTransition()` looks up the selected transition kind.
7. The registered action usually delegates to one legacy method.

The registry shape exists, but most actions are broad adapters:

- `dispatch_worker` -> `tryDispatchWorkerIssue()`
- `dispatch_planner` -> `tryDispatchPlanner()`
- `dispatch_reviewer` -> `tryDispatchReviewerIssue()`
- `dispatch_triage` -> `tryDispatchIssueTriage()`
- `dispatch_post_mortem` -> `tryDispatchIssuePostMortem()`
- `merge_policy` -> `tryReconcileMergePolicy()`
- `reconcile_report_writeback` -> report-kind branch to old writeback methods
- `recover_publication_approval` -> `recoverPendingPublicationApprovalHandoff()`
- `terminate_running` -> `terminateRunningIssue()`
- `block_issue` -> `executeBlockIssueTransition()`
- `retry_run` -> `executeRetryRunTransition()`

## Classification Terms

- **Represented/drop**: the check is already in `IssueCurrentStateSnapshot` and
  a ruleset either already uses it or should be trivially moved into ruleset
  logic without adding new raw state.
- **Model miss**: the check is needed for correct decisioning but the snapshot
  lacks raw evidence or the ruleset lacks the rule.
- **Smuggled transition**: the old method performs a distinct state transition
  or side effect that should be selected and audited as its own transition.
- **Action decomposition**: split legacy method bodies into side-effect bounded
  action functions.

## Reverification Report

### Dispatch Prechecks Already Represented

These checks are duplicated in old dispatch methods and can be removed from
action execution once rulesets own them:

| Check | Legacy locations | Current representation | Disposition |
| --- | --- | --- | --- |
| Available agent slots | `tryDispatch*()` before and after refresh | `availableSlots`, `rulesetCommonDispatchGate()` | Represented/drop |
| Provider dispatch gate | `tryDispatch*()` before and after refresh | `providerDispatchGateActive`, `rulesetCommonDispatchGate()` | Represented/drop |
| Running issue | `shouldDispatch*()` | `running`, `rulesetCommonDispatchGate()` | Represented/drop |
| Paused issue | `shouldDispatch*()` | `paused`, `rulesetCommonDispatchGate()` | Represented/drop |
| Existing claim | `shouldDispatch*()` | `claimed`, `allowExistingClaim`, `rulesetCommonDispatchGate()` | Represented/drop |
| State slot availability | `shouldDispatch*()` | `stateSlotAvailable`, `rulesetCommonDispatchGate()` | Represented/drop |
| Assignee/delegate route | worker/planner guards | `assignedToWorker` | Represented/drop |
| Tracker active/review/blocked/done/terminal state checks | `shouldDispatch*()` | `trackerState` plus configured state lists | Represented/drop |
| Handoff/review/blocked exclusions for worker | `shouldDispatchWorker()` | `trackerState` rules in `rulesetCanDispatchWorker()` | Represented/drop |
| Merge conflict state for conflict worker | `isMergeConflictState()` checks | `trackerState`, config | Represented/drop |
| Child issue exclusion | worker/planner guards | `hasChildren` | Represented/drop |
| Label guardrails | all dispatch guards | `labels`, `rulesetPassesLabelGuardrails()` | Represented/drop |
| Open blocker guard | worker Todo and reviewer/planner guards | `blockedBy` | Represented/drop |
| Fresh issue breakdown plan | `latestFreshIssueBreakdownPlan()` in planner/worker routing | breakdown plan ID/status/fingerprints/validation fields | Represented/drop |

The tracker refresh inside each dispatch method is a freshness concern, not a
transition action. If retained, it should happen before building the immutable
snapshot, not after a transition has already been selected.

### Model Misses

These checks are still only enforced in old execution code, or not fully
represented in the new decision model.

| Missing verification | Current old location | Required model/ruleset update | Classification |
| --- | --- | --- | --- |
| Triage attempt budget for current trigger | `shouldIssueTriageRun()` via `lifecycleAllowsDispatch()` | Add `issueTriageAttemptsForCurrentTrigger` or equivalent raw count; ruleset must require attempts `< maxAttemptsPerTrigger` | Model miss |
| Triage blocked-reason eligibility | `shouldIssueTriageRun()` | `blockedReason` exists; ruleset must require `isIssueTriageBlockedReason(blockedReason)` | Model miss in ruleset, raw data present |
| Post-mortem evidence exists | `shouldIssuePostMortemRun()` | Add explicit raw booleans/IDs for latest completion report and current approval-pass verdict; `lastCompletionReportId` and `lastReviewVerdictId` are not enough to prove pass/current | Model miss |
| Post-mortem attempt budget for current trigger | `shouldIssuePostMortemRun()` | Add `postMortemAttemptsForCurrentTrigger` | Model miss |
| Planner allowed from blocked only when triage found decomposition blocker | `lifecycleAllowsDispatch()` uses `reportHasActiveTriageBlocker(..., "under_specified_needs_decomposition")` | Add raw latest triage blocker summary or `hasActiveUnderSpecifiedNeedsDecompositionBlocker`; ruleset must require it for blocked planner dispatch | Model miss; ENG-406 failure |
| Planning max failure budget | `lifecycleAllowsDispatch()` | `planningFailureCount` exists; ruleset must compare against config and select a block/escalation transition, not dispatch planner | Model miss in ruleset, raw data present |
| Planning retry backoff | `planningBackoffRemainingMs()` | Add `lastPlanningFailureAt` or `planningBackoffRemainingMs`/`planningRetryDueAt` to snapshot | Model miss |
| Merge conflict worker lifecycle status | `lifecycleAllowsDispatch()` checks `mergeConflict.status`, `resolutionStatus`, `fixTurnCount`, `maxFixTurns` | Add raw merge conflict summary fields to snapshot | Model miss |
| Worker incomplete-turn budget | `lifecycleAllowsDispatch()` | `incompleteTurnCount` exists; ruleset must select `block_issue` when limit reached | Model miss in ruleset, raw data present |
| Reviewer failure/review-round budget | `lifecycleAllowsDispatch()` | `reviewRound` exists; ruleset must select `block_issue` when limit reached | Model miss in ruleset, raw data present |
| Reviewer dispatch evidence availability | `loadReviewerDispatchEvidence()` | Add decision rule requiring current completion-report evidence, or split evidence load into an auditable action that can record `skipped` | Model miss |
| Merge-policy service preconditions | `MergePolicyService.reconcileIssue()` credential/writeback checks | Config-only preflight can stay action-level, but skipped/error outcomes must be recorded as action results | Action preflight miss |

### Smuggled Transitions Hidden in Guards

These are not mere verifications. They mutate state or perform external
writebacks from methods named like guards or dispatch functions.

| Hidden transition | Current location | Why it is smuggled | Proposed transition |
| --- | --- | --- | --- |
| Reset failure budget after operator action | `lifecycleAllowsDispatch()` -> `resetFailureBudgetAfterOperatorAction()` | Mutates lifecycle, clears blocked reason, resets counters/gates | `reset_lifecycle_after_operator_resume` |
| Reopen blocked merge conflict after operator resume | `lifecycleAllowsDispatch()` branch with `merge_conflict_state_resume` | Mutates merge-conflict lifecycle and may reopen attempt window | `reset_merge_conflict_after_operator_resume` or variant of previous |
| Re-block exhausted merge conflict | `lifecycleAllowsDispatch()` and `blockMergeConflictAttempts()` | Mutates lifecycle and applies blocked writebacks | `block_merge_conflict_attempt_limit` |
| Recover head-superseded merge gate | `recoverSatisfiedHeadSupersessionRebind()` from worker lifecycle gate | Applies writebacks and changes lifecycle from implementation back to passed | `recover_merge_gate_head_supersession` |
| Rebound mixed triage blocker back to Blocked | `recoverMixedIssueTriageBlockedRebound()` from worker lifecycle gate | Applies tracker writeback and lifecycle update to Blocked | `rebound_issue_triage_blocked` |
| Escalate worker incomplete turns | `lifecycleAllowsDispatch()` -> `escalateLifecycleBlocked()` | Selects or applies block transition during dispatch guard | Existing `block_issue`, but rule must select it before dispatch |
| Escalate reviewer failure limit | `lifecycleAllowsDispatch()` -> `escalateLifecycleBlocked()` | Selects or applies block transition during reviewer dispatch guard | Existing `block_issue`, but rule must select it before dispatch |
| Planning failure limit escalation | `lifecycleAllowsDispatch()` -> `escalateLifecycleBlocked()` | Blocks during planner dispatch guard | Existing `block_issue`, but rule must select it before dispatch |

## Branching Report

### `tryDispatchWorkerIssue()`

Branches:

- Chooses `merge_conflict_resolution` vs `implementation` from issue state.
  This is already represented as separate rulesets:
  `orchestrator.dispatch.merge_conflict_worker` and
  `orchestrator.dispatch.worker.implementation`. Drop runtime branch.
- Calls `resolveWorkerDispatchDecision()` and may redirect to planner.
  Planner dispatch is represented as `dispatch_planner`; this must be selected
  by rulesets before worker dispatch, not inside worker action.
- Applies dispatch writeback, refreshes issue, then re-decides transition.
  This is hidden nested transition evaluation inside a worker action. Split into
  explicit action(s) and stop re-entering `decideIssueTransition()` from action
  execution.
- After writeback, may again redirect to planner.
  This is a separate planner transition that must be represented before action
  execution or by a follow-up tick, not a branch inside worker action.

### `tryDispatchPlanner()`

Branches:

- Refreshes issue and re-runs planner eligibility.
  This is duplicate verification; remove once rulesets own the checks.
- Re-checks fresh issue breakdown plan.
  Already represented by snapshot fields; drop from execution.
- `lifecycleAllowsDispatch()` can smuggle reset/block behavior.
  Move those outcomes into rulesets/transitions.

### `tryDispatchReviewerIssue()`

Branches:

- Refreshes issue and repeats eligibility/lifecycle checks.
  Remove after ruleset coverage.
- Loads reviewer evidence and returns false if unavailable.
  Either model evidence availability in snapshot, or make
  `load_reviewer_dispatch_evidence` an action that records skipped.

### `tryDispatchIssueTriage()`

Branches:

- Refreshes issue and repeats eligibility/lifecycle checks.
  Remove after adding triage blocked-reason and attempt-budget rules.

### `tryDispatchIssuePostMortem()`

Branches:

- Refreshes issue and repeats eligibility/lifecycle checks.
  Remove after adding post-mortem evidence and attempt-budget rules.

### Report Writeback Reconciliation

`reconcile_report_writeback` branches on `transition.reportKind`.

This is a structural smell: the transition kind is too generic. Split into:

- `reconcile_issue_triage_report_writeback`
- `reconcile_post_mortem_report_writeback`

Each transition should have its own action list and no report-kind branch.

### `recoverPendingPublicationApprovalHandoff()`

Branches:

- Configuration missing -> skipped action.
- No recoverable lifecycle -> skipped action.
- Service recovery -> recovered/skipped/error.

This can remain a transition, but action output must be structured. The service
may later need finer-grained transitions for approval outcome handling.

### `terminateRunningIssue()`

Mostly already a proper transition action, but split by side effect:

- mark cancellation requested
- abort running controller
- mark workspace cleanup requested
- record termination action

### `executeRetryRunTransition()`

Mostly already a proper transition action:

- schedule retry timer
- record retry action

The later timer callback has more branching, but it re-enters the transition
engine with `retry_schedule`/candidate sources and is outside this transition's
immediate execution.

### `executeBlockIssueTransition()`

Mostly a proper transition, but `applyLifecycleBlocked()` combines:

- update lifecycle blocked
- apply blocked escalation writebacks
- record block action

Split these into actions.

### `tryReconcileMergePolicy()`

This delegates to `MergePolicyService.reconcileIssue()`, which hides an entire
sub-state-machine. Keep the service, but the selected transition should not be
generic `merge_policy`. Split policy outcomes into explicit transitions.

Hidden merge-policy transitions include:

- already-merged Done recovery
- open merge-conflict base refresh
- head supersession handling
- checks-pending observation
- same-gate blocker refresh
- merge-gate repair dispatch
- merge-gate blocked escalation
- auto-resolve previously blocked gate
- service-prepared conflict dispatch
- pull request merge
- Done state writeback

## Proposed Transition Additions

### Dispatch/Lifecycle Transitions

- `reset_lifecycle_after_operator_resume`
  - Trigger: issue lifecycle blocked/stale, tracker state moved out of blocked
    state or manual ignore-state dispatch.
  - Actions: update lifecycle counters/gates; record lifecycle evidence.

- `reset_merge_conflict_after_operator_resume`
  - Trigger: merge conflict blocked/resolution blocked, issue returned to
    configured conflicts state.
  - Actions: update merge conflict status/counters; record lifecycle evidence.

- `block_merge_conflict_attempt_limit`
  - Trigger: conflict fix attempts exhausted.
  - Actions: update lifecycle blocked; apply conflict blocked writebacks; record
    action.

- `recover_merge_gate_head_supersession`
  - Trigger: active implementation lifecycle with superseded merge gate and
    matching current approval verdict/report.
  - Actions: apply head-supersession recovery writebacks; update lifecycle to
    passed; record action.

- `rebound_issue_triage_blocked`
  - Trigger: active implementation lifecycle with blocked merge gate and latest
    triage report containing non-worker active blockers.
  - Actions: apply rebound writeback; update lifecycle to blocked; record action.

- Existing `block_issue`
  - Should be selected by rulesets for incomplete-turn, reviewer-failure, and
    planning-failure limits. These should not be reached from dispatch guards.

### Report Writeback Transitions

- `reconcile_issue_triage_report_writeback`
- `reconcile_post_mortem_report_writeback`

These replace the generic report-kind branch under
`reconcile_report_writeback`.

### Merge Policy Transitions

Use `merge_policy_candidates` as the source lane, but select explicit
transition kinds:

- `merge_policy_recover_done_transition`
- `merge_policy_refresh_conflict_base`
- `merge_policy_mark_head_superseded`
- `merge_policy_observe_checks_pending`
- `merge_policy_refresh_same_gate_blocker`
- `merge_policy_dispatch_repair`
- `merge_policy_block_failure`
- `merge_policy_prepare_conflict`
- `merge_policy_auto_resolve_gate`
- `merge_policy_merge_pull_request`
- `merge_policy_write_done_state`

The current snapshot lacks enough merge-gate and merge-conflict raw state for
all of these. Add a compact merge-policy summary to `IssueCurrentFields` before
moving this fully into rulesets.

## Proposed Action Decomposition

Action functions should be side-effect bounded, record structured action
results, and return action outcomes rather than silently returning `false`.

### Common Dispatch Actions

Reusable actions:

- `record_agent_dispatch_started`
- `create_running_entry`
- `claim_issue_for_run`
- `clear_retry_for_issue`
- `start_agent_run_monitor`

Optional role-specific load actions:

- `load_reviewer_dispatch_evidence`
- `load_issue_breakdown_dispatch_context`
- `load_issue_triage_dispatch_context`
- `load_post_mortem_dispatch_context`

### Worker Implementation Dispatch

- `plan_worker_dispatch_writeback`
- `apply_worker_dispatch_writeback`
- `verify_worker_dispatch_writeback_state`
- `record_agent_dispatch_started`
- `create_running_entry`
- `claim_issue_for_run`
- `clear_retry_for_issue`
- `start_worker_run_monitor`

The writeback actions may no-op when no operation is planned. They must not
re-enter transition decisioning.

### Planner Dispatch

- `record_agent_dispatch_started`
- `create_running_entry`
- `claim_issue_for_run`
- `clear_retry_for_issue`
- `start_planner_run_monitor`

### Reviewer Dispatch

- `load_reviewer_dispatch_evidence`
- `record_agent_dispatch_started`
- `create_running_entry`
- `claim_issue_for_run`
- `clear_retry_for_issue`
- `start_reviewer_run_monitor`

### Issue Triage Dispatch

- `record_agent_dispatch_started`
- `create_running_entry`
- `claim_issue_for_run`
- `clear_retry_for_issue`
- `start_issue_triage_run_monitor`

### Post-Mortem Dispatch

- `record_agent_dispatch_started`
- `create_running_entry`
- `claim_issue_for_run`
- `clear_retry_for_issue`
- `start_post_mortem_run_monitor`

### Report Writeback Reconciliation

For issue triage:

- `load_issue_triage_report_for_current_trigger`
- `plan_issue_triage_report_writebacks`
- `apply_issue_triage_report_writebacks`
- `mark_issue_triage_report_writebacks_recorded`
- `record_issue_triage_writeback_reconciliation`

For post-mortem:

- `load_post_mortem_report_for_current_trigger`
- `plan_post_mortem_report_writebacks`
- `apply_post_mortem_report_writebacks`
- `mark_post_mortem_report_writebacks_recorded`
- `record_post_mortem_writeback_reconciliation`

If a plan produces multiple writeback operations, the reusable writeback action
should record one action result per operation or include per-operation result
details.

### Publication Approval Recovery

- `verify_publication_approval_recovery_config`
- `load_recoverable_publication_approval_lifecycle`
- `record_publication_approval_recovery_started`
- `recover_publication_approval_handoff`
- `record_publication_approval_recovery_finished`

### Running Termination

- `mark_running_cancellation_requested`
- `abort_running_agent`
- `mark_workspace_cleanup_on_exit`
- `record_running_termination`

### Retry Scheduling

- `schedule_retry_timer`
- `record_retry_scheduled`

### Block Issue

- `update_lifecycle_blocked`
- `apply_blocked_escalation_writebacks`
- `record_block_issue`

### Merge Policy

Initial decomposition should not be one generic action. For each explicit
merge-policy transition, use side-effect actions such as:

- `load_live_pull_request`
- `resolve_live_base_observation`
- `evaluate_required_checks`
- `apply_merge_gate_writebacks`
- `update_merge_gate_lifecycle`
- `prepare_service_conflict_branch`
- `publish_prepared_conflict_head`
- `merge_pull_request`
- `record_merge_metadata`
- `apply_done_writeback`
- `verify_done_state`

## Implementation Order Recommendation

1. Add missing snapshot fields for triage attempts, post-mortem attempts,
   post-mortem evidence, planner-from-blocked triage blocker, planning backoff,
   merge conflict summary, and merge-policy summary.
2. Move all represented verification into rulesets and delete duplicated
   executor checks.
3. Split smuggled lifecycle/blocked/recovery outcomes into explicit rulesets and
   transition kinds.
4. Replace broad registry adapters with decomposed action functions.
5. Make action return values structured: `succeeded`, `skipped`, `failed`, with
   details and error capture.
6. Remove nested calls to `decideIssueTransition()` from action execution.
