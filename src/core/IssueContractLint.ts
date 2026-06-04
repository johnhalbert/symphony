import type { ServiceConfig } from "./config/Config.js";
import type { Issue } from "./types.js";

const ISSUE_CONTRACT_HEADING = "Issue Contract";
const TOUCHED_SURFACES_HEADING = "Touched Surfaces";
const PROMOTION_READINESS_HEADING = "Promotion Readiness";
const STABLE_REQUIREMENT_ID_PATTERN = /^[a-z][a-z0-9._:-]*$/i;
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
  protectedSurfaceMatches: string[];
  readyForDogfoodReady: boolean | null;
  remainingBlocker: string | null;
}

export interface IssueContractLintResult extends IssueContractAnalysis {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  applicable: boolean;
}

export function lintAgentEligibleIssueContract(issue: Issue, config: ServiceConfig): IssueContractLintResult {
  const applicable = requiresAgentEligibleIssueContract(issue, config);
  const analysis = applicable
    ? analyzeIssueContractDescription(issue.description, config.agent.protectedPaths)
    : emptyIssueContractAnalysis();
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
  const promotionReadiness = sections.get(normalizeHeading(PROMOTION_READINESS_HEADING)) ?? "";
  return {
    missingSections: missingRequiredIssueContractSections(content),
    issueContractErrors: validateIssueContractSection(issueContract),
    protectedSurfaceMatches: findProtectedSurfaceMatches(touchedSurfaces, protectedPaths),
    readyForDogfoodReady: parseReadyForDogfoodReady(promotionReadiness),
    remainingBlocker: parseRemainingBlocker(promotionReadiness),
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

  const errors: string[] = [];
  const schemaVersion = parsed.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    errors.push("Issue Contract must include a positive integer `schemaVersion`");
  }

  const contractVersion = typeof parsed.contractVersion === "string" ? parsed.contractVersion.trim() : "";
  if (contractVersion.length === 0) {
    errors.push("Issue Contract must include a non-empty `contractVersion`");
  }

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

export function requiresAgentEligibleIssueContract(issue: Issue, config: ServiceConfig): boolean {
  if (!issue.assignedToWorker) return false;
  if (!containsName(config.tracker.activeStates, issue.state)) return false;
  if (!containsAllLabels(issue.labels, config.agent.requireLabels)) return false;
  if (containsAnyLabel(issue.labels, config.agent.excludeLabels)) return false;
  return true;
}

function emptyIssueContractAnalysis(): IssueContractAnalysis {
  return {
    missingSections: [],
    issueContractErrors: [],
    protectedSurfaceMatches: [],
    readyForDogfoodReady: null,
    remainingBlocker: null,
  };
}

function markdownHeadings(description: string): Set<string> {
  return new Set(markdownSections(description).keys());
}

function markdownSections(description: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (!currentHeading) return;
    sections.set(currentHeading, buffer.join("\n").trim());
  };

  for (const line of description.split(/\r?\n/)) {
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
  const match = section.match(/```json\b\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBlockerText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!,;:]+$/g, "");
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
