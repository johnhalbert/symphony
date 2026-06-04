import type { ServiceConfig } from "./config/Config.js";
import type { Issue } from "./types.js";

const TOUCHED_SURFACES_HEADING = "Touched Surfaces";
const PROMOTION_READINESS_HEADING = "Promotion Readiness";

export const AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS = [
  "Problem / Goal",
  TOUCHED_SURFACES_HEADING,
  "Acceptance Criteria",
  "Contract Checklist",
  "Validation Requirements",
  "Out Of Scope",
  PROMOTION_READINESS_HEADING,
] as const;

export interface IssueContractAnalysis {
  missingSections: string[];
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
  const touchedSurfaces = sections.get(normalizeHeading(TOUCHED_SURFACES_HEADING)) ?? "";
  const promotionReadiness = sections.get(normalizeHeading(PROMOTION_READINESS_HEADING)) ?? "";
  const scanText = touchedSurfaces.length > 0 ? `${touchedSurfaces}\n${content}` : content;
  return {
    missingSections: missingRequiredIssueContractSections(content),
    protectedSurfaceMatches: findProtectedSurfaceMatches(scanText, protectedPaths),
    readyForDogfoodReady: parseReadyForDogfoodReady(promotionReadiness),
    remainingBlocker: parseRemainingBlocker(promotionReadiness),
  };
}

export function missingRequiredIssueContractSections(description: string | null | undefined): string[] {
  const headings = markdownHeadings(description ?? "");
  return AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS.filter((section) => !headings.has(normalizeHeading(section)));
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
  const match = section.match(/ready\s+for\s+`?dogfood-ready`?\s*:\s*(yes|no)\b/i);
  if (!match) return null;
  return match[1]?.toLowerCase() === "yes";
}

function parseRemainingBlocker(section: string): string | null {
  const lines = section.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^\s*-\s*Remaining blocker:\s*(.*)$/i);
    if (!match) continue;

    const inline = match[1]?.trim();
    if (inline) return inline;

    const following: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const trimmed = lines[next]?.trim() ?? "";
      if (trimmed.length === 0) {
        if (following.length > 0) break;
        continue;
      }
      if (/^\s*-\s+/.test(trimmed)) break;
      following.push(trimmed.replace(/^\s*[-*]\s+/, ""));
    }

    return following.length > 0 ? following.join(" ") : null;
  }

  return null;
}

function findProtectedSurfaceMatches(text: string, protectedPaths: readonly string[]): string[] {
  const normalized = normalizePathLikeText(text);
  const matches = new Set<string>();

  for (const protectedPath of protectedPaths) {
    const normalizedPath = normalizePathLikeText(protectedPath);
    if (normalizedPath.length === 0) continue;
    if (normalized.includes(normalizedPath)) {
      matches.add(protectedPath);
      continue;
    }
    if (!normalizedPath.endsWith("/**")) continue;
    const prefix = normalizedPath.slice(0, -3).replace(/\/+$/, "");
    if (prefix.length > 0 && (normalized.includes(`${prefix}/`) || normalized.includes(prefix))) {
      matches.add(protectedPath);
    }
  }

  return [...matches];
}

function normalizePathLikeText(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
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
