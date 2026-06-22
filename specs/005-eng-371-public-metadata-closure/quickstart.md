# Quickstart: ENG-371 Public Metadata Redaction Closure

## Scenario 1: Redaction matrix passes

1. Add or update synthetic fixtures for tokens, private keys, environment values, profile contents, repository user-info, query, fragment, pathless, and single-label repository-like values.
2. Run focused validation:

   ```powershell
   npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/credential-profiles.test.ts
   ```

3. Confirm forbidden synthetic substrings do not appear in public metadata.

## Scenario 2: Direct and normalized paths match

1. Build equivalent private context input through direct helper usage and normalized workflow configuration.
2. Run the focused config tests.
3. Confirm public metadata is equivalent and redacted in both paths.

## Scenario 3: Merge-gate repair is bounded

1. Rebase or repair the ENG-371 branch against current base without adding unrelated behavior.
2. Run focused redaction validation.
3. Record whether the final change is `conflict_only`, `redaction_fix`, or `mixed`.

## Full Validation

After child tasks complete, run:

```powershell
npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/credential-profiles.test.ts tests/transcript-store.test.ts tests/web-projection-context.test.ts tests/issue-contract-lint.test.ts
```
