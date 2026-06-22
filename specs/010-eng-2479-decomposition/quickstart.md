# Quickstart: ENG-2479 Runtime Child Preflight Decomposition

## Purpose

Use this plan to prepare ENG-2479 decomposition artifacts inside the Spec Kit flow before any live Linear child issue creation.

## Workflow

1. Confirm the active feature directory:

   ```powershell
   Get-Content -Raw .specify\feature.json
   ```

   Expected feature directory: `specs/010-eng-2479-decomposition`.

2. Read the planning artifacts:

   - `specs/010-eng-2479-decomposition/spec.md`
   - `specs/010-eng-2479-decomposition/plan.md`
   - `specs/010-eng-2479-decomposition/research.md`
   - `specs/010-eng-2479-decomposition/data-model.md`
   - `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
   - `specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md`
   - `specs/010-eng-2479-decomposition/contracts/parent-handoff.md`

3. Before generating tasks, confirm the corrected scope:

   - Planning prepares Linear-ready child issue bodies.
   - Planning does not create live Linear issues.
   - Live issue creation must wait for `/speckit-tasks` followed by the project-approved issue-sync flow.

4. Generate implementation tasks with `/speckit-tasks`.

5. Validate prepared child contracts before issue sync:

   - Every child body has exactly one fenced JSON Issue Contract.
   - Every contract has a non-empty `contractVersion`.
   - Every requirement has a stable, unique, non-empty ID.
   - Dependency order matches `T033A -> T033B -> T033C -> T033D`, with T033C also blocked by T033A.
   - No body includes secrets, credential values, customer-private data, or unnecessary local absolute paths.

6. At issue-sync time, check Linear for existing ENG-2479 children:

   - If a child already owns a blocker category, do not create a duplicate.
   - If no duplicate exists, synchronize the prepared body through the approved Spec Kit or Symphony-owned flow.

7. After child evidence exists, prepare the parent handoff from `contracts/parent-handoff.md`.

## Completion Evidence

Planning is complete when these artifacts exist and contain no unresolved clarification markers:

- `plan.md`
- `research.md`
- `data-model.md`
- `quickstart.md`
- `contracts/child-issue-bodies.md`
- `contracts/issue-sync-gate.md`
- `contracts/parent-handoff.md`

## Out Of Scope

- Live Linear child creation during `/speckit-plan`.
- Moving ENG-2479 out of Blocked.
- Running worker/reviewer validation.
- Runtime implementation.
- Publication, merge, or protected branch updates.
- Changes under `hermes/upstream-src/**`.
