# Quickstart: ENG-243 Command Policy Plan

## Scope Check

Use this plan for ENG-243 implementation work only:

- Worker implementation runs.
- Reviewer runs.
- Merge-conflict-repair worker runs.
- Terminal, shell, `execute_code`, ACP permission, Hermes gateway/TUI pre-tool-call, and delegated subagent command surfaces.
- Service-owned GitHub publication/review/writeback, mergeability checks, and CI checks must remain separate and functional.

## Implementation Order

1. Add a shared worker/reviewer command policy classifier.
2. Add table-driven tests for direct upstream commands, safe local inspection, disguised commands, inline environment, unsafe Git config, and fake-helper side effects.
3. Wire the classifier into Hermes ACP permission resolution.
4. Add a Symphony-managed Hermes gateway/TUI `pre_tool_call` hook or plugin through worker/reviewer profiles.
5. Add profile/harness tests proving the hook is installed and fail-closed when unavailable.
6. Add durable run activity/transcript audit records for policy decisions.
7. Verify service-owned MCP GitHub credential paths, mergeability checks, and CI check paths still work and are not blocked by the agent command policy.

## Local Validation

Run the focused checks that match the active Linear subissue.

For the Checkpoint A / Issue 10 / T029 US1 upstream-deny validation subissue, run the present US1 command-policy suite:

```powershell
npm run typecheck
npm test -- tests/agent-command-policy-upstream.test.ts tests/agent-command-policy-disguised.test.ts tests/agent-command-policy-execute-code.test.ts
npm test -- tests/agent-command-policy-hook-runner.test.ts tests/agent-command-policy-cli.test.ts tests/agent-command-policy-acp-resolver.test.ts
npm test -- tests/hermes-command-policy-profile.test.ts tests/hermes-delegated-command-policy.test.ts tests/hermes-template-policy.test.ts tests/hermes-mcp-config.test.ts
npm test -- tests/hermes-acp-harness.test.ts tests/hermes-mcp-config.test.ts tests/hermes-template-policy.test.ts
```

This Checkpoint A subset validates direct and disguised upstream denials, `execute_code`, ACP permission resolution, Hermes hook/CLI behavior, gateway/TUI profile hook installation, delegated subagent and command reducer inheritance, and broader ACP harness wiring. Later US2 local-inspection/config, US3 service-boundary, and US4 audit/replay suites remain separate subissue validation until those files exist.

For the Checkpoint B / Issue 15 / T041 US2 local-inspection targeted validation subissue, run the present US2 command-policy suite:

```powershell
npm run typecheck
npm test -- tests/agent-command-policy-local-inspection.test.ts tests/agent-command-policy-git-config.test.ts tests/agent-command-policy-fake-helper.test.ts tests/agent-command-policy-hook-runner-local.test.ts
```

This Checkpoint B subset validates helper-free local status/diff/log/show/branch/blame allow decisions, unsafe inline and inherited environment denial, per-command Git config denial, persisted repo/user fake-helper fail-closed behavior, selected worktree config inspection, hook-runner working-directory resolution, and redacted hook environment propagation.

For final targeted validation after the later user-story test files exist, run the full policy-facing suite:

```powershell
npm run typecheck
npm test -- tests/agent-command-policy-upstream.test.ts tests/agent-command-policy-disguised.test.ts tests/agent-command-policy-execute-code.test.ts tests/agent-command-policy-local-inspection.test.ts tests/agent-command-policy-git-config.test.ts tests/agent-command-policy-fake-helper.test.ts
npm test -- tests/agent-command-policy-hook-runner.test.ts tests/agent-command-policy-hook-runner-local.test.ts tests/agent-command-policy-cli.test.ts
npm test -- tests/agent-command-policy-acp-resolver.test.ts tests/hermes-acp-harness.test.ts tests/hermes-command-policy-profile.test.ts tests/hermes-delegated-command-policy.test.ts tests/hermes-template-policy.test.ts tests/hermes-mcp-config.test.ts
npm test -- tests/mcp-subprocess-environment-command-policy.test.ts tests/completion-report-mcp-command-policy.test.ts tests/review-feedback-mcp-command-policy.test.ts tests/github-service-boundary-command-policy.test.ts
npm test -- tests/run-activity-event-command-policy.test.ts tests/transcript-replay-command-policy.test.ts tests/web-transcript-projection-command-policy.test.ts
```

Latency regression coverage should keep normal direct policy decisions under 50 ms and local Git config inspection decisions under 250 ms using deterministic local fixtures. Avoid flaky end-to-end timing assertions against real provider, network, or desktop credential behavior.

After the full implementation, run the repo's CI-equivalent checks when time allows:

```powershell
npm ci
npm run typecheck
npm test
npm ci --prefix web
npm run typecheck --prefix web
npm test --prefix web
npm run build --prefix web
npm run smoke:browser --prefix web
npm run smoke:browser-production --prefix web
npm run extension:ci
npm run extension:typecheck
npm run extension:test
npm run extension:build
```

## Required Negative Scenarios

Validation must prove these are denied before upstream contact or helper execution:

- `git push`, `git pull`, `git fetch`, `git clone`, and remote updates.
- `gh pr create`, `gh pr edit`, `gh pr review`, and other GitHub CLI calls.
- SSH and HTTPS GitHub transports.
- `curl`, `wget`, or API clients targeting GitHub hosts.
- Absolute paths to Git, GitHub CLI, SSH, shells, or interpreters.
- Inline environment assignments such as Git external diff, pager, credential helper, SSH command, or config-count overrides.
- Per-command and persisted Git config for aliases, pagers, external diff, credential helpers, hooks, filters, signing programs, filesystem monitors, and transport helpers.
- Shell scripts, nested shells, package scripts, and interpreter subprocesses that hide the upstream operation.
- `execute_code` attempts that can spawn subprocesses, open network clients, or access credential-backed GitHub paths.
- Delegated subagent and command reducer attempts that wrap or forward any blocked command-capable operation.

## Required Positive Scenarios

Validation must prove these remain usable when helper-free and local-only:

- Local status.
- Local diff.
- Local log/show.
- Local branch listing.
- Local blame/file history.
- Local repository inspection through bounded reducer commands that cannot contact GitHub or execute helpers.

## Audit Verification

For each allow or deny scenario, inspect durable run activity or replayed transcript state and confirm:

- Role and phase are present.
- Surface is present.
- Outcome is structured.
- Reason kind is structured.
- Evidence is redacted.
- Upstream contact is false for denied scenarios.
- Service-owned GitHub failures are not recorded as agent command policy denials.

## Service Boundary Verification

Confirm service-owned GitHub workflow actions remain outside worker/reviewer command policy:

- Publication and completion report writeback use the service-owned credential path.
- Review feedback writeback uses the service-owned credential path.
- Mergeability checks and CI check reads/writes use service-owned workflow handling.
- Equivalent worker/reviewer terminal, shell, `execute_code`, delegated subagent, or command reducer attempts are denied and redirected to the service-owned workflow.

## Dogfood Validation

After rollout, validate SC-004 against real worker/reviewer dogfood runs by inspecting run activity, policy denial records, and desktop prompt observations. The expected result is zero desktop OAuth prompts, SSH key confirmation prompts, or GitHub credential prompts caused by agent-owned command attempts.

Do not intentionally trigger real credential prompts as the validation mechanism. Use local fixtures, fake helpers, run evidence, and operator observation instead.

## Process Notes

- Vendored Hermes source changes under `hermes/upstream-src/**` are not allowed for ENG-243. If enforcement cannot be achieved through Symphony-owned code, generated profile assets, hooks/plugins, MCP/service boundaries, or configuration, stop and report the gap as blocked.
- Do not use upstream Git commands while implementing or validating this feature unless they are part of service-owned Symphony publication workflow.
- Do not rely on desktop credential prompts as a signal; tests must use fake helpers and local-only fixtures.
- If a command-capable surface cannot be preflighted before execution, fail closed for worker/reviewer roles and document the surface explicitly.
- Final validation must confirm vendored Hermes source is untouched:

```powershell
git diff --name-only -- hermes/upstream-src
git status --short -- hermes/upstream-src
```

Both commands must produce no changed paths.
