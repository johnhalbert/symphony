# Hermes ACP Integration Spec

Status: draft for future optional integration

Last investigated: 2026-05-30

## Purpose

Symphony currently integrates with Hermes through the custom Hermes TUI JSON-RPC
gateway. This document specifies a future ACP-based Hermes integration. The ACP
integration must be additive: it must not replace or regress the current
`hermes` TUI gateway harness until it has independent coverage and live-runtime
confidence.

The official Agent Client Protocol is the baseline, but the actual Hermes CLI
implementation is the controlling contract for Symphony. Hermes ACP is not a
strict spec-only implementation.

Runtime principle: Symphony should run the host machine's installed `hermes`
command and use Hermes profiles for isolation. The vendored Hermes tree remains
useful as reference source and test context, but it should not be the runtime
base for the ACP harness.

## Source Inputs

Reference implementation sources in the vendored Hermes tree:

- `hermes/upstream-src/acp_adapter/entry.py`
- `hermes/upstream-src/acp_adapter/server.py`
- `hermes/upstream-src/acp_adapter/session.py`
- `hermes/upstream-src/acp_adapter/auth.py`
- `hermes/upstream-src/acp_adapter/permissions.py`
- `hermes/upstream-src/acp_adapter/edit_approval.py`
- `hermes/upstream-src/acp_adapter/tools.py`
- `hermes/upstream-src/toolsets.py`
- `hermes/upstream-src/tests/acp*`
- `hermes/upstream-src/tests/acp_adapter/*`

Current Symphony integration sources:

- `hermes/src/HermesHarness.ts`
- `hermes/src/GatewayFacade.ts`
- `hermes/src/HermesMcpConfig.ts`
- `hermes/src/HermesProfileManager.ts`
- `hermes/src/HermesAuthManager.ts`
- `tests/hermes-harness.test.ts`

Host CLI behavior confirmed on 2026-05-30:

- `hermes --version` reports Hermes Agent v0.14.0.
- `hermes profile create --help` exposes `--clone`, `--clone-all`, and
  `--clone-from SOURCE`.
- `hermes profile create --help` describes `--clone` as copying `config.yaml`,
  `.env`, and `SOUL.md` from the active profile.
- `hermes_cli.profiles.create_profile()` also copies installed skills and
  selected profile identity files for `--clone`; `.env` is copied and tightened
  to owner-only permissions.
- `hermes acp --help` exposes the ACP stdio server command.
- `hermes -p <profile> acp --help` confirms profile-scoped ACP launch.

Reference ACP docs:

- `https://agentclientprotocol.com/protocol/overview`
- `https://agentclientprotocol.com/protocol/schema`
- `https://agentclientprotocol.com/protocol/authentication`
- `https://agentclientprotocol.com/protocol/session-setup`
- `https://agentclientprotocol.com/protocol/session-list`
- `https://agentclientprotocol.com/protocol/prompt-turn`
- `https://agentclientprotocol.com/protocol/transports`

## Goals

- Add a new optional Hermes ACP harness beside the existing TUI gateway harness.
- Use host-installed Hermes profiles for logical isolation, including cloned
  profile-local auth material from `.env`.
- Keep Symphony's MCP handoff, run transcripts, cancellation, and provider-limit
  handling.
- Treat Hermes ACP behavior as implementation-defined where it diverges from the
  public ACP spec.
- Make permission handling explicit and fail closed when Symphony cannot obtain
  an approval decision.
- Preserve deterministic run lifecycles for workers, reviewers, planners, and
  merge-conflict runs.

## Non-goals

- Do not remove or rewrite the current `HermesHarness`.
- Do not depend on Zed-specific UI behavior except where Hermes itself does.
- Do not implement full ACP client optional surfaces unless Hermes requires them
  for Symphony runs.
- Do not set `HERMES_AUTH_HOME` or maintain a Symphony-owned Hermes auth root
  for ACP. Auth should come from the cloned host Hermes profile.
- Do not run ACP from Symphony's vendored Hermes source unless explicitly
  requested for development/debugging.

## Current Integration Summary

The current `hermes` harness wraps Hermes' TUI gateway client:

- `GatewayFacade` imports `ui-tui/src/gatewayClient.js` from the vendored
  Hermes tree.
- `HermesHarness.run()` creates or reuses a Hermes gateway session, submits the
  prompt with `prompt.submit`, maps gateway events to `AgentEvent`, and stops
  runs with `session.interrupt`.
- The harness materializes per-role profile directories, writes Hermes MCP
  config, manages Hermes-owned auth roots, and injects environment variables
  such as `HERMES_HOME`, `HERMES_AUTH_HOME`, `HERMES_CWD`, `TERMINAL_CWD`,
  `HERMES_MODEL`, and `HERMES_TUI_PROVIDER`.

The ACP integration should reuse handoff, transcript, cancellation, cleanup, and
provider-limit plumbing, but it should not use `GatewayFacade` as the transport.
It should also replace Symphony-managed Hermes profile/auth materialization with
Hermes CLI profile creation and deletion.

## Hermes ACP Process

Run ACP through the host Hermes CLI:

```text
hermes -p <profile> acp
```

If the profile wrapper alias is created and available on `PATH`, this is
equivalent:

```text
<profile> acp
```

The current Hermes CLI also exposes `hermes-acp` as an entrypoint internally,
but Symphony should prefer `hermes -p <profile> acp` so profile selection,
environment loading, and host installation behavior stay under Hermes' control.

Command confirmation:

- `hermes acp --help` starts Hermes Agent in ACP mode for editor integration.
- `hermes -p <profile> acp --help` applies the named profile to ACP.
- In the confirmed v0.14.0 CLI, `gateway start` manages the messaging gateway,
  not the ACP stdio server. Do not use `gateway start` for ACP unless a future
  host Hermes version documents that syntax.

Observed ACP entry behavior from source:

- Stdout is reserved for JSON-RPC protocol frames. Human logs go to stderr.
- The selected Hermes profile controls state, config, `.env`, skills, memory,
  sessions, and logs.
- `--version`, `--check`, `--setup`, `--setup-browser`, and `--yes` are handled
  before server startup.
- Startup calls `discover_mcp_tools()` for config-defined MCP servers.
- The server runs with `acp.run_agent(agent, use_unstable_protocol=True)`.

The `use_unstable_protocol=True` flag is part of the runtime contract. Symphony
must tolerate unstable ACP methods being present or absent across Hermes updates.

## Transport Contract

Use JSON-RPC 2.0 over child-process stdio, matching ACP's standard process model.
The ACP client owns both directions:

- Client to Hermes: JSON-RPC requests and notifications.
- Hermes to client: JSON-RPC requests for client methods and notifications for
  session updates.

Hermes emits incidental agent output to stderr. Symphony should capture stderr
for diagnostics and log-tail payloads, but it must parse only stdout as protocol
traffic.

Unknown liveness probes such as `ping`, `health`, and `healthcheck` are treated
as benign for logging by Hermes, but they still receive normal JSON-RPC method
not found responses. Symphony does not need to send them.

## Profile Lifecycle

Hermes profiles are the isolation mechanism for ACP runs. `hermes_cli.profiles`
describes each profile as an independent Hermes home with its own `config.yaml`,
`.env`, memory, sessions, skills, gateway, cron, and logs. Named profiles live
under `~/.hermes/profiles/<name>/` by default; the default profile is
`~/.hermes`.

Recommended create command:

```text
hermes profile create <name> --clone --clone-from <source-profile> --no-alias
```

Notes:

- Profile names must be Hermes-safe ids. Generate lower-case names that fit the
  current Hermes validator: start with `[a-z0-9]`, then use `[a-z0-9_-]`, with
  a maximum length of 64 characters. Do not generate `default` or names that
  collide with host commands.
- Omit `--clone-from` to clone from the active profile.
- Omit `--no-alias` only when Symphony intentionally wants a profile wrapper
  command on `PATH`.
- Prefer `--clone` over `--clone-all` for normal runs. `--clone` copies config,
  `.env`, `SOUL.md`, installed skills, and selected identity files without
  copying full runtime state.
- Use `--clone-all` only for an explicit resume/debugging feature that wants the
  source profile's full state.
- For cleanup, prefer:

  ```text
  hermes profile delete <name> --yes
  ```

Auth implication: profile-local auth material in `.env` is cloned. Symphony
should not copy or rewrite Hermes auth itself. Providers that use external host
credential stores remain host-Hermes responsibilities; the cloned profile config
should continue to reference them.

## Launch Environment

The ACP harness should launch the host Hermes CLI with minimal environment
overrides:

- Process executable: `hermes` from `PATH`, or an explicit configured host
  Hermes binary path.
- Process args: `["-p", profileName, "acp"]`.
- Process cwd: the Symphony workspace path.
- ACP `session/new.cwd`: the Symphony workspace path.
- Do not set `HERMES_HOME`; `hermes -p <profile>` resolves it.
- Do not set `HERMES_AUTH_HOME`; auth comes from the cloned profile.
- Do not set `HERMES_PYTHON_SRC_ROOT` or `PYTHONPATH` for normal runs.
- Do not set `HERMES_MODEL` or `HERMES_TUI_PROVIDER` as the model selection
  mechanism for ACP.

ACP agent creation reads Hermes config through `hermes_cli.config.load_config()`
and `resolve_runtime_provider()`. Therefore the source profile, or the cloned
profile after an explicit config edit, must provide the model/provider that
Hermes ACP will resolve.

## Handshake

The Symphony ACP client should perform this sequence:

1. Spawn Hermes ACP and start JSON-RPC stdio pumps.
2. Send `initialize` with Symphony client info and client capabilities.
3. Select an auth method from `authMethods`.
4. Send `authenticate` with the selected `methodId`.
5. Send `session/new` with the workspace cwd and MCP servers.
6. Yield `session_started` after `session/new` succeeds.
7. Send `session/prompt`.
8. Consume `session/update` notifications and client method calls until the
   `session/prompt` response arrives.
9. Map `stopReason` to the terminal `AgentEvent`.

For cancellation, send ACP notification `session/cancel` with the active
`sessionId`. Do not expect a response. Hermes should return the pending
`session/prompt` response with `stopReason = "cancelled"` when cancellation is
observed.

Hermes does not advertise `session/close` and does not expose a close method in
the adapter. Process shutdown remains the reliable cleanup boundary.

## Initialize Response

Hermes returns:

- `protocolVersion`: Hermes' installed ACP SDK protocol version.
- `agentInfo.name`: `hermes-agent`
- `agentInfo.version`: Hermes version.
- `agentCapabilities.loadSession`: `true`
- `agentCapabilities.promptCapabilities.image`: `true`
- `agentCapabilities.sessionCapabilities.fork`: supported
- `agentCapabilities.sessionCapabilities.list`: supported
- `agentCapabilities.sessionCapabilities.resume`: supported
- `authMethods`: provider auth method when credentials are resolvable, plus the
  terminal setup method.

Hermes does not advertise filesystem or terminal client capabilities as
requirements. It uses its own local tools for file and terminal work and calls
`session/request_permission` for approval gates.

Hermes also does not explicitly advertise HTTP or SSE MCP capability in the
observed initialize response, even though the adapter accepts HTTP and SSE MCP
server objects. Symphony should prefer stdio MCP servers for the first ACP
implementation and treat HTTP/SSE as implementation-supported but not
capability-advertised.

## Authentication

Hermes advertises auth methods from `acp_adapter.auth`:

- Provider method: id is the detected provider, lower-cased, when
  `resolve_runtime_provider()` returns a usable string API key or callable token
  provider.
- Terminal setup method: id `hermes-setup`, type `terminal`, args `["--setup"]`.

`authenticate(methodId)` succeeds only when:

- `methodId` matches the detected provider, or
- `methodId` is `hermes-setup` and a provider is configured by the time
  authentication is checked.

Symphony should not run interactive terminal setup in unattended orchestration.
If only `hermes-setup` is available, treat that as a profile preparation
failure: the cloned profile did not provide usable runtime credentials for the
host Hermes installation.

Auth method selection:

- Prefer an auth method whose id matches the expected provider for the source
  profile, normalized to lower case, when Symphony knows it.
- Otherwise select the sole non-terminal provider method when present.
- Reject a `hermes-setup`-only response for normal Symphony runs.

## Session Methods

### `session/new`

Hermes Python method: `new_session(cwd, mcp_servers=None)`

Behavior:

- Creates a UUID session id.
- Translates Windows cwd to WSL `/mnt/<drive>/...` when Hermes runs in WSL.
- Creates a quiet `AIAgent` with `platform="acp"`, `enabled_toolsets` beginning
  with `hermes-acp`, `session_id`, `session_db`, and resolved provider/model.
- Registers the session cwd as a task env override for terminal tools.
- Persists a `source="acp"` session row in the selected profile's `state.db`.
- Registers ACP-provided MCP servers when supplied.
- Returns `sessionId`, `models`, and `modes`.
- Schedules `available_commands_update` and `usage_update`.

Symphony should use `session/new` for each lease rather than `load` or `resume`
unless a future feature intentionally implements ACP thread resume.

### `session/load`

Hermes Python method: `load_session(cwd, session_id, mcp_servers=None)`

Behavior:

- Returns `null` if the session is missing.
- Updates cwd and restores from `state.db` if needed.
- Registers MCP servers.
- Replays persisted history through `session/update` notifications before
  responding.
- Returns `models` and `modes`.

History replay is synchronous within the load request by design. A client that
implements load must be ready to route `session/update` notifications before the
load response is received.

### `session/resume`

Hermes Python method: `resume_session(cwd, session_id, mcp_servers=None)`

Behavior:

- Updates/restores the session when present.
- Creates a new session if the requested session id is missing.
- Replays history before responding.
- Returns `models` and `modes`.

This "create if missing" behavior is more forgiving than a strict resume
contract. Symphony should not depend on resume failure to detect missing threads.

### `session/fork`

Hermes Python method: `fork_session(cwd, session_id, mcp_servers=None)`

Behavior:

- Deep-copies the original history into a new UUID session when the original
  exists.
- Returns an empty `sessionId` when the original is missing, rather than a
  structured JSON-RPC error.
- Registers MCP servers and returns `models` and `modes` for the forked session.

Symphony does not need this for the first ACP harness.

### `session/list`

Hermes Python method: `list_sessions(cursor=None, cwd=None)`

Behavior:

- Lists in-memory and persisted ACP sessions from the selected profile's
  `state.db`.
- Filters by cwd when provided.
- Excludes sessions with no history.
- Uses a server-side page size of 50.
- Treats the cursor as the last returned session id.
- Unknown cursor returns an empty page.

Symphony does not need this for normal orchestration.

### `session/set_model`

Hermes Python method: `set_session_model(model_id, session_id)`

Behavior:

- Available because Hermes runs ACP with `use_unstable_protocol=True`.
- Supports `provider:model` ids from the model picker.
- Recreates the session's `AIAgent`.
- Preserves base URL and API mode only when the provider does not change.
- Persists the session.

Symphony should not call this during normal runs. The desired model should be
materialized before launch.

### `session/set_mode`

Hermes Python method: `set_session_mode(mode_id, session_id)`

Behavior:

- Persists the selected mode when it is one of `default`, `accept_edits`, or
  `dont_ask`.
- Unknown modes normalize to `default`.

Symphony should set a mode only if it intentionally wants to change Hermes edit
approval behavior for the session.

### `session/set_config_option`

Hermes Python method: `set_config_option(config_id, session_id, value)`

Behavior:

- Accepts config updates even though Hermes does not advertise config options.
- `edit_approval_policy` maps to the same underlying session mode.
- Unknown config ids are stored on the session state.
- Response contains an empty `configOptions` list.

Symphony should ignore this surface for now.

## Prompt Method

Hermes Python method: `prompt(prompt, session_id)`

Input:

- `prompt` is a list of ACP content blocks.
- Text blocks are extracted for display, slash commands, and prompt text.
- Image blocks are converted to OpenAI `image_url` parts.
- Resource and embedded resource blocks are read or inlined where supported.
- Audio content is imported in type hints but is not meaningfully converted by
  the observed implementation.

Behavior:

- Unknown session returns `stopReason = "refusal"`.
- Empty content returns `stopReason = "end_turn"`.
- Text-only recognized slash commands are handled locally and do not call the
  model.
- Unrecognized slash commands fall through as model prompts.
- If the same ACP session is already running, regular prompts are queued and an
  immediate assistant chunk reports the queue depth.
- A normal prompt runs `agent.run_conversation()` in a shared executor.
- Per-session locks serialize prompts within a session.
- Concurrent sessions may run through the shared executor.
- Final response is emitted as an assistant chunk only when streaming did not
  already emit it or when the response was transformed after streaming.
- The response includes `usage` when Hermes has token counts.

Recommended Symphony prompt shape:

```json
[
  {
    "type": "text",
    "text": "<full Symphony prompt>"
  }
]
```

Avoid ACP resource blocks in the first implementation unless Symphony has a
specific need. The current prompt builder already includes the relevant context
as text.

## Slash Commands

Hermes advertises commands through `available_commands_update`:

- `help`
- `model`
- `tools`
- `context`
- `reset`
- `compact`
- `steer`
- `queue`
- `version`

Symphony should treat command updates as runtime metadata. Normal orchestration
should not depend on slash commands.

## Models

Hermes returns ACP model state in `session/new`, `load`, `resume`, and `fork`:

- Current model id format is `provider:model` when a provider is known.
- Available models are generated from Hermes' curated provider model list.
- If the curated list cannot be built, Hermes returns a one-entry fallback for
  the current model.

The first Symphony ACP harness should treat model state as informational. Model
selection should be controlled by profile config before session creation.

## Modes and Edit Approval Policy

Hermes uses ACP session modes to represent edit approval policy because some
clients display config options in a way that hides the model picker. The modes
are:

- `default`: ask before edits.
- `accept_edits`: auto-allow workspace and temp-dir edits, still ask for
  sensitive paths.
- `dont_ask`: auto-allow file edits for this session except sensitive paths.

Mode-to-policy mapping:

- `default` -> `ask`
- `accept_edits` -> `workspace_session`
- `dont_ask` -> `session`

Sensitive paths always ask before edit auto-approval:

- any path containing `.git`
- any path containing `.ssh`
- `.env`
- `.env.local`
- `.env.production`
- `id_rsa`
- `id_ed25519`

For Symphony, the safest default is to leave Hermes in `default` and answer
permission requests through Symphony's own approval policy. If unattended
orchestration must be non-interactive, fail closed unless the run policy
explicitly permits auto-approval.

## MCP Servers

Hermes ACP accepts `mcpServers` on:

- `session/new`
- `session/load`
- `session/resume`
- `session/fork`

Server conversion:

- Stdio server: `{ command, args, env }`
- HTTP/SSE server: `{ url, headers }`

Hermes calls `register_mcp_servers(config_map)`, then refreshes the session
agent's tool surface by enabling `mcp-<server name>` toolsets. Registration
failures are logged and do not fail the session request.

Symphony recommendation:

- Pass Symphony role MCP servers through ACP `mcpServers`.
- Use absolute commands and args where possible.
- Do not rely on per-server cwd; Hermes' ACP conversion does not carry it.
- Keep one ACP process per Symphony lease. MCP tool registration is process
  global inside Hermes, so process isolation is the cleanest boundary.
- Do not mutate the cloned host profile's persistent `config.yaml` for
  Symphony's ephemeral handoff servers unless a future feature explicitly wants
  persistent MCP configuration.

## Hermes ACP Toolset

ACP sessions start with the `hermes-acp` toolset plus enabled MCP toolsets.

Observed built-in tools:

- Web: `web_search`, `web_extract`
- Terminal and process: `terminal`, `process`
- Files: `read_file`, `write_file`, `patch`, `search_files`
- Vision: `vision_analyze`
- Skills: `skills_list`, `skill_view`, `skill_manage`
- Browser: `browser_navigate`, `browser_snapshot`, `browser_click`,
  `browser_type`, `browser_scroll`, `browser_back`, `browser_press`,
  `browser_get_images`, `browser_vision`, `browser_console`, `browser_cdp`,
  `browser_dialog`
- Planning and memory: `todo`, `memory`
- History and execution: `session_search`, `execute_code`, `delegate_task`

Excluded from the ACP toolset compared with fuller Hermes surfaces:

- image generation
- text to speech
- clarify UI
- messaging tools
- cron tools
- Home Assistant tools

## Session Updates

Hermes sends ACP `session/update` notifications for:

- `agent_message_chunk`
- `agent_thought_chunk`
- `user_message_chunk`
- `tool_call`
- `tool_call_update`
- `plan`
- `available_commands_update`
- `usage_update`
- `session_info_update`

Recommended mapping to `AgentEvent`:

| ACP update | Symphony event |
| --- | --- |
| `agent_message_chunk` | `progress`, `activitySource: "delta"`; accumulate text for completion fallback |
| `agent_thought_chunk` | `progress`, `activitySource: "stream"` or diagnostic-only depending transcript policy |
| `user_message_chunk` | runtime transcript metadata; do not treat as new external user input |
| `tool_call` | `progress`, `activitySource: "tool"`, "Hermes tool <name> started" |
| `tool_call_update` pending | `progress`, `activitySource: "tool"`, include title or preview |
| `tool_call_update` completed | `progress`, `activitySource: "tool"`, "Hermes tool <name> completed" |
| `tool_call_update` failed | `progress` plus provider-limit detection if text indicates runtime limit |
| `plan` | optional `progress` or runtime transcript metadata |
| `available_commands_update` | runtime transcript metadata |
| `usage_update` | `tokens` only if it contains actual token counts; otherwise runtime metadata |
| `session_info_update` | runtime transcript metadata |

`usage_update` is a context-pressure indicator with `size` and `used`; it is not
the same as the final `PromptResponse.usage` token accounting. The prompt
response usage should be preferred for `tokens` events.

## Client Permission Method

Hermes ACP calls the client method `session/request_permission`. Symphony must
implement it.

### Dangerous Terminal Commands

Hermes builds an ACP `ToolCallUpdate` with:

- id `perm-check-N`
- kind `execute`
- status `pending`
- content showing the command
- raw input `{ command, description }`

Options:

- `allow_once`: Hermes result `once`
- `allow_session`: Hermes result `session`
- `allow_always`: Hermes result `always`
- `deny`: Hermes result `deny`
- `deny_always`: Hermes result `deny`, when the installed ACP SDK supports
  `reject_always`

Important divergence: `allow_session` uses ACP kind `allow_always` because ACP
has no session-scoped kind. Symphony must map by `optionId`, not by `kind`.

Timeout, request failure, missing response, or unknown option id all deny.

### File Edit Approvals

Hermes binds an ACP edit approval requester only during an ACP agent run. The
pre-execution guard is invoked from tool dispatch before supported file mutation
tools run.

Supported pre-approval proposals:

- `write_file`
- `patch` with mode `replace`

Other edit forms are not pre-approved by this helper. They may still appear as
tool display events after execution depending on Hermes internals.

Hermes builds an ACP `ToolCallUpdate` with:

- id `edit-approval-N`
- kind `edit`
- status `pending`
- diff content
- raw input `{ tool, arguments }`

Options:

- `allow_once`
- `deny`

Failure to build the diff or obtain approval denies and returns a JSON tool
error without modifying the file.

### Symphony Approval Policy

For the first ACP harness:

- Implement `session/request_permission` centrally in the ACP client.
- Map decisions by `optionId`.
- Deny by default when no policy or interactive approval path is available.
- If an operator approval service is available, block the ACP method response
  until the operator selects an allowed option or the request times out.
- Never convert `allow_session` to permanent approval; it is session-scoped
  Hermes semantics despite its ACP kind.
- Record permission requests and outcomes as runtime transcript events.

## Content Conversion Details

Hermes text/image/resource conversion is implementation-defined:

- Pure text remains a string and preserves legacy slash command behavior.
- Mixed content becomes OpenAI-style content parts.
- Image blocks become data URLs when image data is present.
- `file://` and local resource links are read from disk.
- Non-file resource URIs become a text note that Hermes cannot read them
  directly.
- Text resources are inlined up to 512 KiB.
- Image resources under 512 KiB are inlined as data URLs.
- Binary resources are omitted with a text note.
- Windows drive paths may be translated to WSL mount paths.

Symphony should avoid depending on resource behavior until it has tests against
the target host Hermes version.

## Persistence and Lease Lifecycle

Hermes ACP persists sessions to the selected profile's `state.db` with
`source="acp"`. Sessions can be restored across ACP process restarts by `load`,
`resume`, or a direct `get_session` lookup inside the session manager.

Symphony implications:

- Profile isolation is mandatory. Otherwise ACP history and model metadata can
  leak through the shared Hermes profile state.
- Reusable worker leases can keep a live ACP process and session id in the same
  way the current harness keeps a gateway session.
- Reviewer, planner, and one-shot runs should use fresh profiles/sessions
  according to the existing lifecycle policy.
- For deterministic first implementation, call `session/new` per lease and do
  not call `session/list`, `session/load`, or `session/resume`.
- Cleanup should use `hermes profile delete <name> --yes` for fresh profiles
  according to Symphony's retention rules.

## Provider Limits

Hermes' ACP adapter does not expose a dedicated provider-limit event. The current
TUI harness detects limits from structured gateway events and error payloads.

ACP harness strategy:

- Reuse the existing provider-limit parsing helpers where possible.
- Inspect prompt response errors, process exit diagnostics, assistant text, and
  failed `tool_call_update` text for known provider-limit markers.
- Emit `provider_limit` only when the signal is credible and scoped to the
  expected Hermes provider/model for the selected profile.
- Preserve stderr log tail in `run_diagnostic` events for debugging.

## Proposed Symphony Architecture

Add a new harness id:

```text
hermes_acp
```

Keep the existing id:

```text
hermes
```

Recommended files:

- `hermes/src/ACPFacade.ts`: stdio JSON-RPC process client, message router,
  request/notification helpers, stderr log tail, process lifecycle.
- `hermes/src/HermesAcpHarness.ts`: `AgentHarness` implementation.
- `hermes/src/HermesCliProfileLease.ts` or similar helper: host Hermes profile
  create/delete, source-profile selection, lease naming, cleanup, and process
  environment.
- `tests/hermes-acp-facade.test.ts`: protocol client unit tests with a fake ACP
  subprocess or in-memory transport.
- `tests/hermes-acp-harness.test.ts`: event mapping, cancellation, auth, MCP,
  and permission handling tests.
- Optional live probe in `src/core/harness/McpToolExposureProbe.ts` after the
  unit-level harness is stable.

Capabilities:

```ts
readonly id = "hermes_acp";
readonly capabilities = {
  continuation: true,
  mcpHandoff: true,
  runStatus: false,
  liveDiagnostics: true,
};
```

The harness should support `stop(runId)` by sending `session/cancel` for the
active ACP session and marking the run as cancellation-requested.

## ACP Facade Requirements

The facade should:

- Spawn the Hermes ACP child process.
- Parse newline-delimited JSON-RPC messages from stdout.
- Write newline-delimited JSON-RPC messages to stdin.
- Route responses by id.
- Route Hermes notifications by method, especially `session/update`.
- Route Hermes requests by method, especially `session/request_permission`.
- Enforce request timeouts.
- Expose `kill(reason)`, `getLogTail(limit)`, and process exit events.
- Reject all pending requests on process exit.
- Validate enough message shape to avoid crashing on unknown future ACP fields.

The facade should not be tied to Hermes-specific event mapping. Keep transport
generic enough that tests can feed raw ACP messages and assert client behavior.

## Harness Run Sequence

Per `run(ctx, prompt)`:

1. `writeInitialHandoffMcpContexts(ctx)`.
2. Get or create an ACP lease using a Hermes profile name derived from
   workspace, role, issue, phase, and reuse policy.
3. If the profile does not exist, create it with `hermes profile create <name>
   --clone --clone-from <source-profile> --no-alias`.
4. Start `hermes -p <name> acp`.
5. Ensure the ACP process is initialized and authenticated.
6. Convert Symphony role MCP servers to ACP `mcpServers`.
7. Send `session/new` if the lease has no ACP session id.
8. Build Symphony session id as:

   ```text
   <profileKey>:<acpSessionId>:<runId>
   ```

9. `writeActiveHandoffMcpContexts(ctx, { activeRunId, sessionId })`.
10. Yield `session_started`.
11. Send `session/prompt`.
12. Yield mapped progress events until the prompt response arrives.
13. On `stopReason`:
    - `end_turn`: yield `completed` with accumulated final text if useful.
    - `cancelled`: yield `cancelled`.
    - `refusal`: yield `failed`.
    - unknown: yield `failed` plus diagnostic.
14. Dispose non-reusable leases and cleanup profiles with `hermes profile delete
    <name> --yes` according to Symphony retention policy.

## MCP Server Conversion

Convert Symphony MCP server specs to ACP stdio servers:

```json
{
  "name": "<server key>",
  "type": "stdio",
  "command": "<absolute command or node executable>",
  "args": ["..."],
  "env": [
    { "name": "KEY", "value": "VALUE" }
  ]
}
```

If Symphony later supports remote MCP handoff servers, map them to ACP HTTP/SSE
servers:

```json
{
  "name": "<server key>",
  "type": "http",
  "url": "https://...",
  "headers": [
    { "name": "Authorization", "value": "Bearer ..." }
  ]
}
```

Hermes ignores per-server cwd, so commands must be robust when launched from the
Hermes process cwd. Prefer absolute script paths and explicit env.

## Deviations From Strict ACP

Observed implementation differences and compatibility notes:

- Hermes enables unstable ACP protocol methods.
- `session/set_model` is unstable and should be treated as optional.
- `session/set_config_option` accepts arbitrary updates even though no config
  options are advertised.
- Edit approval is represented as session modes instead of advertised config
  options.
- `allow_session` permission uses ACP kind `allow_always`; option ids carry the
  real semantics.
- `session/resume` creates a new session if the requested session is missing.
- `session/fork` returns an empty session id when the original is missing.
- `session/load` returns `null` when the session is missing.
- History replay occurs before `load` and `resume` responses.
- Audio content is not actually converted for model input.
- Edit pre-approval covers `write_file` and `patch` replace proposals only.
- ACP-provided MCP registration logs and continues on failure.
- Sessions persist in the selected profile's `state.db`, so process lifetime is
  not the only session lifetime.
- Hermes has no advertised `session/close` support in the observed adapter.

## Validation Plan

Unit tests:

- ACP facade parses responses, notifications, and client method requests.
- Profile lease helper builds `hermes profile create`, `hermes -p <name> acp`,
  and `hermes profile delete` commands without setting `HERMES_AUTH_HOME`.
- Initialize/auth selection rejects `hermes-setup`-only unattended runs.
- `session/new` sends cwd and MCP servers in the expected shape.
- `session/update` variants map to `AgentEvent`.
- Prompt response stop reasons map to `completed`, `cancelled`, and `failed`.
- `session/request_permission` maps `optionId` correctly and denies by default.
- Process exit rejects pending prompt and emits diagnostics with stderr tail.
- Abort signal sends `session/cancel`.

Integration tests with a fake ACP server:

- Full run with streamed assistant chunks and final prompt response.
- Full run with tool call start/update events.
- Permission request during a prompt.
- Cancellation while a prompt is pending.
- MCP server payload round trip.

Live/manual smoke test after unit coverage:

1. Verify the host Hermes installation:

   ```text
   hermes --version
   hermes acp --check
   ```

2. Confirm the source profile has the desired provider/model and auth:

   ```text
   hermes -p <source-profile> acp --check
   ```

3. Let Symphony create a cloned disposable profile, or create one manually:

   ```text
   hermes profile create <name> --clone --clone-from <source-profile>
   hermes -p <name> acp --check
   ```

4. Run `agent.harness = "hermes_acp"` against a small local issue.
5. Verify:
   - session starts
   - Symphony handoff MCP tools are visible to Hermes
   - terminal/edit permission requests are denied or approved according to
     policy
   - cancellation returns `cancelled`
   - profile cleanup follows retention settings
   - no state is written to the source profile

## Open Questions

- The ACP docs specify newline-delimited JSON-RPC over stdio. The facade spike
  should still confirm the installed `agent-client-protocol==0.9.0` SDK follows
  that shape in practice and does not add buffering or startup behavior the
  tests need to model.
- Decide how Symphony selects the source Hermes profile: config value, active
  profile by default, role-specific mapping, or an explicit CLI flag.
- Decide whether Symphony should expose any interactive approval path for ACP or
  run with a purely policy-driven fail-closed response.
- Decide whether `hermes_acp` should share the existing `hermes.*` config keys,
  add a host-Hermes section, or introduce ACP-specific keys such as
  `hermes.acp.source_profile` and `hermes.acp.binary`.
- Add doctor checks for host Hermes profile and ACP readiness.

## Recommended First Implementation Slice

1. Build `ACPFacade` with fake-server tests.
2. Build `HermesAcpHarness` using fresh sessions only.
3. Add host Hermes profile lease management using `hermes profile create
   --clone`, `hermes -p <name> acp`, and `hermes profile delete --yes`.
4. Pass Symphony MCP handoff servers through ACP `mcpServers`.
5. Implement `session/request_permission` with fail-closed policy.
6. Register harness id `hermes_acp`.
7. Add unit tests for event mapping, auth, cancellation, MCP payloads, and
   process-exit diagnostics.
8. Add a live ACP doctor check and MCP exposure probe after the harness passes
   fake-server tests.
