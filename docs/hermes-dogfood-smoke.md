# Hermes Dogfood Smoke

This document records the ENG-78 runtime-harness dogfood smoke result. The worker intentionally made only this small repository change and used local Symphony/Hermes runtime artifacts for evidence.

## Issue context inspected

- Linear issue: ENG-78, "Hermes dogfood smoke: verify runtime identity and config".
- State at dispatch: In Progress.
- Labels at dispatch: dogfood-ready, dogfood, runner, testing, improvement.
- Blockers at dispatch: none (blockedBy is empty).
- Assigned workspace: symphony_workspaces/ENG-78 on branch johnhalbert/eng-78-hermes-dogfood-smoke-verify-runtime-identity-and-config.

## Runtime identity checklist

- [x] agent.harness is hermes — the active Symphony run metadata records harnessId = "hermes" for run hermes-8bf31844-6063-4e32-9bd3-9dbe58388613.
- [x] hermes.provider is openai-codex — the active run metadata records runtimeSettingSources including provider:openai-codex; the Hermes agent log also shows API calls using provider=openai-codex.
- [x] hermes.model is gpt-5.5 — the active run metadata records runtimeModel = "gpt-5.5"; the Hermes agent log also shows API calls using model=gpt-5.5.
- [x] Hermes worker template reasoning is xhigh — the materialized ENG-78 worker Hermes profile config contains agent.reasoning_effort = xhigh, and the source worker template contains the same value.
- [x] Hermes reviewer template reasoning is xhigh — the source reviewer template contains agent.reasoning_effort = xhigh.
- [x] Hermes planner template reasoning is xhigh — the source planner template contains agent.reasoning_effort = xhigh.

## Local evidence inspected

- symphony_workspaces/.symphony/completion-report-mcp/66dac98d-6238-4cbe-b71c-0eb9c025e5a8-1.json for the Linear title, description, labels, blockers, active role, and assigned workspace.
- symphony_workspaces/.symphony/runs/hermes-8bf31844-6063-4e32-9bd3-9dbe58388613/meta.json for active-run harnessId, runtimeModel, and runtime setting sources.
- symphony_workspaces/.symphony/hermes/profiles/ENG-78/worker/implementation/ENG-78-implementation/config.yaml for the materialized worker Hermes profile and agent.reasoning_effort.
- symphony_workspaces/.symphony/hermes/profiles/ENG-78/worker/implementation/ENG-78-implementation/logs/agent.log for provider/model runtime diagnostics.
- hermes/templates/worker/config.yaml, hermes/templates/reviewer/config.yaml, and hermes/templates/planner/config.yaml in the source repository path for the role template reasoning settings. These template files were inspected read-only; no protected runtime or workflow paths were changed.

## Scenario matrix

| Scenario | Result |
| --- | --- |
| Happy path: active worker run identity is persisted | Verified the active run records harnessId = "hermes", runtimeModel = "gpt-5.5", and provider source provider:openai-codex. |
| Runtime API diagnostics | Verified the Hermes profile agent log records live API calls with provider=openai-codex and model=gpt-5.5. |
| Local worker profile materialization | Verified the ENG-78 worker Hermes profile contains agent.reasoning_effort = xhigh. |
| Role template boundary | Verified worker, reviewer, and planner source templates all contain agent.reasoning_effort = xhigh; only the worker profile was materialized for this worker run. |
| Integration side effects | No Linear lifecycle fields, GitHub PRs, orchestration code, workflow config, tracker code, harness code, or persistence code were changed by this worker. |
| Out of scope | Post-handoff status transitions and reviewer-agent execution require later Symphony/operator verification after this worker report is accepted. |
