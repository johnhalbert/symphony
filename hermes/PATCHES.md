# Vendored Hermes Source

`hermes/upstream-src` is a vendored copy of the Hermes agent repository. It is
tracked as normal Symphony source instead of as a Git submodule so CI and local
checkouts do not depend on fetching Symphony-only Hermes commits.

## Upstream Base

- Repository: `https://github.com/NousResearch/hermes-agent.git`
- Public base commit: `458a94e42568b332e8794ca8fbb8c8e1279160a3`
- Former local patched commit: `a01e928937abdee53be25e726b7f5ed4ebb4ab9f`

## Symphony Patches

The vendored tree currently carries these Symphony-owned changes on top of the
public base:

- Isolated auth storage:
  - Adds `HERMES_AUTH_HOME` support so generated profile homes can stay isolated
    while provider auth is shared through a managed auth root.
  - Redirects auth reads, writes, and locking to
    `HERMES_AUTH_HOME/auth.json` and `HERMES_AUTH_HOME/auth.lock` when the
    variable is set.
- Gateway startup tuning:
  - Adds `HERMES_TUI_AGENT_INIT_TIMEOUT_MS` for Symphony-controlled gateway
    startup timeouts.
- Gateway provider-limit diagnostics:
  - Carries the local gateway/client diagnostics that were present in the
    former submodule checkout at the time it was vendored.

Backup patch files for the conversion were written to:

`%TEMP%/symphony-hermes-vendor-backups/`

## Updating From Upstream

Use `git subtree` to update the vendored tree from a public Hermes commit, then
reconcile the Symphony patches above:

```powershell
git subtree pull --prefix=hermes/upstream-src https://github.com/NousResearch/hermes-agent.git <upstream-ref> --squash
```

After any update, verify the Hermes integration:

```powershell
npm run typecheck
npm test
npm run doctor -- --strict
```
