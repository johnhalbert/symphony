---
name: symphony-worker-implementation
description: Implement Symphony dogfood worker issues safely, delegate bounded research with delegate_task to preserve parent context, validate orchestration-facing changes, and hand off through the Symphony MCP completion report.
---

# Symphony Worker Implementation

Use this skill when acting as a Symphony worker for an implementation or merge-gate repair run in a checked-out Symphony worktree, especially for orchestration, workflow, tracker, runtime harness, dogfood safety, approval, publication, or writeback changes.

## Core workflow

1. **Treat the injected worker prompt as the source of truth.** Capture the active issue ID, assigned role, workspace path, repository path, branch, base ref, and handoff requirements before changing code.
2. **Inspect current context before implementation.** Check the issue-provided title, description, blockers, labels, and contract checklist when available, then inspect the assigned worktree state, branch, existing diffs, and relevant repository files. Work only inside the assigned worktree.
3. **Use bounded delegation for research before broad reading.** When the task requires mapping unfamiliar code, comparing sibling paths, finding tests, or tracing cross-module behavior, use `delegate_task` for bounded read-only research questions instead of loading many files into the parent context. For repository research children, pass `toolsets: ["terminal"]` only and include explicit terminal-reducer instructions in the child prompt.
4. **Do not perform service-owned publication actions.** During implementation and merge-gate repair runs, do not run `git commit`, `git push`, `gh pr create`, `gh pr edit`, direct PR publication/update commands, direct lifecycle state changes, or Linear lifecycle writeback. Leave changes uncommitted and unpushed for Symphony to publish.
5. **Keep changes narrowly tied to the issue contract.** For protected areas such as orchestration, workflow parsing, Linear integration, runtime harnesses, dogfood workflow, and dogfood safety docs, preserve lifecycle/writeback invariants and avoid broad opportunistic rewrites.
6. **Build a scenario matrix before handoff.** Cover happy path, negative/error path, sibling/adjacent path, boundary/integration behavior, persistence or durability effects, authorization or credential variants when relevant, idempotency/replay behavior, already-terminal/repeated-operation behavior, and whether required side effects actually process rather than merely enqueue.
7. **Validate with the smallest meaningful checks plus broader tests for shared code.** Run focused tests for the touched behavior. When touching orchestration, workflow, tracker, harness, persistence, approval, publication, or writeback code, add or run broader tests that exercise cross-boundary behavior.
8. **For merge-gate repairs, reproduce the failing required check before changing anything, then repair the invariant that actually blocks CI.** If the failure is a stale test expectation after an accepted adjacent contract change, prefer updating the narrow expectation to the current documented contract over changing production code to satisfy obsolete behavior. Re-run the exact failing test/check first, then the required gate command(s) such as typecheck and full test when feasible.
9. **Submit the Symphony MCP completion report before ending.** Include summary, validation evidence, acceptance checklist entries with concrete proof, changed files, branch name and any existing PR number/URL/head SHA only if already known from context or safe read-only inspection, risks, and a stable idempotency key. When the issue has a fenced JSON Issue Contract, treat its `requirements` array as the authoritative acceptance contract: provide one checklist item per requirement `id`, prefix the item text with that ID, and mark it satisfied only when the cited evidence proves the exact behavior. The natural-language final response is not the completion signal.

## Delegated research discipline

Use `delegate_task` as a context-control tool, not as a way to scatter implementation ownership.

Good delegation targets:

- "Find the files and tests that define worker prompt construction; return paths, symbols, and one-sentence responsibilities."
- "Trace how this lifecycle field is persisted and replayed; return the write path, read path, tests, and any missing edge cases."
- "Compare the worker and reviewer harness setup; return only differences relevant to skill loading."
- "Inspect existing tests for this behavior and recommend the smallest test surface to update."

Delegate when any of these are true:

- The question spans more than two likely files or modules.
- You need repository cartography before choosing an edit surface.
- You are about to use broad recursive reads or several large file reads.
- You need independent review of a scenario matrix or edge-case list.

Keep delegated work bounded:

- Ask one concrete question per subagent.
- Provide paths, symbols, issue context, and success criteria; do not paste large file bodies.
- For repository research, set each delegated task's `toolsets` exactly to `["terminal"]`. Do not include the `file` toolset for these child tasks; `file` gives the child `read_file` and `search_files`, which defeats the context-preservation goal.
- Tell the child why it is terminal-only: terminal reducers preserve context by aggregating locally and returning compact path, symbol, line, and responsibility summaries instead of dumping large search/read results into the subagent context.
- Include clear child-prompt wording such as: "Use the `terminal` tool for repo exploration. Do not use native file/search tools. Run capped reducer commands first, summarize findings, and stop once you have the first useful map."
- Tell research subagents not to call `delegate_task`; child research must be leaf-only.
- Give each research subagent a hard stop: answer after the first useful map of paths/symbols/tests, after roughly five tool rounds, or when context pressure/compression appears. Partial concise findings are preferable to continued exploration.
- For repository cartography in child research, require capped `terminal` reducer commands instead of broad `search_files` or `read_file` calls. Use `rg --files`, `rg -n`, `git grep -n`, `sed -n`, `awk`, `node -e`, or `python -c` to aggregate locally and print only compact path, symbol, line, and responsibility summaries.
- Cap reducer output aggressively: aim for at most 150 lines or 20 KB of stdout, whichever comes first. If more evidence exists, report the next patterns or files to inspect instead of printing them.
- Example reducer shapes, adapted to the active shell: `rg --files src tests | rg "orchestrator|harness|completion" | head -n 80`, `rg -n --glob "*.ts" "submit_completion_report|delegate_task|toolsets" src tests | head -n 120`, `git grep -n "class HermesHarness\\|delegate_task" -- hermes src tests | head -n 120`, `sed -n '1,180p' src/core/harness/HandoffMcp.ts`, or a short `python -c` / `node -e` script that scans candidate files and prints a small JSON summary.
- Good delegated task shape: `{"goal":"Map the files/tests that define worker prompt construction. Use terminal reducers only and return concise paths/symbols/responsibilities.","context":"Workspace: <path>. This child is terminal-only for context conservation: aggregate locally with rg/git grep/sed/node/python and keep stdout under 150 lines or 20 KB. Do not edit files, install packages, mutate git, call network writes, or continue after the first useful map.","toolsets":["terminal"]}`.
- Limit broad search/read behavior: use targeted search patterns and read only the smallest relevant files or sections. Do not dump large recursive search results; summarize matches by path and symbol.
- Prefer five to eight highly relevant files per research task. If more are needed, report the next files to inspect instead of reading all of them.
- Tell research subagents to avoid file edits, package installs, git mutations, GitHub/Linear writes, secrets inspection, and lifecycle writeback.
- Ask for concise output: answer, evidence paths/symbols, relevant tests, risks/open questions, and no raw transcript dump.
- If the subagent reaches compression or is about to compact, stop and return current findings instead of continuing the research chain.
- Prefer at most three parallel research subagents for independent questions.

Do not delegate:

- The final implementation decision.
- The final validation and completion report.
- Secrets, credential handling, or privileged external writes.
- Simple local checks that one command or one targeted file read can answer.

## Orchestration and dogfood invariants to verify

When the change touches Symphony orchestration or dogfood worker/reviewer prompts, explicitly consider:

- Lifecycle phase and blocked reason handling.
- Review counters and incomplete-turn counters.
- Run terminal status.
- Transcript events and completion-report events.
- PR metadata propagation without direct publication by the worker.
- Tracker/writeback comments and transitions, while leaving service-owned lifecycle transitions to Symphony.
- MCP, HTTP/status API, orchestrator, outbox, tracker, harness, and persistence boundaries.
- Approval/publication variants: pending, approved, rejected, cancelled, stale, expired, already-terminal, replay, reject-policy cancel/fail, live-worker wait, and after-worker-exit resume when applicable.
- Dispatch invariants: no redispatch and no incomplete-turn burn while an intentional non-dispatch or user-required state is active.

## Completion report checklist

Before calling the completion report tool, gather:

- Concise implementation summary.
- Validation commands and results, including any known pre-existing or out-of-scope failures.
- Acceptance criteria mapped one-by-one to evidence. If a fenced JSON Issue Contract exists, map every requirement ID to proof and leave any unproven requirement unsatisfied.
- For operator instructions or recorded artifacts, proof must verify the exact documented command invocation and the exact emitted fields, API responses, logs, or files. Do not claim a requirement is satisfied from inferred behavior or a nearby implementation path.
- List of materially changed files.
- Current branch name and any existing PR number/URL/head SHA only if already known from context or safe read-only inspection.
- Risks, limitations, and intentionally unverified scenarios.
- Stable idempotency key, usually issue slug plus a brief implementation marker.

## Pitfalls

- Do not treat a final chat summary as sufficient; Symphony requires the MCP completion report.
- Do not move Linear lifecycle state, assign the issue, mark it done, or directly publish/update the lifecycle-bound PR from the worker.
- Do not ignore a full-suite failure: distinguish pre-existing or unrelated failures from regressions and report the risk explicitly.
- During merge-gate repair, do not assume the previously reported "unrelated" failure can remain unresolved: reproduce it in the current worktree and check whether it is a stale expectation against an accepted adjacent contract.
- Avoid one-case fixes for reviewer feedback; repair the invariant or side-effect path behind the finding and sweep adjacent cases that share that invariant.
