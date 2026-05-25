export const GENERAL_REVIEW_SCENARIO_MATRIX = [
  "Happy path and negative/error paths.",
  "Boundary and integration behavior, not only isolated unit behavior.",
  "Persistence/durability, externally visible side effects, and recovery after interruption.",
  "Authorization/security variants, including unset, empty, invalid, and valid credentials when applicable.",
  "Idempotency/replay and already-terminal or repeated-operation behavior.",
  "Whether required side effects are actually processed, not merely planned or enqueued.",
];

export const DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE = [
  "Before any fail verdict, perform a bounded sibling-risk sweep. Do not pass by checking only the happy path, and do not stop at the first valid blocker.",
  "During the sweep, inspect related acceptance criteria, touched files, shared invariants, side-effect paths, and the general scenario matrix. Include every known blocking gap discovered from the current evidence in one well-specified requested-change set.",
  "For each fail finding, include the required behavior, concrete evidence, expected validation, sibling scenarios checked, and any related scenarios intentionally left unverified. Distinguish implementation defects, missing tests, ambiguous contracts, and out-of-scope follow-ups.",
].join("\n\n");

export const DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE = [
  "Review-cycle hardening:",
  "",
  "When fixing review feedback, treat reviewer findings as the minimum required scope and address the underlying invariant, contract, or side-effect path behind the finding, not only the literal failing case.",
  "",
  "Before reporting completion, build a small scenario matrix for the touched behavior and use it to guide implementation and validation. Either fix adjacent cases that share the same invariant or call out why they are unrelated or out of scope.",
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
