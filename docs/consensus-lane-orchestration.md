# Future Consensus Lane Orchestration

This note captures the intended shape for a later non-lifecycle consensus runner. It is not a Phase 1 runtime feature.

## Boundary

Consensus lanes are proposal/review lanes, not Linear lifecycle workers or reviewers. They must not receive the completion-report, review-verdict, review-feedback, merge, or Linear lifecycle writeback tools.

The orchestrator should create fresh dedicated Cursor runs for each lane and critic. Lane prompts should include the shared brief, the role persona, bounded durable context, and explicit response contracts. Critic prompts should receive only the paired lane output and minimum evidence needed to review that lane.

Consensus orchestration must be invoked explicitly, for example by a future planning command or dashboard action. It must not run from worker dispatch, review dispatch, issue state polling, or the always-applied Cursor rule path.

## Artifact Contracts

The future runner should persist versioned artifacts. These are not freeform chat transcripts:

- `SharedBrief`: objective, deliverable, constraints, success criteria, non-goals, explicit assumptions, issue links, and bounded evidence pointers.
- `LanePersona`: lane name, review posture, allowed evidence, and response contract. Initial personas are `Pragmatist`, `Analyst`, and `Skeptic`.
- `LaneOutput`: summary, primary artifact, evidence/cited context, assumptions, risks/tradeoffs, validation steps, and likely files/tests.
- `CriticOutput`: either `NO_ACTIONABLE_IMPROVEMENTS` or issues, why they matter, and requested revision.
- `LaneRevision`: a complete replacement `LaneOutput`, not a delta against prior output.
- `LaneMemo`: the orchestrator-owned compact state for one lane, rewritten after each accepted lane output or revision.
- `SynthesisOutput`: consensus level, branch status, converged parts, diverged parts, assumptions/unknowns, and recommended next action.

Every artifact should carry `version`, `laneId`, `runId`, `createdAt`, and bounded character counts. Large supporting evidence should be referenced by pointer, not embedded.

## Run Boundaries

Each execution boundary is a fresh bounded Cursor run:

- Initial solution lanes: three fresh runs, one per persona, all receiving the same `SharedBrief`.
- Critic runs: three fresh runs, one per lane output, with no access to other lane outputs.
- Revision runs: fresh runs scoped to the original lane, using the latest `LaneMemo`, previous full `LaneOutput`, and paired `CriticOutput`.
- Synthesis run or parent synthesis step: receives final lane outputs only. It may cite branch statuses and unresolved critiques, but should not read full raw transcripts by default.

The runner should enforce a hard iteration cap per lane. The initial lane output counts as iteration 1. Each accepted revision increments the count. Capped lanes are preserved as `capped-unresolved`, not silently treated as approved.

## Isolation Rules

Lanes stay blind until synthesis:

- No lane receives another lane's output, critic output, memo, or revision.
- Critics receive only their paired lane output and the minimum evidence needed for review.
- Revisions return only to the original lane persona.
- The synthesis phase compares final lane outputs; it must not use simple majority voting when a minority branch raises a blocking objection.

Consensus lane MCP exposure must be read-only by default. Allowed tools are bounded recall, status/pointer lookup, and local read/search capability. Disallowed tools include lifecycle writeback, completion reports, review verdicts, PR review feedback, merge, and any Linear/GitHub mutation unless a future operator explicitly grants a separate planning-comment capability.

## Memory Contract

Lane state should use the same sparse memory principles as worker/reviewer handoffs:

- `WORKFLOW.md` supplies the system persona and operational responsibilities.
- The orchestrator owns compact lane memos and rewrites them from structured lane outputs.
- Full transcripts remain in durable storage and are reachable only through bounded recall.
- Worker/reviewer `USER.md`, `MEMORY.md`, and `SOUL.md` files are not part of this design.

The memo is cumulative by rewrite. It should keep current assumptions, accepted facts, unresolved questions, artifact pointers, and the next requested action. It should not append previous prompts or critic text verbatim.

## Safety Constraints

Consensus runs must be isolated from lifecycle writeback and merge authority. If a later dashboard assistant gains pluggable user memory, that should be a separate role with a small file-backed `USER.md` and `MEMORY.md` surface, not shared implicitly with lifecycle workers, reviewers, or consensus lanes.

## Acceptance Shape

A future implementation should expose consensus as an explicit orchestration mode with:

- three initial solution lanes
- fresh one-to-one critic runs
- bounded revisions with a hard iteration cap
- deterministic synthesis by the parent orchestrator
- telemetry for model params, prompt size, recall usage, and lane status

## Future Issue Set

Before implementation, split the work into separate issues:

- Add consensus artifact schemas and persistence.
- Add read-only consensus MCP/tool exposure policy.
- Add lane/critic fresh-run scheduler with iteration caps.
- Add synthesis and consensus-status reporting.
- Add dashboard or CLI entry point for explicit invocation.
- Add regression tests for lane isolation, capped lanes, and no lifecycle writeback exposure.
