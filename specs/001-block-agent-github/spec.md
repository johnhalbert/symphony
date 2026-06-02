# Feature Specification: Block Worker and Reviewer Upstream GitHub Commands

**Feature Branch**: `main`
**Created**: 2026-06-01
**Status**: Draft
**Input**: User description: "ENG-243: disallow worker and reviewer agents from calling upstream GitHub commands while preserving local inspection and service-owned workflow actions."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prevent agent-owned upstream GitHub activity (Priority: P1)

As a Symphony operator, I want worker and reviewer agents to be unable to contact or mutate the upstream GitHub repository from their own command surfaces, so that delegated work does not trigger desktop credential prompts, SSH key confirmations, OAuth prompts, remote branch mutations, or untracked GitHub-side effects.

**Why this priority**: This is the core safety boundary for ENG-243. Without it, agents can escape the orchestrated workflow and perform upstream activity outside the service-owned publication and review controls.

**Independent Test**: Start a worker or reviewer run and attempt representative upstream GitHub operations through every command-capable surface available to that role. Each attempt is denied before GitHub contact, credential prompt, or remote mutation occurs.

**Acceptance Scenarios**:

1. **Given** a worker or reviewer can run terminal commands, **When** it attempts to push, pull, fetch, clone, create a PR, call GitHub CLI commands, call GitHub web/API endpoints, or open SSH/HTTPS GitHub transports, **Then** the attempt is denied before any upstream contact occurs.
2. **Given** an upstream command is disguised with an absolute executable path, shell wrapper, nested shell, interpreter subprocess, environment variable assignment, alias, or script file, **When** the agent attempts the command, **Then** the policy still classifies and denies the upstream activity.
3. **Given** a denial occurs, **When** the agent receives feedback, **Then** the message explains that worker/reviewer upstream GitHub activity is disallowed and identifies the service-owned workflow path to use instead.

---

### User Story 2 - Preserve safe local repository inspection (Priority: P1)

As a worker or reviewer agent, I need to inspect local repository state without upstream access, so that I can understand changes, diagnose failures, and prepare review responses while staying inside the workflow boundary.

**Why this priority**: The policy must not make normal local development impossible. Blocking all Git use would protect the upstream but degrade agent quality and increase stalled tickets.

**Independent Test**: In worker and reviewer sessions, run allowed local inspection commands against a repository with no network access. The commands complete successfully and do not require credentials or upstream access.

**Acceptance Scenarios**:

1. **Given** a worker or reviewer needs local state, **When** it runs local-only inspection such as status, diff, log, show, branch listing, blame, or file history queries, **Then** the command is allowed when it cannot contact GitHub or execute external helper programs.
2. **Given** an otherwise local inspection command is configured to launch a helper, pager, diff tool, hook, filter, credential helper, signing program, or transport helper, **When** the command is attempted, **Then** the unsafe helper path is denied or neutralized before it can execute.
3. **Given** a repository already contains unsafe Git configuration, **When** the agent runs a local inspection command, **Then** the run fails closed instead of trusting the persisted configuration.

---

### User Story 3 - Keep service-owned GitHub workflow actions separate (Priority: P1)

As a Symphony operator, I want service-owned GitHub publication, review feedback, mergeability checks, CI checks, and writebacks to continue working through controlled service channels, so that blocking worker/reviewer commands does not break the orchestrated workflow.

**Why this priority**: The desired boundary is role-specific. The service still owns publication and external writeback; agents should not bypass that service boundary.

**Independent Test**: Execute a service-owned publication or writeback flow while the worker/reviewer command policy is active. The service-owned action succeeds or fails according to its own credentials and validation rules, not because the agent command policy intercepted it.

**Acceptance Scenarios**:

1. **Given** the service is publishing or updating GitHub state through its controlled workflow, **When** worker/reviewer command restrictions are enabled, **Then** the service-owned action is not blocked by the worker/reviewer policy.
2. **Given** a worker or reviewer attempts to perform the same GitHub action directly, **When** the command is submitted through an agent command surface, **Then** it is denied and the agent is directed back to the service-owned workflow.
3. **Given** a service-owned GitHub writeback fails, **When** the failure is reported, **Then** the failure is captured as a service workflow problem rather than as permission for an agent to retry the writeback directly.

---

### User Story 4 - Provide auditable policy evidence (Priority: P2)

As an operator reviewing agent performance, I want denied command attempts and allowed local inspection decisions to be observable in the run record, so that future revision reasons can distinguish implementation defects, process gates, and policy enforcement events.

**Why this priority**: ENG-243 is part of a broader workflow reliability effort. Operators need enough evidence to know whether a revision was caused by code quality, policy behavior, service writeback, or agent misuse.

**Independent Test**: Run policy allow and deny scenarios, then inspect the recorded run events. Each decision includes the role, command surface, normalized command class, allow/deny result, redacted reason, and whether any upstream contact was attempted.

**Acceptance Scenarios**:

1. **Given** an agent command is denied, **When** the run is inspected later, **Then** the record identifies the policy reason without exposing secrets or credential material.
2. **Given** a local inspection command is allowed, **When** the run is inspected later, **Then** the record shows it was classified as local-only inspection.
3. **Given** a denial happens during review, **When** the issue is updated, **Then** the operator can tell whether the issue needs code changes, service repair, or workflow follow-up.

### Edge Cases

- A command uses an absolute path to a Git, GitHub, SSH, shell, or interpreter executable.
- A command uses inline environment assignments before the executable.
- A command changes environment variables that affect Git behavior, credentials, transport, pagers, hooks, filters, diff helpers, signing programs, or command lookup.
- A command uses per-command Git configuration to define aliases, external helpers, credential helpers, hooks, filters, pagers, signing programs, or transport helpers.
- Persisted repository or user Git configuration contains command-executing values before the agent run begins.
- A local inspection command would normally be safe, but Git configuration would cause helper execution.
- A command is hidden behind a shell script, package script, interpreter, nested shell, or tool wrapper.
- Windows and POSIX path formats are both used for executables and script paths.
- GitHub contact is attempted through Git, GitHub CLI, SSH, HTTPS, API clients, package scripts, or generic network clients.
- Credential material is present in the environment, but the worker/reviewer policy must not expose or use it for upstream GitHub access.
- The service performs a GitHub workflow action while worker/reviewer restrictions are active.
- A denied command happens during a run that later restarts or replays from persisted events.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST prevent worker and reviewer roles from initiating upstream GitHub contact or mutation through any role-accessible command surface.
- **FR-002**: The system MUST deny direct GitHub operations including push, pull, fetch, clone, remote update, PR creation or mutation, GitHub CLI operations, SSH GitHub transport, HTTPS GitHub transport, and GitHub web/API calls.
- **FR-003**: The system MUST classify and deny indirect GitHub operations when they are attempted through shell wrappers, nested shells, interpreter subprocesses, package scripts, absolute executable paths, aliases, or script files.
- **FR-004**: The system MUST preserve safe local repository inspection for worker and reviewer roles when the command cannot contact GitHub and cannot execute external helper programs.
- **FR-005**: The system MUST fail closed when local repository inspection depends on unsafe Git configuration, unsafe environment variables, or persisted command-executing configuration.
- **FR-006**: The system MUST prevent command-executing Git configuration from bypassing policy, including aliases, pagers, external diff tools, credential helpers, hooks, filters, signing programs, filesystem monitors, transport helpers, and other helper-launching settings.
- **FR-007**: The system MUST prevent inline and inherited environment variables from bypassing policy when they affect Git behavior, credentials, command lookup, helper execution, shell behavior, or transport behavior.
- **FR-008**: The system MUST apply the worker/reviewer restriction consistently across terminal-like tools, shell commands, command reducers, delegated research commands, and any other command-capable surface available to those roles.
- **FR-009**: The system MUST deny unsafe commands before upstream contact, credential prompt, helper execution, or remote mutation can occur.
- **FR-010**: The system MUST keep service-owned GitHub workflow actions outside the worker/reviewer command policy, while preserving separate validation and audit for those service-owned actions.
- **FR-011**: The system MUST provide a redacted, actionable denial reason that identifies the blocked command class and the allowed service-owned path for GitHub workflow actions.
- **FR-012**: The system MUST record enough policy decision detail to support later audit, replay, and revision-reason analysis without storing secrets or credential values.
- **FR-013**: The system MUST maintain policy behavior after run restart or replay from persisted events.
- **FR-014**: The system MUST include validation coverage for allowed local inspection, blocked upstream commands, disguised bypass attempts, unsafe configuration, helper side effects, service-owned workflow separation, and replay/restart behavior.
- **FR-015**: The system MUST treat unknown or ambiguous command forms as denied when they could contact GitHub, execute helper programs, or use credentials.

### Key Entities

- **Agent Run**: A worker or reviewer execution session subject to role-specific command restrictions.
- **Command Attempt**: A requested command invocation, including its role, command surface, normalized command class, inherited environment, inline environment, working directory, and safety decision.
- **Policy Decision**: The allow or deny outcome for a command attempt, including a redacted reason and evidence needed for audit.
- **Allowed Local Inspection**: A command class that inspects local repository state without contacting GitHub, using credentials, mutating remotes, or executing external helper programs.
- **Denied Upstream Operation**: A command class that contacts or mutates GitHub, uses GitHub credentials, invokes GitHub transports, or attempts to bypass the service-owned workflow.
- **Unsafe Helper Configuration**: Git configuration or environment state that can launch external programs or credential flows during an otherwise local command.
- **Service-Owned GitHub Action**: A publication, review feedback, mergeability, CI, or writeback action performed by Symphony service workflow rather than by a worker or reviewer command surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the policy validation suite, 100% of defined upstream GitHub command attempts are denied before any GitHub contact, credential prompt, helper execution, or remote mutation.
- **SC-002**: In the policy validation suite, 100% of defined disguised bypass attempts are denied, including absolute paths, inline environment assignments, nested shells, aliases, script files, interpreter subprocesses, unsafe Git configuration, and unsafe environment variables.
- **SC-003**: In the policy validation suite, 100% of defined safe local inspection scenarios remain usable for worker and reviewer roles.
- **SC-004**: In dogfood runs after rollout, worker and reviewer sessions produce zero desktop OAuth prompts, SSH key confirmation prompts, or GitHub credential prompts caused by agent-owned command attempts.
- **SC-005**: In service workflow validation, service-owned GitHub publication and writeback actions continue to operate independently of worker/reviewer command restrictions.
- **SC-006**: At least 95% of command policy denial records contain a redacted reason that lets an operator distinguish blocked upstream activity from implementation defects and service workflow failures.
- **SC-007**: Replay or restart of a run preserves the same policy classification and audit outcome for previously recorded command attempts.

## Assumptions

- ENG-243 is scoped to worker and reviewer command surfaces. It does not authorize agents to repair GitHub publication, approval, merge, or writeback failures directly.
- Service-owned GitHub actions remain part of the orchestrated workflow and continue to use their existing controlled credential path.
- Safe local inspection means local-only repository state inspection with no upstream contact, credential use, remote mutation, or external helper execution.
- The policy should prefer denying ambiguous commands over allowing a command that might contact GitHub or use credentials.
- This feature does not introduce a new merge-conflict or CI-repair agent, nor does it add a queued GitHub writeback system.
- This feature should support later telemetry improvements, but the detailed revision-reason taxonomy is handled by the separate telemetry work item.
- Vendored Hermes source changes under `hermes/upstream-src/**` are out of scope and are a hard blocker for ENG-243. Enforcement must be implemented through Symphony-owned code, Symphony-managed Hermes profiles/templates, hooks/plugins, MCP/service boundaries, or configuration generated by Symphony.
