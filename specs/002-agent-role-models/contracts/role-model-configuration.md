# Contract: Role Model Configuration

## Workflow Configuration

Add optional top-level workflow configuration:

```yaml
role_models:
  planner: gpt-5.5
  worker: gpt-5.3-codex-spark
  reviewer: gpt-5.4
```

All keys are optional. Environment-variable references follow the existing workflow convention:

```yaml
role_models:
  worker: $SYMPHONY_WORKER_MODEL
```

## Resolution Rules

1. Resolve environment-variable references using the existing config string resolver.
2. If a role key is present, trim the resolved value and validate it as a model identifier.
3. If a role key is omitted, use the role's documented default:
   - `planner`: current planner/chat model behavior, including the general Cursor model default where the planner is Cursor-backed.
   - `worker`: current active harness default model behavior.
   - `reviewer`: current active harness default model behavior.
4. Freeze the resolved role model when the role session starts.
5. Do not retroactively change in-progress role sessions after config reload.

## Validation Rules

Valid model identifiers:

- Are non-empty after trimming.
- Do not contain line breaks.
- Do not contain ASCII control characters.
- May contain provider/model punctuation such as `.`, `-`, `_`, `/`, and `:`.
- Are treated as non-secret metadata.

Invalid explicit settings must raise a role-specific config validation error:

```text
role_models.worker must be a non-empty model identifier
```

Runtime availability failures must identify the affected role before prompt/work delegation:

```text
Reviewer model gpt-5.4 is unavailable for the configured runtime provider.
```

Credential values, provider tokens, private keys, raw auth records, and secret-bearing environment values must not appear in these messages.

## Runtime Obligations

### Cursor Harness

- Build Cursor `ModelSelection` from the resolved model for the current role.
- Preserve existing model params for the default Cursor model path.
- Record explicit/default role model source in run metadata.

### Hermes TUI / JSON-RPC Harness

- Pass the resolved worker/reviewer model into the gateway environment before session creation/prompt submission.
- Use the resolved model for provider-limit scope defaults.
- Record explicit/default role model source in run metadata.

### Hermes ACP Harness (Blocked Follow-Up)

ACP role-model wiring is intentionally blocked until the ACP harness/session feature implementation is stable. Do not implement this section in the first task wave unless the ACP stabilization dependency has landed.

- Create the host ACP session.
- Apply the resolved role model through the host ACP session model switch path before `session/prompt`.
- Treat model switch failure as a role-specific configuration problem.
- Record the confirmed ACP session model when reported by the host runtime.

### Planner Dashboard / Chat

- Resolve the `planner` model for the existing user-facing planner template and main-dashboard planning/chat command handling.
- Record the resolved planner model in planner conversation command metadata when a command is accepted or rejected.
- Do not create worker/reviewer run authority for planner chat.
- Do not add a separate `role_models.orchestrator` key; `orchestrator` remains the internal service coordination concept.

## Run Metadata Contract

Started worker/reviewer runs must include:

```json
{
  "role": "worker",
  "harnessId": "hermes",
  "runtimeModel": "gpt-5.3-codex-spark",
  "runtimeSettingSources": [
    "role_model:worker:explicit",
    "provider:openai-codex"
  ]
}
```

Defaulted roles must include a default marker:

```json
{
  "role": "reviewer",
  "runtimeModel": "gpt-5.3-codex-spark",
  "runtimeSettingSources": [
    "role_model:reviewer:default:hermes.model",
    "provider:openai-codex"
  ]
}
```

The stored model value is immutable for that started run even if workflow configuration changes later.
