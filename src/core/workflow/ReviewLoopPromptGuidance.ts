export const GENERAL_REVIEW_SCENARIO_MATRIX = [
  "Happy path and negative/error paths.",
  "Boundary and integration behavior, not only isolated unit behavior.",
  "Persistence/durability, externally visible side effects, and recovery after interruption.",
  "Authorization/security variants, including unset, empty, invalid, and valid credentials when applicable.",
  "Idempotency/replay and already-terminal or repeated-operation behavior.",
  "Whether required side effects are actually processed, not merely planned or enqueued.",
];

export const DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE = [
  "Perform a thorough analysis, but keep gate authority narrow. Inspect related acceptance criteria, touched files, shared invariants, side-effect paths, and the general scenario matrix to discover risk; do not treat every valid observation as a fail condition.",
  "Before any fail verdict, classify every concern as either a gate finding or a discovery finding. Gate findings must be contract-entitled by the issue as written: cite the requirement or acceptance/validation anchor, the entitled scenario, concrete failure evidence, current-issue ownership, and bounded repair.",
  "Use a blocked verdict instead of a fail verdict when required validation, tooling, credentials, or service-owned evidence is unavailable to worker/reviewer roles and the bounded repair is not worker-owned.",
  "Use discovery findings for inferred scope, adjacent sibling scenarios, hidden matrix axes, sibling issue scope, future hardening, or out-of-scope concerns. Discovery findings are valuable backlog/decomposition evidence, but they must not gate the worker unless they also satisfy the gate-finding entitlement rubric.",
  "A pass verdict is allowed when all written contract requirements are satisfied, even if important discovery findings remain. If satisfying a concern requires broad new scenario expansion or multiple child workstreams, report planner_decomposition discovery instead of forcing another repair loop.",
  "When the Issue Contract explicitly declares accepted expected-red artifact delivery, judge the test artifact and its structured failure evidence rather than the intentionally absent production implementation. A correct artifact passes with non-merge COMMENT feedback; do not block it merely because its implementation successor has not run.",
  "If the issue is missing `Contract Checklist` or `Validation Requirements`, describe the missing issue contract as an authoring/decomposition signal. Fail only for missed behavior or validation that is directly entitled by the current issue contract.",
].join("\n\n");

export const DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE = [
  "Review-cycle hardening:",
  "",
  "When fixing review feedback, treat reviewer gate findings as the required repair scope. Address the underlying contract invariant behind each gate finding, not only the literal failing case.",
  "",
  "Before reporting completion, build a small scenario matrix for the touched gate behavior and use it to guide implementation and validation. Do not repair reviewer discovery findings unless the current directive explicitly makes them worker-owned.",
  "If the issue lacks `Contract Checklist` or `Validation Requirements`, derive a conservative checklist from the acceptance criteria, touched surfaces, repository invariants, and the general scenario matrix. Mention the issue-authoring gap in the completion report without reducing validation scope.",
  "Honor structured TDD context. Accepted expected-red artifact work reports its intended nonzero test result through artifactEvidence without implementing successor scope. A worker given a Dependency Artifact Checkpoint must reproduce red, implement the owned behavior, rerun green, and submit dependencyArtifactResult.",
  "",
  "General software change matrix:",
  ...GENERAL_REVIEW_SCENARIO_MATRIX.map((item) => `- ${item}`),
].join("\n");

export function formatGeneralScenarioMatrix(title = "General software review matrix:"): string {
  return [title, ...GENERAL_REVIEW_SCENARIO_MATRIX.map((item) => `- ${item}`)].join("\n");
}

export function formatPromptExtensions(title: string, extensions: readonly string[]): string | null {
  if (extensions.length === 0) return null;
  return [title, ...extensions.map((item) => `- ${item}`)].join("\n");
}
