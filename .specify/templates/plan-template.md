# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]

**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]

**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]

**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]

**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]

**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]

**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]

**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]

**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluate each Symphony constitution principle for this feature. Mark every gate
PASS or FAIL and cite the plan evidence that supports the decision.

- **I. Service-Owned Authority Boundaries**: Identify every lifecycle,
  tracker, GitHub, runtime, or external write path touched. Confirm whether the
  Symphony service, an MCP service, an operator, a worker, or a reviewer owns
  the action, and prove workers/reviewers cannot bypass service-owned paths.
- **II. Least-Privilege Credentials And Secret Hygiene**: List credential
  capabilities, environment variables, profile changes, prompt/log/transcript
  exposure risks, and redaction behavior. Ambiguous credential or upstream
  access paths must fail closed or be documented as violations.
- **III. Testable Contracts Before Implementation**: Confirm prioritized user
  stories, acceptance scenarios, measurable success criteria, touched
  contracts, issue-contract source obligations, and validation scope are
  present before implementation tasks are generated. For any issue that will be
  generated, promoted, or delegated, confirm the issue description includes a
  fenced `json` contract with `schemaVersion`, `contractVersion`, and a
  non-empty `requirements` array of stable unique IDs and requirement text.
- **IV. Durable Audit, Replay, And Idempotence**: For run records, transcripts,
  projections, tracker writeback, external effects, retries, restarts, and
  policy decisions, state how decisions are recorded and how replay or
  idempotence is validated.
- **V. Scoped Change Ownership And Protected Surfaces**: Identify protected
  paths, vendored source, generated templates, workflow safety docs, and module
  ownership boundaries. Confirm no vendored upstream source is modified unless
  the exception is explicitly ratified.

Pre-design gate result: [PASS/FAIL with reasons]

Post-design gate result: [PASS/FAIL with reasons]

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because | Risk | Required Validation |
|-----------|------------|--------------------------------------|------|---------------------|
| [e.g., worker owns external write path] | [current need] | [why service-owned path cannot work] | [risk] | [validation] |
| [e.g., vendored upstream source change] | [specific blocker] | [why generated profile/config cannot work] | [risk] | [validation] |
