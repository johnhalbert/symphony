# Quickstart: Configure Agent Role Models

## Example Workflow Configuration

Add role-specific model settings to `WORKFLOW.md`:

```yaml
role_models:
  orchestrator: gpt-5.5
  worker: gpt-5.3-codex-spark
  reviewer: gpt-5.4
```

Partial overrides are valid:

```yaml
role_models:
  reviewer: gpt-5.4
```

With the partial example, reviewer sessions use `gpt-5.4`; orchestrator and worker sessions keep their documented defaults.

## Validation Checklist

1. Parse workflow configuration with all three role models and confirm `config.roleModels` contains explicit orchestrator, worker, and reviewer entries.
2. Parse workflow configuration with only one role model and confirm omitted roles fall back to existing defaults.
3. Configure an empty or whitespace-only role model and confirm config parsing fails with the affected role path.
4. Start worker and reviewer runs with different configured models and confirm each run record stores the correct `runtimeModel` and `runtimeSettingSources`.
5. Change workflow configuration while a run is active and confirm the active run record keeps its original model.
6. Exercise Hermes TUI/JSON-RPC and Cursor-backed role sessions with fake harness/runtime clients before any live-runtime check.
7. Verify orchestrator chat command metadata records the resolved orchestrator model without creating worker/reviewer authority.
8. Keep Hermes ACP role-model validation blocked until the ACP harness/session feature implementation is stable; once unblocked, add fake ACP client coverage before any live ACP check.

## Targeted Commands

```powershell
npm run typecheck
npm test -- tests/workflow.test.ts tests/orchestrator.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts tests/transcript-store.test.ts tests/web-history-projection.test.ts tests/web-projection.test.ts tests/web-orchestrator-chat-api.test.ts
```

Optional live-runtime readiness after unit coverage:

```powershell
npm run doctor -- --live-runtime
```

Run the live check only in an environment with the intended Hermes/Cursor provider credentials already configured.
