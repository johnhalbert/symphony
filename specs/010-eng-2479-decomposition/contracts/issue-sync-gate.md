# Contract: ENG-2479 Issue Sync Gate

This gate must pass before prepared child bodies are synchronized to Linear.

## Inputs

- `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
- Active ENG-2479 child list from Linear at sync time
- Active ENG-2479 blocked triage and review comments
- Current parent chain context: `ENG-2479 -> ENG-392 -> ENG-351 -> ENG-347`

## Required Checks

1. No active existing ENG-2479 child already owns the same blocker category.
2. Every prepared child body includes exactly one fenced JSON Issue Contract.
3. Every contract parses as JSON and has `schemaVersion`, `contractVersion`, and non-empty unique requirement IDs.
4. Every prepared child body states intended parent, blocker relation, blocked-by relation, acceptance criteria, validation requirements, and out-of-scope boundaries.
5. No prepared body contains credential values, raw environment variable values, secret-backed profile contents, customer-private data, or unnecessary local absolute paths.
6. No prepared body authorizes runtime implementation, publication, protected branch updates, or `hermes/upstream-src/**` changes.
7. The sync path is service-owned or explicitly invoked by a Spec Kit issue-sync command.

## Pass Criteria

- Duplicate check is clean.
- Contract validation is clean.
- Dependency order is unambiguous.
- Redaction check is clean.
- The operator or issue-sync command can apply the prepared bodies without interpreting hidden scope.

## Fail Criteria

- A duplicate child exists for any blocker category.
- Any contract is missing, duplicated, malformed, empty, or has unstable requirement IDs.
- Any child body authorizes live effects outside its stated scope.
- Any artifact contains secrets or unnecessary local absolute paths.
- The proposed sync action would mutate Linear outside the requested Spec Kit flow.

## Sync Metadata

If synchronized, each child should use:

- Team: Engineering
- Project: Symphony
- Parent: ENG-2479
- Priority: High
- Labels: dogfood-ready, dogfood
- Delegate: Sinfonista
- Initial state: Backlog or the team's normal pre-dispatch state
