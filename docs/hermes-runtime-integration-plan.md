# Hermes Runtime Harness Integration Plan

## Summary

Integrate Hermes as a Symphony runtime harness by reusing the upstream Hermes TUI stdio gateway path. Symphony should expose one provider id, `hermes`, while `HermesHarness` internally manages per-role and per-workspace Hermes leases. Each lease owns a copied Hermes home/profile, a scoped TUI `GatewayClient`, one Python gateway process, and one Hermes session.

This implementation intentionally does not build a separate Hermes agent API. It imports the upstream TUI `GatewayClient` through a narrow Symphony facade and controls process-level isolation with explicit `HERMES_HOME`, `HERMES_AUTH_HOME`, `HERMES_CWD`, `TERMINAL_CWD`, `HERMES_PYTHON_SRC_ROOT`, Python, and credential environment.

## Constraints

- Cursor remains supported and is still the parser default when no harness is configured.
- The reference dogfood workflow selects Hermes with `agent.harness: hermes`.
- Generated Hermes profiles must not dirty target workspaces.
- Reviewer runs require fresh Hermes homes and must not inherit memory from previous review rounds.
- Worker implementation turns may reuse a live Hermes session within the same Symphony process.
- The initial integration uses stdio gateway processes, not a shared web gateway.
- The upstream Hermes source lives as a submodule at `hermes/upstream-src/`.

## Architecture

```text
Symphony Orchestrator
  -> AgentHarness: HermesHarness
       -> HermesLease(worker implementation, issue/workspace)
            -> generated HERMES_HOME under workspace.stateDir
            -> scoped upstream TUI GatewayClient
            -> python -m tui_gateway.entry
            -> Hermes session
       -> HermesLease(reviewer, review run)
            -> fresh generated HERMES_HOME
            -> scoped upstream TUI GatewayClient
            -> python -m tui_gateway.entry
            -> Hermes session
```

## Important Findings

- The TUI `GatewayClient` reads process environment, not constructor options.
- The default stdio gateway path does not allocate ports, so parallel gateway leases do not conflict.
- Hermes `tui_gateway.server` stores sessions, config cache, MCP registry, and runtime state at process/module scope.
- Hermes `session.create` does not accept per-session `HERMES_HOME`, cwd, model, MCP, or profile options.
- Hermes `mcp_servers` supports `command`, `args`, and `env`, but not per-server cwd. The gateway process cwd must therefore be the Symphony workspace path.
- Hermes profiles are already designed as independent `HERMES_HOME` directories containing config, `.env`, SOUL, memory, sessions, skills, logs, and a subprocess `home/`.
- OpenAI Codex OAuth is Hermes-owned auth. Symphony bootstraps selected provider state from a locally authenticated Hermes home into a managed auth root, then gives gateway processes that root through `HERMES_AUTH_HOME`.

## Implementation Steps

1. Add upstream Hermes as a git submodule at `hermes/upstream-src/`.
2. Add `hermes/src/GatewayFacade.ts` as the only direct import boundary for upstream TUI `GatewayClient`.
3. Add a scoped GatewayClient wrapper that sets and restores environment synchronously around upstream `start()` and `request()` calls.
4. Add `HermesConfig` to Symphony config with upstream root, Python path, template dir, generated state dir, role templates, credential env, and timeout/cleanup settings.
5. Add canonical credential capability `runtime.hermes` and a generic `resolveRuntimeCredential(config, role, harnessId)` implementation.
6. Add `HermesProfileManager` to materialize generated profile homes from templates under `workspace.stateDir/hermes/profiles`.
7. Add role templates under `hermes/templates/` for worker, reviewer, and planner phases.
8. Add `HermesMcpConfigWriter` to translate Symphony MCP subprocess configs into Hermes `mcp_servers` YAML.
9. Add `HermesLease` to own one GatewayClient, one Hermes session, event mapping, stop/interrupt, and cleanup.
10. Add `HermesHarness` implementing `AgentHarness` and managing lease reuse/disposal policy.
11. Register `hermes` in the runtime harness factory.
12. Add a generic runtime metadata seam so new Hermes runs persist `harnessId`, model/provider/profile/session metadata without Cursor-specific hardcoding.
13. Add `HermesAuthManager` for managed auth bootstrap and OpenAI Codex auth validation.
14. Add Hermes doctor checks for upstream root, Python importability, template validity, generated profile writability, MCP config generation, and managed auth readiness.
15. Add tests for config, credentials, profile isolation, scoped env, managed auth projection, MCP config rendering, event mapping, harness factory registration, worker continuation, reviewer one-shot isolation, stop behavior, and doctor checks.
16. Run `npm run typecheck` and `npm test`.

## Default Runtime Behavior

- `agent.harness` defaults to `cursor`.
- `agent.harness: hermes` selects `HermesHarness`.
- Worker implementation leases are reused by workspace/issue/phase while the service process is alive.
- Reviewer leases are fresh per review run and are disposed after the turn.
- Planning and merge-conflict leases are fresh unless explicitly configured otherwise later.
- Hermes generated homes live under `workspace.stateDir/hermes/profiles`.
- For `hermes.provider: openai-codex`, Symphony uses managed Hermes auth under `hermes.auth.managed_root`, defaulting to `hermes.state_dir/auth`. Operators authenticate Hermes locally first; Symphony bootstraps selected provider state from `hermes.auth.bootstrap_from` and shares it with generated profiles through `HERMES_AUTH_HOME`.
- API-key Hermes providers may still resolve `runtime.hermes` and inject it into the gateway environment under `hermes.runtime_credential_env`, defaulting to `HERMES_API_KEY`.

## Validation

- Unit tests cover config parsing, credential resolution, profile generation, MCP config rendering, GatewayClient env scoping, event mapping, and harness lifecycle.
- Existing Cursor tests must continue passing.
- Provider-neutral guardrails must continue preventing app/orchestrator imports from provider-owned Cursor/Hermes modules.
- Typecheck must pass with upstream GatewayClient imported through the facade.

## Implementation Status

Implemented in this pass:

- `hermes/upstream-src/` is a git submodule pointing at the upstream Hermes agent repository.
- `hermes/src/GatewayFacade.ts` is the only direct TypeScript import of the upstream TUI gateway client.
- `HermesHarness` is registered under `agent.harness: hermes`.
- Worker implementation runs reuse a Hermes lease by workspace, issue, and phase when configured with `reuse_by_issue`.
- Reviewer, planner, and merge-conflict runs use fresh generated Hermes homes by default.
- Hermes role templates live under `hermes/templates/`.
- `runtime.hermes` is the canonical credential capability for Hermes runtime credentials.
- `HermesAuthManager` manages OpenAI Codex auth bootstrap into a Symphony-managed auth root.
- Doctor checks include Hermes runtime config, upstream path checks, template checks, Python importability, and managed auth readiness for `openai-codex`.
- `npm run typecheck` and `npm test` pass on the initial implementation.
