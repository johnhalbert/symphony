import { describe, expect, it } from "vitest";
import {
  analyzeIssueContractDescription,
  hasMeaningfulRemainingBlocker,
  lintAgentEligibleIssueContract,
  missingRequiredIssueContractSections,
} from "../src/core/IssueContractLint.js";
import { agentEligibleIssueContract, fencedAuthoringSectionSpoof, issue, nestedFencedIssueContractSpoof, testConfig } from "./helpers.js";

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


  it("accepts the ENG-443 child legacy-backfill example through the agent-eligible lint path", () => {
    const config = testConfig("/tmp/eng-443c-issue-contract-lint");
    const description = agentEligibleIssueContract({
      problemGoal:
        "Preserve legacy/default project-context attribution in historical readback without exposing secrets or rewriting stored records.",
      issueContractContractVersion: "2026-06-11.1",
      issueContractRequirements: [
        {
          id: "REQ-ENG443C-001",
          requirement:
            "Backfilled legacy project-context metadata must use only non-secret public metadata and mark attribution source as legacy/default where applicable.",
        },
        {
          id: "REQ-ENG443C-002",
          requirement:
            "Readback evidence, logs, transcripts, and projection output must not expose credential values or destructively rewrite historical records during ordinary reads.",
        },
        {
          id: "REQ-ENG443C-003",
          requirement:
            "ENG-443 child contract examples must pass issue-contract lint coverage and final evidence must distinguish base proof, missing-path repair, no-op disposition, and validation results.",
        },
      ],
      touchedSurfaces: [
        "- tests/transcript-store.test.ts",
        "- tests/transcript-replay.test.ts",
        "- tests/issue-contract-lint.test.ts",
        "- specs/008-eng-443-legacy-backfill-resolution/contracts/legacy-backfill-readback.md",
      ],
      acceptanceCriteria: [
        "- Legacy/default readback stays publicly attributable without exposing secrets.",
        "- Ordinary reads leave historical records unchanged.",
        "- Child-contract examples and evidence notes are recorded distinctly.",
      ],
      contractChecklist: [
        "- Happy path: legacy/default attribution stays visible to readback consumers.",
        "- Negative/error path: secret-bearing metadata is redacted from public readback.",
        "- Replay/idempotency: ordinary reads do not rewrite historical records.",
      ],
      validationRequirements: [
        "- npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/workspace.test.ts",
        "- npm test -- tests/issue-contract-lint.test.ts",
      ],
      outOfScope: ["- No new tracker routing behavior."],
    });

    const result = lintAgentEligibleIssueContract(
      issue({ identifier: "ENG-846-EXAMPLE", state: "In Progress", description }),
      config,
    );

    expect(result.applicable).toBe(true);
    expect(result.missingSections).toEqual([]);
    expect(result.issueContractErrors).toEqual([]);
    expect(result.protectedSurfaceMatches).toEqual([]);
    expect(result.readyForDogfoodReady).toBe(true);
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
});
