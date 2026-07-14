import { describe, expect, it } from "vitest";
import {
  analyzeIssueContractDescription,
  hasMeaningfulRemainingBlocker,
  missingRequiredIssueContractSections,
  parseIssueContractFromDescription,
  parseIssueContractJson,
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

  it("defaults legacy contracts to merge delivery and exposes a canonical fingerprint", () => {
    const implicit = parseIssueContractFromDescription(agentEligibleIssueContract());
    const explicit = parseIssueContractFromDescription(
      agentEligibleIssueContract({ issueContractDelivery: { mode: "merge" } }),
    );

    expect(implicit).toMatchObject({
      schemaVersion: 1,
      delivery: { mode: "merge" },
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(implicit?.document).toMatchObject({ delivery: { mode: "merge" } });
    expect(implicit?.fingerprint).toBe(explicit?.fingerprint);
  });

  it("parses the accepted expected-red artifact delivery mode", () => {
    const parsed = parseIssueContractFromDescription(
      agentEligibleIssueContract({
        issueContractDelivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
      }),
    );

    expect(parsed?.delivery).toEqual({ mode: "accepted_artifact", artifact: "expected_red_tests" });
  });

  it("canonicalizes object key ordering while fingerprinting the entire contract", () => {
    const first = parseIssueContractJson(
      JSON.stringify({
        schemaVersion: 1,
        contractVersion: "v1",
        requirements: [{ id: "REQ-001", requirement: "Write the expected-red test." }],
        delivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
      }),
    );
    const reordered = parseIssueContractJson(
      JSON.stringify({
        delivery: { artifact: "expected_red_tests", mode: "accepted_artifact" },
        requirements: [{ requirement: "Write the expected-red test.", id: "REQ-001" }],
        contractVersion: "v1",
        schemaVersion: 1,
      }),
    );
    const changed = parseIssueContractJson(
      JSON.stringify({
        schemaVersion: 1,
        contractVersion: "v1",
        requirements: [{ id: "REQ-001", requirement: "Write a different expected-red test." }],
        delivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
      }),
    );

    expect(first?.fingerprint).toBe(reordered?.fingerprint);
    expect(first?.fingerprint).not.toBe(changed?.fingerprint);
  });

  it.each([
    [{ mode: "artifact" }, "delivery.mode"],
    [{ mode: "accepted_artifact", artifact: "test_bundle" }, "expected_red_tests"],
    [{ mode: "merge", artifact: "expected_red_tests" }, "unsupported fields"],
    [{ mode: "accepted_artifact", artifact: "expected_red_tests", branch: "feature" }, "unsupported fields"],
  ])("rejects invalid strict delivery metadata %#", (delivery, expectedError) => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        issueContractJson: JSON.stringify({
          schemaVersion: 1,
          contractVersion: "v1",
          requirements: [{ id: "REQ-001", requirement: "Write the expected-red test." }],
          delivery,
        }),
      }),
      [],
    );

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

  it("accepts concrete checklist lanes with reasoned N/A entries", () => {
    const analysis = analyzeIssueContractDescription(agentEligibleIssueContract(), []);

    expect(analysis.underSpecifiedContractErrors).toEqual([]);
  });

  it("reports a generic single-requirement Issue Contract", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        issueContractRequirements: [{ id: "REQ-001", requirement: "Complete the documented work." }],
      }),
      [],
    );

    expect(analysis.underSpecifiedContractErrors).toEqual(
      expect.arrayContaining([expect.stringContaining("single requirement is too generic")]),
    );
  });

  it("reports placeholder or missing Contract Checklist lanes", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        contractChecklist: [
          "- Happy path: covered.",
          "- Negative/error path: covered.",
          "- Empty/missing/stale/fallback state: N/A",
        ],
      }),
      [],
    );

    expect(analysis.underSpecifiedContractErrors).toEqual(
      expect.arrayContaining([
        'Contract Checklist "Happy path" must include concrete coverage or a reasoned N/A',
        'Contract Checklist "Negative/error path" must include concrete coverage or a reasoned N/A',
        'Contract Checklist must include "Adjacent sibling surface"',
        'Contract Checklist "Empty/missing/stale/fallback state" must include concrete coverage or a reasoned N/A',
      ]),
    );
  });

  it("reports generic Validation Requirements", () => {
    const analysis = analyzeIssueContractDescription(
      agentEligibleIssueContract({
        validationRequirements: ["- Run tests."],
      }),
      [],
    );

    expect(analysis.underSpecifiedContractErrors).toEqual(
      expect.arrayContaining([expect.stringContaining("Validation Requirements are too generic")]),
    );
  });
});
