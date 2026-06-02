import type { ServiceConfig } from "./config/Config.js";
import type { Issue } from "./types.js";

export const AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS = [
  "Problem / Goal",
  "Touched Surfaces",
  "Acceptance Criteria",
  "Contract Checklist",
  "Validation Requirements",
  "Out Of Scope",
  "Promotion Readiness",
] as const;

export interface IssueContractLintResult {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  applicable: boolean;
  missingSections: string[];
}

export function lintAgentEligibleIssueContract(issue: Issue, config: ServiceConfig): IssueContractLintResult {
  const applicable = requiresAgentEligibleIssueContract(issue, config);
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    },
    applicable,
    missingSections: applicable ? missingRequiredIssueContractSections(issue.description) : [],
  };
}

export function lintAgentEligibleIssueContracts(issues: readonly Issue[], config: ServiceConfig): IssueContractLintResult[] {
  return issues.map((issue) => lintAgentEligibleIssueContract(issue, config)).filter((result) => result.applicable);
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

function markdownHeadings(description: string): Set<string> {
  const headings = new Set<string>();
  for (const match of description.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1]?.trim();
    if (heading) headings.add(normalizeHeading(heading));
  }
  return headings;
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
