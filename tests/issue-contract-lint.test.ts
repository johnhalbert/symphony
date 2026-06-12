import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeIssueContractDescription,
  hasMeaningfulRemainingBlocker,
  missingRequiredIssueContractSections,
} from "../src/core/IssueContractLint.js";
import { agentEligibleIssueContract, fencedAuthoringSectionSpoof, nestedFencedIssueContractSpoof } from "./helpers.js";

describe("IssueContractLint", () => {
  it("requires the Issue Contract heading in required sections", () => {
    expect(missingRequiredIssueContractSections(agentEligibleIssueContract({ includeIssueContract: false }))).toContain(
      "Issue Contract",
    );
  });

  it("ignores required authoring headings hidden inside fenced code blocks", () => {
    const analysis = analyzeIssueContractDescription(fencedAuthoringSectionSpoof(), []);

    expect(analysis.missingSections).toEqual(
      expect.arrayContaining([
        "Issue Contract",
        "Touched Surfaces",
        "Acceptance Criteria",
        "Contract Checklist",
        "Validation Requirements",
        "Out Of Scope",
        "Promotion Readiness",
      ]),
    );
    expect(analysis.missingSections).not.toContain("Problem / Goal");
    expect(analysis.readyForDogfoodReady).toBeNull();
    expect(analysis.remainingBlocker).toBeNull();
  });

  it("rejects fenced JSON Issue Contracts hidden inside larger fenced code blocks", () => {
    const analysis = analyzeIssueContractDescription(nestedFencedIssueContractSpoof(), []);

    expect(analysis.missingSections).toEqual([]);
    expect(analysis.issueContractErrors).toEqual(["Issue Contract must contain a fenced `json` block"]);
    expect(analysis.readyForDogfoodReady).toBe(true);
  });

  it.each([
    ["non-json fence", agentEligibleIssueContract({ issueContractFenceLanguage: "yaml" }), "fenced `json` block"],
    ["malformed JSON", agentEligibleIssueContract({ issueContractJson: "{ not valid json" }), "valid JSON"],
    ["empty requirements", agentEligibleIssueContract({ issueContractRequirements: [] }), "non-empty `requirements` array"],
    [
      "duplicate or unstable ids",
      agentEligibleIssueContract({
        issueContractRequirements: [
          { id: "1", requirement: "First requirement." },
          { id: "REQ-001", requirement: "Second requirement." },
          { id: "REQ-001", requirement: "Duplicate requirement." },
        ],
      }),
      "stable non-empty identifiers",
    ],
    [
      "empty requirement text",
      agentEligibleIssueContract({ issueContractRequirements: [{ id: "REQ-001", requirement: "   " }] }),
      "non-empty `requirement` text",
    ],
  ])("reports invalid Issue Contract content for %s", (_label, description, expectedError) => {
    const analysis = analyzeIssueContractDescription(description, []);

    expect(analysis.issueContractErrors).toEqual(expect.arrayContaining([expect.stringContaining(expectedError)]));
  });

  it("only matches protected paths explicitly declared in Touched Surfaces", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- [X] API/projection"],
        outOfScope: [
          "- Do not modify docs/dogfood-runbook.md in this slice.",
          "- Validation notes may mention docs/dogfood-runbook.md without touching it.",
        ],
      }),
      ["docs/dogfood-runbook.md"],
    );

    expect(analysis.protectedSurfaceMatches).toEqual([]);
  });

  it("matches protected directory globs on path boundaries only", () => {
    const boundaryMiss = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- src/core/configuration/runtime.ts"],
      }),
      ["src/core/config/**"],
    );
    expect(boundaryMiss.protectedSurfaceMatches).toEqual([]);

    const boundaryHit = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- src/core/config/runtime.ts"],
      }),
      ["src/core/config/**"],
    );
    expect(boundaryHit.protectedSurfaceMatches).toEqual(["src/core/config/**"]);
  });

  it("matches protected root files when explicitly declared in Touched Surfaces", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- WORKFLOW.md"],
        readyForDogfoodReady: "no",
        remainingBlocker: "Manual operator-authored update required for the protected workflow file.",
      }),
      ["WORKFLOW.md"],
    );

    expect(analysis.protectedSurfaceMatches).toEqual(["WORKFLOW.md"]);
  });

  it("matches protected root paths without extensions when explicitly declared in Touched Surfaces", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- Dockerfile"],
        readyForDogfoodReady: "no",
        remainingBlocker: "Manual operator-authored update required for the protected container definition.",
      }),
      ["Dockerfile"],
    );

    expect(analysis.protectedSurfaceMatches).toEqual(["Dockerfile"]);
  });

  it("matches exact protected paths with terminal sentence punctuation", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- docs/dogfood-runbook.md.", "- WORKFLOW.md."],
        readyForDogfoodReady: "no",
        remainingBlocker: "Manual operator-authored update required for the protected workflow files.",
      }),
      ["docs/dogfood-runbook.md", "WORKFLOW.md"],
    );

    expect(analysis.protectedSurfaceMatches).toEqual(["docs/dogfood-runbook.md", "WORKFLOW.md"]);
  });

  it("normalizes leading dot-slash before matching protected paths", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- ./docs/dogfood-runbook.md", "- ./src/core/config/runtime.ts"],
        readyForDogfoodReady: "no",
        remainingBlocker: "Manual operator-authored update required for protected workflow surfaces.",
      }),
      ["docs/dogfood-runbook.md", "src/core/config/**"],
    );

    expect(analysis.protectedSurfaceMatches).toEqual(["docs/dogfood-runbook.md", "src/core/config/**"]);
  });

  it("honors configured protected globs and broad touched-surface globs", () => {
    const configuredGlob = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- docs/dogfood-runbook.md", "- src/core/config/runtime.ts"],
        readyForDogfoodReady: "no",
        remainingBlocker: "Manual operator-authored update required for protected workflow surfaces.",
      }),
      ["docs/*.md", "src/core/*/runtime.ts"],
    );
    expect(configuredGlob.protectedSurfaceMatches).toEqual(["docs/*.md", "src/core/*/runtime.ts"]);

    const recursiveRootGlob = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- docs/dogfood-runbook.md"],
        readyForDogfoodReady: "no",
        remainingBlocker: "Manual operator-authored update required for protected workflow surfaces.",
      }),
      ["docs/**/*.md"],
    );
    expect(recursiveRootGlob.protectedSurfaceMatches).toEqual(["docs/**/*.md"]);

    const touchedGlob = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        touchedSurfaces: ["- docs/**"],
        readyForDogfoodReady: "no",
        remainingBlocker: "Manual operator-authored update required for protected workflow surfaces.",
      }),
      ["docs/dogfood-runbook.md"],
    );
    expect(touchedGlob.protectedSurfaceMatches).toEqual(["docs/dogfood-runbook.md"]);
  });

  it("treats the yes/no readiness placeholder as unresolved", () => {
    const description = agentEligibleIssueContract().replace(
      "Ready for `dogfood-ready`: yes",
      "Ready for `dogfood-ready`: yes/no",
    );

    const analysis = analyzeIssueContractDescription(description, []);

    expect(analysis.readyForDogfoodReady).toBeNull();
  });

  it("rejects blocker boilerplate but accepts nested substantive blocker bullets", () => {
    const boilerplate =
      'If any protected path is listed above, keep this issue manual-only with "Ready for `dogfood-ready`: no" and explain the operator blocker here.';
    expect(hasMeaningfulRemainingBlocker(boilerplate)).toBe(false);

    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({ readyForDogfoodReady: "no", remainingBlocker: "" }).replace(
        "- Remaining blocker: ",
        "- Remaining blocker:\n  - Manual operator-authored update required for the protected workflow file.",
      ),
      ["docs/dogfood-runbook.md"],
    );

    expect(analysis.remainingBlocker).toBe("Manual operator-authored update required for the protected workflow file.");
    expect(hasMeaningfulRemainingBlocker(analysis.remainingBlocker)).toBe(true);
  });

  it("keeps the ENG-371 public metadata child contract examples lint-clean with stable requirement ids", () => {
    const examples = eng371ContractExamples();

    expect(examples.map((example) => example.title)).toEqual([
      "Example A — Redaction parity child issue",
      "Example B — Repository ambiguity child issue",
      "Example C — Merge-gate closure child issue",
      "Example D — Validation evidence follow-up (protected docs)",
    ]);

    const protectedPaths = ["WORKFLOW.md", "docs/dogfood-runbook.md", "src/core/workflow/**", "hermes/src/**"];
    for (const example of examples) {
      const analysis = analyzeIssueContractDescription(example.description, protectedPaths);
      expect(analysis.missingSections, example.title).toEqual([]);
      expect(analysis.issueContractErrors, example.title).toEqual([]);

      const requirementIds = extractIssueContractRequirementIds(example.description);
      expect(requirementIds.length, example.title).toBeGreaterThan(0);
      expect(new Set(requirementIds).size, example.title).toBe(requirementIds.length);
      for (const requirementId of requirementIds) {
        expect(requirementId, example.title).toMatch(/^REQ-ENG371-[A-Z-]+-001$/);
      }
    }
  });

  it("keeps the ENG-371 validation-evidence example manual-only for protected docs", () => {
    const example = eng371ContractExamples().find(
      (candidate) => candidate.title === "Example D — Validation evidence follow-up (protected docs)",
    );
    expect(example).toBeDefined();

    const analysis = analyzeIssueContractDescription(example?.description ?? "", ["docs/dogfood-runbook.md"]);
    expect(analysis.protectedSurfaceMatches).toEqual(["docs/dogfood-runbook.md"]);
    expect(analysis.readyForDogfoodReady).toBe(false);
    expect(analysis.remainingBlocker).toBe(
      "Manual operator-authored update required for the protected workflow documentation in docs/dogfood-runbook.md.",
    );
    expect(hasMeaningfulRemainingBlocker(analysis.remainingBlocker)).toBe(true);
  });

  it("documents the ENG-371 promotion evidence packet and vendored-Hermes no-touch checks", () => {
    const quickstart = eng371Quickstart();

    expect(quickstart).toContain("npm test -- tests/issue-contract-lint.test.ts");
    expect(quickstart).toContain("git diff --name-only origin/main...HEAD -- hermes/upstream-src");
    expect(quickstart).toContain("git status --short -- hermes/upstream-src");
    expect(quickstart).toContain("/api/v1/issues/<issue-identifier>");
    expect(quickstart).toContain("/api/v1/runs/<handoffWorkerRunId>");
    expect(quickstart).toContain("/api/v1/runs/<handoffWorkerRunId>/transcript?offset=0&limit=200");
    expect(quickstart).toContain("Do not paste credential values");
    expect(quickstart).toContain("credential-bearing repository URLs");
  });
});

interface Eng371ContractExample {
  title: string;
  description: string;
}

function eng371ContractExamples(): Eng371ContractExample[] {
  const content = readFileSync(
    new URL("../specs/005-eng-371-public-metadata-closure/contracts/public-metadata-redaction.md", import.meta.url),
    "utf8",
  );
  const matches = Array.from(content.matchAll(/^## (.+?)\r?\n\r?\n````markdown\r?\n([\s\S]*?)\r?\n````/gm));
  return matches.map((match) => ({ title: match[1] ?? "", description: (match[2] ?? "").trim() }));
}

function extractIssueContractRequirementIds(description: string): string[] {
  const issueContractJson = description.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  expect(issueContractJson, "Issue Contract JSON block must exist").not.toBeNull();
  const parsed = JSON.parse(issueContractJson?.[1] ?? "{}");
  return Array.isArray(parsed.requirements)
    ? parsed.requirements.map((requirement: { id?: unknown }) => String(requirement.id ?? "").trim())
    : [];
}

function eng371Quickstart(): string {
  return readFileSync(new URL("../specs/005-eng-371-public-metadata-closure/quickstart.md", import.meta.url), "utf8");
}
