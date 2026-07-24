import { createHash } from "node:crypto";
import type { ServiceConfig } from "./config/Config.js";
import type { Issue } from "./types.js";

const ISSUE_CONTRACT_HEADING = "Issue Contract";
const TOUCHED_SURFACES_HEADING = "Touched Surfaces";
const CONTRACT_CHECKLIST_HEADING = "Contract Checklist";
const VALIDATION_REQUIREMENTS_HEADING = "Validation Requirements";
const PROMOTION_READINESS_HEADING = "Promotion Readiness";
const STABLE_REQUIREMENT_ID_PATTERN = /^[a-z][a-z0-9._:-]*$/i;
const GENERIC_SINGLE_REQUIREMENTS = new Set([
  "complete the documented work",
  "do the work",
  "implement this",
  "implement the work",
  "done",
  "finish the task",
  "complete this task",
]);
const PLACEHOLDER_CHECKLIST_VALUES = new Set([
  "",
  "covered",
  "done",
  "yes",
  "ok",
  "okay",
  "handled",
  "implemented",
  "n/a",
  "na",
  "none",
  "not applicable",
  "todo",
  "tbd",
  "unknown",
  "same as above",
]);
const GENERIC_VALIDATION_VALUES = new Set([
  "add tests",
  "run tests",
  "run the tests",
  "run relevant tests",
  "run unit tests",
  "run integration tests",
  "run the narrow test",
  "focused validation covers the acceptance criteria",
]);
const BLOCKER_PLACEHOLDER_VALUES = new Set([
  'if any protected path is listed above, keep this issue manual-only with "ready for `dogfood-ready`: no" and explain the operator blocker here',
  "n/a",
  "na",
  "none",
  "nil",
  "no blocker",
  "no remaining blocker",
  "not applicable",
  "nothing",
  "tbd",
  "todo",
  "unknown",
]);
const MANUAL_BLOCKER_KEYWORDS =
  /\b(manual(?:-only)?|operator|human|protected|owner-authored|owner authored|follow-up pr|separate pr)\b/i;

export const AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS = [
  "Problem / Goal",
  ISSUE_CONTRACT_HEADING,
  TOUCHED_SURFACES_HEADING,
  "Acceptance Criteria",
  "Contract Checklist",
  "Validation Requirements",
  "Out Of Scope",
  PROMOTION_READINESS_HEADING,
] as const;

export interface IssueContractAnalysis {
  missingSections: string[];
  issueContractErrors: string[];
  underSpecifiedContractErrors: string[];
  protectedSurfaceMatches: string[];
  readyForDogfoodReady: boolean | null;
  remainingBlocker: string | null;
}

export interface IssueContractLintResult extends IssueContractAnalysis {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  applicable: boolean;
}

export interface IssueContractPromptSummary extends IssueContractAnalysis {
  issueContractJson: string | null;
  contractChecklist: string | null;
  validationRequirements: string | null;
}

export interface IssueContractRequirement {
  id: string;
  requirement: string;
  proofHint?: string;
  [key: string]: unknown;
}

export type IssueContractDelivery =
  | { mode: "merge" }
  | { mode: "accepted_artifact"; artifact: "expected_red_tests" };

export const CURRENT_ISSUE_CONTRACT_SCHEMA_VERSION = 2;

export type IssueContractSuccessionPurpose = "expected_red_implementation";

export interface IssueContractSuccessionEndpoint {
  issue: string;
}

export type IssueContractSuccession =
  | {
      id: string;
      purpose: IssueContractSuccessionPurpose;
      successor: IssueContractSuccessionEndpoint;
      succeeds?: never;
    }
  | {
      id: string;
      purpose: IssueContractSuccessionPurpose;
      succeeds: IssueContractSuccessionEndpoint;
      successor?: never;
    };

export interface IssueContractRelationships {
  blocks: string[];
  blockedBy: string[];
  succession?: IssueContractSuccession;
}

export interface ParsedIssueContract {
  schemaVersion: number;
  contractVersion: string;
  requirements: IssueContractRequirement[];
  delivery: IssueContractDelivery;
  /** Absent only for legacy schema-v1 contracts. */
  relationships?: IssueContractRelationships;
  [key: string]: unknown;
}

export interface ParsedIssueContractSnapshot extends ParsedIssueContract {
  document: Record<string, unknown>;
  canonicalJson: string;
  fingerprint: string;
}

export type ParsedIssueContractResult =
  | {
      valid: true;
      contract: ParsedIssueContract;
      canonicalJson: string;
      fingerprint: string;
    }
  | {
      valid: false;
      errors: string[];
    };

export function lintAgentEligibleIssueContract(issue: Issue, config: ServiceConfig): IssueContractLintResult {
  const applicable = requiresAgentEligibleIssueContract(issue, config);
  const baseAnalysis = applicable
    ? analyzeIssueContractDescription(issue.description, config.agent.protectedPaths)
    : emptyIssueContractAnalysis();
  const relationshipErrors =
    applicable && baseAnalysis.issueContractErrors.length === 0
      ? validateIssueContractRelationshipsAgainstIssue(issue)
      : [];
  const analysis = {
    ...baseAnalysis,
    issueContractErrors: [...baseAnalysis.issueContractErrors, ...relationshipErrors],
  };
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    },
    applicable,
    ...analysis,
  };
}

export function lintAgentEligibleIssueContracts(issues: readonly Issue[], config: ServiceConfig): IssueContractLintResult[] {
  return issues.map((issue) => lintAgentEligibleIssueContract(issue, config)).filter((result) => result.applicable);
}

export function analyzeIssueContractDescription(
  description: string | null | undefined,
  protectedPaths: readonly string[],
): IssueContractAnalysis {
  const content = description ?? "";
  const sections = markdownSections(content);
  const issueContract = sections.get(normalizeHeading(ISSUE_CONTRACT_HEADING));
  const touchedSurfaces = sections.get(normalizeHeading(TOUCHED_SURFACES_HEADING)) ?? "";
  const contractChecklist = sections.get(normalizeHeading(CONTRACT_CHECKLIST_HEADING));
  const validationRequirements = sections.get(normalizeHeading(VALIDATION_REQUIREMENTS_HEADING));
  const promotionReadiness = sections.get(normalizeHeading(PROMOTION_READINESS_HEADING)) ?? "";
  const duplicateContractErrors =
    markdownHeadingOccurrenceCount(content, ISSUE_CONTRACT_HEADING) > 1
      ? ["Issue description must contain exactly one `Issue Contract` section"]
      : [];
  return {
    missingSections: missingRequiredIssueContractSections(content),
    issueContractErrors: [
      ...duplicateContractErrors,
      ...validateIssueContractSection(issueContract),
    ],
    underSpecifiedContractErrors: [
      ...validateIssueContractSpecificity(issueContract),
      ...validateContractChecklistSpecificity(contractChecklist),
      ...validateValidationRequirementsSpecificity(validationRequirements),
    ],
    protectedSurfaceMatches: findProtectedSurfaceMatches(touchedSurfaces, protectedPaths),
    readyForDogfoodReady: parseReadyForDogfoodReady(promotionReadiness),
    remainingBlocker: parseRemainingBlocker(promotionReadiness),
  };
}

export function summarizeIssueContractForPrompt(
  description: string | null | undefined,
  protectedPaths: readonly string[] = [],
): IssueContractPromptSummary {
  const content = description ?? "";
  const sections = markdownSections(content);
  const issueContract = sections.get(normalizeHeading(ISSUE_CONTRACT_HEADING));
  const contractChecklist = sections.get(normalizeHeading(CONTRACT_CHECKLIST_HEADING)) ?? null;
  const validationRequirements = sections.get(normalizeHeading(VALIDATION_REQUIREMENTS_HEADING)) ?? null;
  return {
    ...analyzeIssueContractDescription(description, protectedPaths),
    issueContractJson: issueContract === undefined ? null : extractFencedJsonBlock(issueContract),
    contractChecklist,
    validationRequirements,
  };
}

export function replaceIssueContractJson(
  description: string,
  issueContractJson: string,
): string {
  if (markdownHeadingOccurrenceCount(description, ISSUE_CONTRACT_HEADING) !== 1) {
    throw new Error(
      "Issue description must contain exactly one `Issue Contract` section",
    );
  }
  const lines = description.split(/\r?\n/);
  let inIssueContract = false;
  let fenceStart = -1;
  let fenceEnd = -1;
  let fenceMarker = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      inIssueContract =
        normalizeHeading(heading[1] ?? "") ===
        normalizeHeading(ISSUE_CONTRACT_HEADING);
      continue;
    }
    if (!inIssueContract) continue;
    if (fenceStart === -1) {
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*json\s*$/i);
      if (!fence) continue;
      fenceStart = index;
      fenceMarker = fence[1] ?? "```";
      continue;
    }
    const closing = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
    const closingMarker = closing?.[1];
    if (
      closingMarker !== undefined &&
      closingMarker[0] === fenceMarker[0] &&
      closingMarker.length >= fenceMarker.length
    ) {
      fenceEnd = index;
      break;
    }
  }
  if (fenceStart === -1 || fenceEnd === -1) {
    throw new Error("Issue Contract must contain a fenced `json` block");
  }
  return [
    ...lines.slice(0, fenceStart + 1),
    issueContractJson.trim(),
    ...lines.slice(fenceEnd),
  ].join("\n");
}

export function parseIssueContractFromDescription(
  description: string | null | undefined,
): ParsedIssueContractSnapshot | null {
  const result = parseIssueContract(description);
  if (!result.valid) return null;
  return {
    ...result.contract,
    document: result.contract,
    canonicalJson: result.canonicalJson,
    fingerprint: result.fingerprint,
  };
}

export function parseIssueContract(description: string | null | undefined): ParsedIssueContractResult {
  const content = description ?? "";
  if (markdownHeadingOccurrenceCount(content, ISSUE_CONTRACT_HEADING) > 1) {
    return {
      valid: false,
      errors: [
        "Issue description must contain exactly one `Issue Contract` section",
      ],
    };
  }
  const sections = markdownSections(content);
  const section = sections.get(normalizeHeading(ISSUE_CONTRACT_HEADING));
  if (section === undefined) {
    return { valid: false, errors: ["Issue Contract section is missing"] };
  }
  const fencedJson = extractFencedJsonBlock(section);
  if (fencedJson === null) {
    return { valid: false, errors: ["Issue Contract must contain a fenced `json` block"] };
  }
  return parseIssueContractJsonResult(fencedJson);
}

export function parseIssueContractJson(value: string): ParsedIssueContractSnapshot | null {
  const result = parseIssueContractJsonResult(value);
  if (!result.valid) return null;
  return {
    ...result.contract,
    document: result.contract,
    canonicalJson: result.canonicalJson,
    fingerprint: result.fingerprint,
  };
}

function parseIssueContractJsonResult(value: string): ParsedIssueContractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { valid: false, errors: ["Issue Contract fenced `json` must parse as valid JSON"] };
  }
  if (!isRecord(parsed)) return { valid: false, errors: ["Issue Contract JSON must be an object"] };
  const errors = validateIssueContractObject(parsed, false);
  if (errors.length > 0) return { valid: false, errors };

  const delivery = parseIssueContractDelivery(parsed.delivery);
  if (delivery === null) {
    return { valid: false, errors: ["Issue Contract delivery is invalid"] };
  }
  const relationships = parseIssueContractRelationships(parsed.relationships);
  const contract: ParsedIssueContract = {
    ...parsed,
    schemaVersion: parsed.schemaVersion as number,
    contractVersion: (parsed.contractVersion as string).trim(),
    requirements: (parsed.requirements as Record<string, unknown>[]).map((requirement) => ({
      ...requirement,
      id: (requirement.id as string).trim(),
      requirement: (requirement.requirement as string).trim(),
      ...(typeof requirement.proofHint === "string" ? { proofHint: requirement.proofHint.trim() } : {}),
    })),
    delivery,
    ...(relationships === null ? {} : { relationships }),
  };
  const canonicalJson = stableJson(contract);
  return {
    valid: true,
    contract,
    canonicalJson,
    fingerprint: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

export function hasMeaningfulRemainingBlocker(remainingBlocker: string | null | undefined): boolean {
  if (!remainingBlocker) return false;

  const normalized = normalizeBlockerText(remainingBlocker);
  if (normalized.length === 0) return false;
  if (BLOCKER_PLACEHOLDER_VALUES.has(normalized)) return false;
  if (normalized.split(" ").length < 3) return false;
  return MANUAL_BLOCKER_KEYWORDS.test(normalized);
}

export function missingRequiredIssueContractSections(description: string | null | undefined): string[] {
  const headings = markdownHeadings(description ?? "");
  return AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS.filter((section) => !headings.has(normalizeHeading(section)));
}

function validateIssueContractSection(section: string | undefined): string[] {
  if (section === undefined) return [];

  const fencedJson = extractFencedJsonBlock(section);
  if (!fencedJson) {
    return ["Issue Contract must contain a fenced `json` block"];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fencedJson);
  } catch {
    return ["Issue Contract fenced `json` must parse as valid JSON"];
  }

  if (!isRecord(parsed)) {
    return ["Issue Contract JSON must be an object"];
  }

  return validateIssueContractObject(parsed, true);
}

function validateIssueContractObject(
  parsed: Record<string, unknown>,
  requireCurrentSchema: boolean,
): string[] {
  const errors: string[] = [];
  const schemaVersion = parsed.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    errors.push("Issue Contract must include a positive integer `schemaVersion`");
  } else if (schemaVersion !== 1 && schemaVersion !== CURRENT_ISSUE_CONTRACT_SCHEMA_VERSION) {
    errors.push(
      `Issue Contract schemaVersion ${schemaVersion} is unsupported; supported versions are 1 and ${CURRENT_ISSUE_CONTRACT_SCHEMA_VERSION}`,
    );
  } else if (requireCurrentSchema && schemaVersion !== CURRENT_ISSUE_CONTRACT_SCHEMA_VERSION) {
    errors.push(
      `Agent-eligible Issue Contract must use schemaVersion ${CURRENT_ISSUE_CONTRACT_SCHEMA_VERSION}`,
    );
  }

  const contractVersion = typeof parsed.contractVersion === "string" ? parsed.contractVersion.trim() : "";
  if (contractVersion.length === 0) {
    errors.push("Issue Contract must include a non-empty `contractVersion`");
  }

  errors.push(...validateIssueContractDelivery(parsed.delivery));
  errors.push(
    ...validateIssueContractRelationships(
      parsed.relationships,
      schemaVersion === CURRENT_ISSUE_CONTRACT_SCHEMA_VERSION,
      parsed.delivery,
    ),
  );

  const requirements = parsed.requirements;
  if (!Array.isArray(requirements) || requirements.length === 0) {
    errors.push("Issue Contract must include a non-empty `requirements` array");
    return errors;
  }

  const seenRequirementIds = new Set<string>();
  let hasInvalidRequirementId = false;
  let hasDuplicateRequirementId = false;
  let hasEmptyRequirementText = false;

  for (const requirement of requirements) {
    if (!isRecord(requirement)) {
      hasInvalidRequirementId = true;
      hasEmptyRequirementText = true;
      continue;
    }

    const rawId = typeof requirement.id === "string" ? requirement.id.trim() : "";
    if (!STABLE_REQUIREMENT_ID_PATTERN.test(rawId)) {
      hasInvalidRequirementId = true;
    } else {
      const normalizedId = rawId.toLowerCase();
      if (seenRequirementIds.has(normalizedId)) {
        hasDuplicateRequirementId = true;
      }
      seenRequirementIds.add(normalizedId);
    }

    const requirementText = typeof requirement.requirement === "string" ? requirement.requirement.trim() : "";
    if (requirementText.length === 0) {
      hasEmptyRequirementText = true;
    }
  }

  if (hasInvalidRequirementId) {
    errors.push("Issue Contract requirement ids must be stable non-empty identifiers (for example `REQ-001`)");
  }
  if (hasDuplicateRequirementId) {
    errors.push("Issue Contract requirement ids must be unique");
  }
  if (hasEmptyRequirementText) {
    errors.push("Issue Contract requirements must include non-empty `requirement` text");
  }

  return errors;
}

function validateIssueContractRelationships(
  value: unknown,
  required: boolean,
  deliveryValue: unknown,
): string[] {
  if (value === undefined) {
    return required
      ? ["Issue Contract must include `relationships.blocks` and `relationships.blockedBy` arrays"]
      : [];
  }
  if (!isRecord(value)) {
    return ["Issue Contract `relationships` must be an object"];
  }

  const errors: string[] = [];
  const allowedKeys = new Set(["blocks", "blockedBy", "succession"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    errors.push(
      `Issue Contract \`relationships\` contains unsupported fields: ${unknownKeys.sort().join(", ")}`,
    );
  }

  errors.push(...validateIssueReferenceArray(value.blocks, "relationships.blocks"));
  errors.push(...validateIssueReferenceArray(value.blockedBy, "relationships.blockedBy"));

  const successionErrors = validateIssueContractSuccession(value.succession);
  errors.push(...successionErrors);
  if (successionErrors.length > 0 || value.succession === undefined || !isRecord(value.succession)) {
    if (deliveryIsExpectedRedArtifact(deliveryValue) && value.succession === undefined) {
      errors.push(
        "Expected-red accepted-artifact delivery requires `relationships.succession.successor`",
      );
    }
    return errors;
  }

  const successor = successionEndpointIssue(value.succession.successor);
  const succeeds = successionEndpointIssue(value.succession.succeeds);
  if (successor !== null) {
    if (!deliveryIsExpectedRedArtifact(deliveryValue)) {
      errors.push(
        "Issue Contract with `relationships.succession.successor` must use expected-red accepted-artifact delivery",
      );
    }
    if (!issueReferenceArrayIncludes(value.blocks, successor)) {
      errors.push(
        "`relationships.blocks` must include the issue declared by `relationships.succession.successor`",
      );
    }
  }
  if (succeeds !== null) {
    if (deliveryIsExpectedRedArtifact(deliveryValue)) {
      errors.push(
        "Issue Contract with `relationships.succession.succeeds` must use merge delivery",
      );
    }
    if (!issueReferenceArrayIncludes(value.blockedBy, succeeds)) {
      errors.push(
        "`relationships.blockedBy` must include the issue declared by `relationships.succession.succeeds`",
      );
    }
  }
  return errors;
}

function validateIssueReferenceArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    return [`Issue Contract \`${field}\` must be an array (an empty array is valid)`];
  }
  const normalized = value.map((entry) =>
    typeof entry === "string" ? entry.trim().toLowerCase() : "",
  );
  if (normalized.some((entry) => entry.length === 0)) {
    return [`Issue Contract \`${field}\` entries must be non-empty issue references`];
  }
  if (new Set(normalized).size !== normalized.length) {
    return [`Issue Contract \`${field}\` must not contain duplicate issue references`];
  }
  return [];
}

function validateIssueContractSuccession(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    return ["Issue Contract `relationships.succession` must be an object"];
  }
  const allowedKeys = new Set(["id", "purpose", "successor", "succeeds"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  const errors: string[] = [];
  if (unknownKeys.length > 0) {
    errors.push(
      `Issue Contract \`relationships.succession\` contains unsupported fields: ${unknownKeys.sort().join(", ")}`,
    );
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!STABLE_REQUIREMENT_ID_PATTERN.test(id)) {
    errors.push(
      "Issue Contract `relationships.succession.id` must be a stable non-empty identifier",
    );
  }
  if (value.purpose !== "expected_red_implementation") {
    errors.push(
      "Issue Contract `relationships.succession.purpose` must be `expected_red_implementation`",
    );
  }
  const hasSuccessor = value.successor !== undefined;
  const hasSucceeds = value.succeeds !== undefined;
  if (hasSuccessor === hasSucceeds) {
    errors.push(
      "Issue Contract `relationships.succession` must include exactly one of `successor` or `succeeds`",
    );
  }
  if (hasSuccessor) {
    errors.push(...validateSuccessionEndpoint(value.successor, "successor"));
  }
  if (hasSucceeds) {
    errors.push(...validateSuccessionEndpoint(value.succeeds, "succeeds"));
  }
  return errors;
}

function validateSuccessionEndpoint(value: unknown, field: "successor" | "succeeds"): string[] {
  if (!isRecord(value)) {
    return [`Issue Contract \`relationships.succession.${field}\` must be an object`];
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== "issue");
  const errors =
    unknownKeys.length === 0
      ? []
      : [
          `Issue Contract \`relationships.succession.${field}\` contains unsupported fields: ${unknownKeys
            .sort()
            .join(", ")}`,
        ];
  if (typeof value.issue !== "string" || value.issue.trim().length === 0) {
    errors.push(
      `Issue Contract \`relationships.succession.${field}.issue\` must be a non-empty issue reference`,
    );
  }
  return errors;
}

function deliveryIsExpectedRedArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.mode === "accepted_artifact" &&
    value.artifact === "expected_red_tests"
  );
}

function successionEndpointIssue(value: unknown): string | null {
  return isRecord(value) && typeof value.issue === "string" && value.issue.trim().length > 0
    ? value.issue.trim()
    : null;
}

function issueReferenceArrayIncludes(value: unknown, reference: string): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        typeof entry === "string" &&
        entry.trim().toLowerCase() === reference.trim().toLowerCase(),
    )
  );
}

function parseIssueContractRelationships(value: unknown): IssueContractRelationships | null {
  if (!isRecord(value) || !Array.isArray(value.blocks) || !Array.isArray(value.blockedBy)) {
    return null;
  }
  const succession = isRecord(value.succession)
    ? parseIssueContractSuccession(value.succession)
    : null;
  return {
    blocks: value.blocks
      .map((entry) => String(entry).trim())
      .sort(compareIssueContractReference),
    blockedBy: value.blockedBy
      .map((entry) => String(entry).trim())
      .sort(compareIssueContractReference),
    ...(succession === null ? {} : { succession }),
  };
}

function parseIssueContractSuccession(
  value: Record<string, unknown>,
): IssueContractSuccession | null {
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (id.length === 0 || value.purpose !== "expected_red_implementation") return null;
  const successor = successionEndpointIssue(value.successor);
  if (successor !== null) {
    return {
      id,
      purpose: "expected_red_implementation",
      successor: { issue: successor },
    };
  }
  const succeeds = successionEndpointIssue(value.succeeds);
  return succeeds === null
    ? null
    : {
        id,
        purpose: "expected_red_implementation",
        succeeds: { issue: succeeds },
      };
}

export function validateIssueContractRelationshipsAgainstIssue(issue: Issue): string[] {
  const parsed = parseIssueContractFromDescription(issue.description);
  if (parsed === null || parsed.schemaVersion !== CURRENT_ISSUE_CONTRACT_SCHEMA_VERSION) {
    return [];
  }
  const relationships = parsed.relationships;
  if (relationships === undefined) return [];
  return [
    ...relationships.blocks
      .filter((reference) => issueReferenceMatches(reference, issue))
      .map(() => "Issue Contract `relationships.blocks` cannot contain the issue itself"),
    ...relationships.blockedBy
      .filter((reference) => issueReferenceMatches(reference, issue))
      .map(() => "Issue Contract `relationships.blockedBy` cannot contain the issue itself"),
    ...relationshipDirectionErrors("blocks", relationships.blocks, issue.blocks ?? []),
    ...relationshipDirectionErrors("blockedBy", relationships.blockedBy, issue.blockedBy),
  ];
}

function compareIssueContractReference(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function relationshipDirectionErrors(
  field: "blocks" | "blockedBy",
  declared: readonly string[],
  observed: readonly { id: string | null; identifier: string | null }[],
): string[] {
  const unmatchedDeclared = declared.filter(
    (reference) => !observed.some((edge) => issueReferenceMatches(reference, edge)),
  );
  const undeclaredObserved = observed.filter(
    (edge) => !declared.some((reference) => issueReferenceMatches(reference, edge)),
  );
  const errors: string[] = [];
  if (unmatchedDeclared.length > 0) {
    errors.push(
      `Issue Contract \`relationships.${field}\` declares edges absent from Linear: ${unmatchedDeclared
        .sort()
        .join(", ")}`,
    );
  }
  if (undeclaredObserved.length > 0) {
    errors.push(
      `Linear ${field} edges are missing from Issue Contract \`relationships.${field}\`: ${undeclaredObserved
        .map((edge) => edge.identifier ?? edge.id ?? "unknown")
        .sort()
        .join(", ")}`,
    );
  }
  return errors;
}

export function issueReferenceMatches(
  reference: string,
  issue: { id: string | null; identifier: string | null },
): boolean {
  const normalized = reference.trim().toLowerCase();
  return (
    (issue.id !== null && issue.id.trim().toLowerCase() === normalized) ||
    (issue.identifier !== null &&
      issue.identifier.trim().toLowerCase() === normalized)
  );
}

function validateIssueContractDelivery(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    return ["Issue Contract `delivery` must be an object"];
  }

  if (value.mode !== "merge" && value.mode !== "accepted_artifact") {
    return ["Issue Contract `delivery.mode` must be `merge` or `accepted_artifact`"];
  }

  const allowedKeys = value.mode === "merge" ? new Set(["mode"]) : new Set(["mode", "artifact"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  const errors: string[] = [];
  if (unknownKeys.length > 0) {
    errors.push(`Issue Contract \`delivery\` contains unsupported fields: ${unknownKeys.sort().join(", ")}`);
  }
  if (value.mode === "accepted_artifact" && value.artifact !== "expected_red_tests") {
    errors.push("Issue Contract accepted-artifact delivery requires `artifact: expected_red_tests`");
  }
  return errors;
}

function parseIssueContractDelivery(value: unknown): IssueContractDelivery | null {
  if (value === undefined) return { mode: "merge" };
  const errors = validateIssueContractDelivery(value);
  if (errors.length > 0 || !isRecord(value)) return null;
  return value.mode === "accepted_artifact"
    ? { mode: "accepted_artifact", artifact: "expected_red_tests" }
    : { mode: "merge" };
}

function validateIssueContractSpecificity(section: string | undefined): string[] {
  if (section === undefined) return [];
  const parsed = parseIssueContractSectionJson(section);
  if (!parsed || !isRecord(parsed)) return [];
  const requirements = parsed.requirements;
  if (!Array.isArray(requirements) || requirements.length !== 1) return [];
  const requirement = requirements[0];
  if (!isRecord(requirement)) return [];
  const text = normalizeSpecificityText(typeof requirement.requirement === "string" ? requirement.requirement : "");
  if (!GENERIC_SINGLE_REQUIREMENTS.has(text)) return [];
  return ["Issue Contract single requirement is too generic; split the required behavior into concrete reviewable obligations"];
}

const REQUIRED_CONTRACT_CHECKLIST_LANES = [
  "Happy path",
  "Negative/error path",
  "Adjacent sibling surface",
  "Empty/missing/stale/fallback state",
  "Replay/restart/idempotency",
  "Credential/security boundary",
  "Side-effect verification",
] as const;

function validateContractChecklistSpecificity(section: string | undefined): string[] {
  if (section === undefined) return [];
  const lanes = parseChecklistLanes(section);
  const errors: string[] = [];
  for (const lane of REQUIRED_CONTRACT_CHECKLIST_LANES) {
    const value = lanes.get(normalizeChecklistLane(lane));
    if (value === undefined) {
      errors.push(`Contract Checklist must include "${lane}"`);
      continue;
    }
    if (!isMeaningfulChecklistValue(value)) {
      errors.push(`Contract Checklist "${lane}" must include concrete coverage or a reasoned N/A`);
    }
  }
  return errors;
}

function validateValidationRequirementsSpecificity(section: string | undefined): string[] {
  if (section === undefined) return [];
  const text = stripMarkdownListMarkers(section)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  if (text.length === 0) {
    return ["Validation Requirements must name concrete tests, commands, files, API checks, or manual verification"];
  }
  const normalized = normalizeSpecificityText(text);
  if (GENERIC_VALIDATION_VALUES.has(normalized)) {
    return ["Validation Requirements are too generic; name concrete tests, commands, files, API checks, or manual verification"];
  }
  if (hasConcreteValidationSignal(text)) return [];
  return ["Validation Requirements must name concrete tests, commands, files, API checks, or manual verification"];
}

export function requiresAgentEligibleIssueContract(issue: Issue, config: ServiceConfig): boolean {
  if (!issue.assignedToWorker) return false;
  if (!containsName(config.tracker.activeStates, issue.state)) return false;
  if (!containsAllLabels(issue.labels, config.agent.requireLabels)) return false;
  if (containsAnyLabel(issue.labels, config.agent.excludeLabels)) return false;
  if (containsAnyLabel(issue.labels, config.agent.workerExcludeLabels)) return false;
  return true;
}

function emptyIssueContractAnalysis(): IssueContractAnalysis {
  return {
    missingSections: [],
    issueContractErrors: [],
    underSpecifiedContractErrors: [],
    protectedSurfaceMatches: [],
    readyForDogfoodReady: null,
    remainingBlocker: null,
  };
}

function markdownHeadings(description: string): Set<string> {
  return new Set(markdownSections(description).keys());
}

function markdownHeadingOccurrenceCount(
  description: string,
  targetHeading: string,
): number {
  const target = normalizeHeading(targetHeading);
  let count = 0;
  let activeFence: MarkdownFenceDelimiter | null = null;
  for (const line of description.split(/\r?\n/)) {
    const fence = parseMarkdownFenceDelimiter(line);
    if (activeFence) {
      if (
        fence &&
        fence.marker === activeFence.marker &&
        fence.length >= activeFence.length &&
        fence.trailing.trim().length === 0
      ) {
        activeFence = null;
      }
      continue;
    }
    if (fence) {
      activeFence = fence;
      continue;
    }
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match && normalizeHeading(match[1] ?? "") === target) count += 1;
  }
  return count;
}

interface MarkdownFenceDelimiter {
  marker: "`" | "~";
  length: number;
  trailing: string;
}

function markdownSections(description: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentHeading: string | null = null;
  let buffer: string[] = [];
  let activeFence: MarkdownFenceDelimiter | null = null;

  const flush = (): void => {
    if (!currentHeading) return;
    sections.set(currentHeading, buffer.join("\n").trim());
  };

  for (const line of description.split(/\r?\n/)) {
    const fence = parseMarkdownFenceDelimiter(line);
    if (activeFence) {
      if (
        fence &&
        fence.marker === activeFence.marker &&
        fence.length >= activeFence.length &&
        fence.trailing.trim().length === 0
      ) {
        activeFence = null;
      }
      if (currentHeading) buffer.push(line);
      continue;
    }

    if (fence) {
      activeFence = fence;
      if (currentHeading) buffer.push(line);
      continue;
    }

    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) {
      flush();
      currentHeading = normalizeHeading(match[1] ?? "");
      buffer = [];
      continue;
    }
    if (currentHeading) buffer.push(line);
  }

  flush();
  return sections;
}

function parseMarkdownFenceDelimiter(line: string): MarkdownFenceDelimiter | null {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;

  const delimiter = match[1] ?? "";
  const marker = delimiter[0];
  if (marker !== "`" && marker !== "~") return null;

  return {
    marker,
    length: delimiter.length,
    trailing: match[2] ?? "",
  };
}

function parseReadyForDogfoodReady(section: string): boolean | null {
  const match = section.match(/^\s*-?\s*ready\s+for\s+`?dogfood-ready`?\s*:\s*(yes|no)\s*$/im);
  if (!match) return null;
  return match[1]?.toLowerCase() === "yes";
}

function parseRemainingBlocker(section: string): string | null {
  const lines = section.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^(\s*)-\s*Remaining blocker:\s*(.*)$/i);
    if (!match) continue;

    const labelIndent = match[1]?.length ?? 0;
    const inline = match[2]?.trim();
    if (inline) return inline;

    const following: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const rawLine = lines[next] ?? "";
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        if (following.length > 0) break;
        continue;
      }
      const lineIndent = rawLine.match(/^\s*/)?.[0].length ?? 0;
      if (/^\s*-\s+/.test(rawLine) && lineIndent <= labelIndent) break;
      following.push(trimmed.replace(/^\s*[-*]\s+/, ""));
    }

    return following.length > 0 ? following.join(" ") : null;
  }

  return null;
}

function parseIssueContractSectionJson(section: string): unknown | null {
  const fencedJson = extractFencedJsonBlock(section);
  if (!fencedJson) return null;
  try {
    return JSON.parse(fencedJson);
  } catch {
    return null;
  }
}

function parseChecklistLanes(section: string): Map<string, string> {
  const lanes = new Map<string, string>();
  for (const line of stripMarkdownListMarkers(section)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const lane = normalizeChecklistLane(match[1] ?? "");
    const value = (match[2] ?? "").trim();
    if (!lane) continue;
    lanes.set(lane, value);
  }
  return lanes;
}

function stripMarkdownListMarkers(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/, ""));
}

function normalizeChecklistLane(value: string): string {
  return normalizeHeading(value.replace(/\//g, " "));
}

function isMeaningfulChecklistValue(value: string): boolean {
  const normalized = normalizeSpecificityText(value);
  if (PLACEHOLDER_CHECKLIST_VALUES.has(normalized)) return false;
  if (normalized.length < 12) return false;
  if (/^(?:n\/a|na|none|not applicable)\b/.test(normalized)) {
    return normalized.split(" ").length >= 5 && /\b(because|due to|out of scope|does not|no)\b/.test(normalized);
  }
  return true;
}

function hasConcreteValidationSignal(value: string): boolean {
  return (
    /`[^`]+`/.test(value) ||
    /\b(?:npm|pnpm|yarn|vitest|jest|tsx|tsc|pytest|cargo|go test|curl|gh)\b/i.test(value) ||
    /\b[\w./\\-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|py|rs|go)\b/i.test(value) ||
    /\b(?:src|tests|docs|migrations|packages|apps)[/\\][\w./\\-]+\b/i.test(value) ||
    /\b(?:api|http|endpoint|request|response)\b.*\b(?:check|call|verify|assert|inspect|smoke)\b/i.test(value) ||
    /\b(?:check|call|verify|assert|inspect|smoke)\b.*\b(?:api|http|endpoint|request|response)\b/i.test(value) ||
    /\bmanual(?:ly)?\b.*\b(?:verify|check|inspect|confirm|smoke)\b/i.test(value) ||
    /\b(?:verify|check|inspect|confirm|smoke)\b.*\bmanual(?:ly)?\b/i.test(value)
  );
}

function findProtectedSurfaceMatches(text: string, protectedPaths: readonly string[]): string[] {
  const normalizedText = normalizeScanText(text);
  const candidates = extractTouchedSurfacePathCandidates(text);
  const matches = new Set<string>();

  for (const protectedPath of protectedPaths) {
    const normalizedPath = normalizePathLikeText(protectedPath);
    if (normalizedPath.length === 0) continue;
    if (
      candidates.some((candidate) => protectedPathMatchesCandidate(candidate, normalizedPath)) ||
      bareRootProtectedPathMentioned(normalizedText, normalizedPath)
    ) {
      matches.add(protectedPath);
    }
  }

  return [...matches];
}

function extractTouchedSurfacePathCandidates(text: string): string[] {
  const normalized = normalizeScanText(text);
  const candidates = new Set<string>();

  for (const match of normalized.matchAll(/(?:^|[^a-z0-9._\/-])([a-z0-9._\/*-]+(?:\/[a-z0-9._\/*-]+)*)(?=$|[^a-z0-9._\/-])/g)) {
    const candidate = normalizePathLikeText(match[1] ?? "");
    if (!candidate.includes("/") && !candidate.includes(".") && !candidate.includes("*")) continue;
    candidates.add(candidate);
  }

  return [...candidates];
}

function protectedPathMatchesCandidate(candidate: string, normalizedProtectedPath: string): boolean {
  if (pathPatternMatches(normalizedProtectedPath, candidate)) return true;
  if (pathPatternMatches(candidate, normalizedProtectedPath)) return true;
  return false;
}

function pathPatternMatches(pattern: string, value: string): boolean {
  if (!pathPatternHasGlob(pattern)) return pattern === value;
  return globPatternToRegExp(pattern).test(value);
}

function pathPatternHasGlob(value: string): boolean {
  return value.includes("*");
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function bareRootProtectedPathMentioned(normalizedText: string, normalizedProtectedPath: string): boolean {
  if (pathPatternHasGlob(normalizedProtectedPath)) return false;
  if (normalizedProtectedPath.includes("/") || normalizedProtectedPath.includes(".")) return false;
  return new RegExp(`(?:^|[^a-z0-9._\\/-])${escapeRegExp(normalizedProtectedPath)}(?=$|[^a-z0-9._\\/-])`).test(
    normalizedText,
  );
}

function normalizePathLikeText(value: string): string {
  return normalizeScanText(value)
    .trim()
    .replace(/^[`"'(<[{]+/g, "")
    .replace(/[`"')>\]}]+$/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function normalizeScanText(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function extractFencedJsonBlock(section: string): string | null {
  let activeFence: MarkdownFenceDelimiter | null = null;
  let activeFenceContent: string[] = [];

  for (const line of section.split(/\r?\n/)) {
    const fence = parseMarkdownFenceDelimiter(line);
    if (activeFence) {
      if (
        fence &&
        fence.marker === activeFence.marker &&
        fence.length >= activeFence.length &&
        fence.trailing.trim().length === 0
      ) {
        if (isJsonFence(activeFence)) return activeFenceContent.join("\n").trim() || null;
        activeFence = null;
        activeFenceContent = [];
        continue;
      }

      if (isJsonFence(activeFence)) activeFenceContent.push(line);
      continue;
    }

    if (!fence) continue;
    activeFence = fence;
    activeFenceContent = [];
  }

  return null;
}

function isJsonFence(fence: MarkdownFenceDelimiter): boolean {
  return fence.trailing.trim().toLowerCase() === "json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeBlockerText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!,;:]+$/g, "");
}

function normalizeSpecificityText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`"'()]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!,;:]+$/g, "");
}

function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsName(values: readonly string[], expected: string): boolean {
  return values.some((value) => value.toLowerCase() === expected.toLowerCase());
}

function containsAllLabels(labels: readonly string[], required: readonly string[]): boolean {
  return required.every((label) => containsName(labels, label));
}

function containsAnyLabel(labels: readonly string[], excluded: readonly string[]): boolean {
  return excluded.some((label) => containsName(labels, label));
}
