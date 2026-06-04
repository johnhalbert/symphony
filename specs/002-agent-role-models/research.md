# Research: Configure Agent Role Models

## Decision: Add top-level `role_models` workflow configuration

Use optional non-secret workflow configuration:

```yaml
role_models:
  orchestrator: gpt-5.5
  worker: gpt-5.3-codex-spark
  reviewer: gpt-5.4
```

**Rationale**: Existing `cursor.model` and `hermes.model` are harness-level defaults, not role-level assignments. A top-level role map keeps the operator intent direct, avoids overloading `agent` with service/orchestrator concerns, and remains independent of whether a role is currently backed by Cursor, Hermes TUI/JSON-RPC, or a future stable Hermes ACP path.

**Alternatives considered**:

- Extend `hermes.model` into a nested role map. Rejected because it would not cover Cursor-backed runs or orchestrator chat.
- Add `review_loop.reviewer_model` and `worker_model`. Rejected because it splits one concern across unrelated sections and leaves orchestrator unresolved.
- Require separate Hermes source profiles per role. Rejected as the main contract because it exposes runtime-specific setup and does not help Cursor-backed roles.

## Decision: Preserve existing defaults through a shared resolver

Resolved role models should use explicit `role_models.<role>` when present. Missing role entries fall back to existing behavior:

- `orchestrator` falls back to the existing general Cursor model path.
- `worker` falls back to the active harness's current model behavior.
- `reviewer` falls back to the active harness's current model behavior.

**Rationale**: This keeps current workflows working when `role_models` is absent and lets operators opt in one role at a time.

**Alternatives considered**:

- Require all three role entries whenever `role_models` is present. Rejected because it makes gradual rollout harder and conflicts with the spec's partial override story.
- Make reviewer fall back to worker only. Rejected because fallback should describe the existing harness default, not a new hidden dependency between roles.

## Decision: Validate syntax at config load and availability at role-session preflight

Config parsing should reject present-but-empty, whitespace-only, multiline, or control-character model identifiers. Provider availability should be checked only when the affected role session starts, before prompt/work delegation.

**Rationale**: Model availability depends on the selected runtime provider account and may require credentials. Parsing workflow config must remain deterministic, fast, and non-secret. Runtime preflight can use the existing provider/auth path and fail before work is delegated to the affected role.

**Alternatives considered**:

- Query provider model catalogs during config parsing. Rejected because it would add network/credential side effects to ordinary config loading.
- Accept all strings and let prompts fail later. Rejected because the spec requires role-specific errors before work begins.

## Decision: Record selection source in existing run metadata

Persist the effective model in `runtimeModel` and record a source marker in `runtimeSettingSources`, such as `role_model:worker:explicit` or `role_model:reviewer:default:hermes.model`.

**Rationale**: Existing file and PostgreSQL run-session storage already carries runtime model fields. Source markers satisfy the audit requirement without a schema migration and keep replay behavior aligned with existing run metadata normalization.

**Alternatives considered**:

- Add new run-record fields for role model source. Rejected for v1 because source markers are sufficient and avoid broad projection/schema churn.
- Store only the model identifier. Rejected because operators need to distinguish explicit role overrides from defaulted selection.

## Decision: Apply role models before prompt submission in stable harnesses

Cursor should build `ModelSelection` from the resolved role model. Hermes TUI/JSON-RPC should pass the resolved role model into the gateway environment and provider-limit defaults.

**Rationale**: Every implemented role runtime's work must start on the resolved model. Existing code already has a `session_started` event carrying provider/model metadata. Applying the selection before prompt submission prevents agents from doing work on the wrong model.

**Alternatives considered**:

- Put role model instructions only in prompts. Rejected because workers/reviewers could ignore or be unable to enforce that instruction.
- Implement Hermes ACP role-model switching immediately. Rejected for the initial slice because the ACP feature implementation is still in flight; ACP role-model tasks should be blocked by ACP stabilization and implemented only after that contract is stable.
- Change vendored Hermes ACP source. Rejected by the constitution.

## Decision: Gate Hermes ACP role-model support behind ACP stabilization

Hermes ACP should be represented in tasks as blocked follow-up work, dependent on the ACP harness/session implementation becoming stable. The intended future contract is to create the host ACP session, apply the resolved role model through the host ACP session model switch path before `session/prompt`, and then record the confirmed session model when reported by the host runtime.

**Rationale**: The role-model feature should not expand into finishing or debugging ACP. Blocking ACP-specific work keeps the initial implementation valuable for stable harnesses while preserving a clear path once ACP lands.

**Alternatives considered**:

- Drop ACP from the plan entirely. Rejected because the eventual behavior should be documented so task generation does not forget the dependency.
- Implement ACP best-effort now. Rejected because incomplete ACP substrate would make failures ambiguous and could block delivery of role-model support for stable runtime paths.

## Decision: Treat orchestrator as a service model role, not an `AgentRunRole`

Introduce a model-role type for `orchestrator | worker | reviewer` rather than expanding the existing agent run role union immediately.

**Rationale**: Current persisted agent run roles are worker/reviewer. Orchestrator chat and orchestration decisions are service-owned surfaces, not delegated runtime worker/reviewer sessions. Keeping the type separate avoids accidentally granting orchestrator authority to runtime agents.

**Alternatives considered**:

- Add `orchestrator` to `AgentRunRole`. Rejected because it would affect many lifecycle, credential, MCP, and tracker surfaces that intentionally model only delegated worker/reviewer runs.
