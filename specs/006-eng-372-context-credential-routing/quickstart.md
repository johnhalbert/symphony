# Quickstart: ENG-372 Context Credential Routing

## Scenario 1: Distinct context credentials resolve correctly

1. Configure two test contexts with distinct tracker credentials for the same capability.
2. Run:

   ```powershell
   npm test -- tests/credential-profiles.test.ts tests/linear-credential-resolver.test.ts tests/github-credential-resolver.test.ts
   ```

3. Confirm each context resolves only its assigned profile and no secret values appear in output.

## Scenario 2: Live tracker paths do not use default fallback

1. Seed a default context and a secondary context with separate tracker clients.
2. Exercise candidate polling, reviewer polling, and status lookup for the secondary context.
3. Run:

   ```powershell
   npm test -- tests/linear.test.ts tests/orchestrator.test.ts tests/status-api.test.ts
   ```

4. Confirm the secondary tracker is selected before live reads.

## Scenario 3: Identifier-only fallback resolves before fetch

1. Trigger a status or workspace action with a visible identifier.
2. Confirm Symphony resolves context and canonical tracker identity before fetching live state.
3. Include a duplicate-identifier case and confirm ambiguous input fails closed.

## Scenario 4: Issue-breakdown uses the same route contract

1. Run issue-breakdown request and apply flows for a non-default context.
2. Run:

   ```powershell
   npm test -- tests/issue-breakdown-plan-service.test.ts tests/issue-breakdown-plan-apply-service.test.ts
   ```

3. Confirm tracker reads and writeback preparation use the resolved context.

## Full Validation

After child tasks complete, run:

```powershell
npm test -- tests/credential-profiles.test.ts tests/linear-credential-resolver.test.ts tests/github-credential-resolver.test.ts tests/linear.test.ts tests/orchestrator.test.ts tests/status-api.test.ts tests/workspace.test.ts tests/issue-breakdown-plan-service.test.ts tests/issue-breakdown-plan-apply-service.test.ts tests/mcp-subprocess-environment.test.ts
```
