import { readFileSync } from "node:fs";
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

  it("keeps the ENG-371 public metadata child contract examples lint-clean with stable requirement ids", () => {
    const examples = eng371ContractExamples();
    const expectedExamples = [
      {
        title: "Example A — Redaction parity child issue",
        requirementIds: ["REQ-ENG371-REDACTION-PARITY-001"],
      },
      {
        title: "Example B — Repository ambiguity child issue",
        requirementIds: ["REQ-ENG371-REPOSITORY-AMBIGUITY-001"],
      },
      {
        title: "Example C — Merge-gate closure child issue",
        requirementIds: ["REQ-ENG371-MERGE-GATE-CLOSURE-001"],
      },
      {
        title: "Example D — Validation evidence follow-up (protected docs)",
        requirementIds: ["REQ-ENG371-VALIDATION-EVIDENCE-001"],
      },
    ] as const;

    expect(examples.map((example) => example.title)).toEqual(expectedExamples.map((example) => example.title));

    const expectedRequirementIds = new Map<string, readonly string[]>(
      expectedExamples.map((example) => [example.title, example.requirementIds]),
    );
    const protectedPaths = ["WORKFLOW.md", "docs/dogfood-runbook.md", "src/core/workflow/**", "hermes/src/**"];
    for (const example of examples) {
      const analysis = analyzeIssueContractDescription(example.description, protectedPaths);
      expect(analysis.missingSections, example.title).toEqual([]);
      expect(analysis.issueContractErrors, example.title).toEqual([]);
      expect(extractIssueContractRequirementIds(example.description), example.title).toEqual(
        expectedRequirementIds.get(example.title),
      );
    }
  });

  it("keeps the ENG-371 validation-evidence example manual-only for protected docs", () => {
    const example = eng371ContractExamples().find(
      (candidate) => candidate.title === "Example D — Validation evidence follow-up (protected docs)",
    );
    expect(example).toBeDefined();

    const description = example?.description ?? "";
    const analysis = analyzeIssueContractDescription(description, ["docs/dogfood-runbook.md"]);
    expect(analysis.protectedSurfaceMatches).toEqual(["docs/dogfood-runbook.md"]);
    expect(analysis.readyForDogfoodReady).toBe(false);
    expect(analysis.remainingBlocker).toBe(
      "Manual operator-authored update required for the protected workflow documentation in docs/dogfood-runbook.md.",
    );
    expect(hasMeaningfulRemainingBlocker(analysis.remainingBlocker)).toBe(true);
    expect(description).toContain("git status --short -- hermes/upstream-src");
    expect(description).toContain("reviewLoop.lastCompletionReport.runId");
    expect(description).toContain("/api/v1/runs/<handoffWorkerRunId>/transcript?offset=<max(transcriptEventCount-15,0)>&limit=15");
    expect(description).toContain("run.prompt");
    expect(description).toContain("~/.hermes/logs/*.log");
    expect(description).toContain("prompt, log, transcript, or documentation excerpt");
  });

  it("documents the ENG-371 promotion evidence packet and vendored-Hermes no-touch checks", () => {
    const quickstart = eng371Quickstart();
    const credentialUrlDetector = extractDocumentedPythonRawRegex(quickstart, "credential_url");
    const openaiKeyDetector = extractDocumentedPythonRawRegex(quickstart, "openai_key");

    expect(quickstart).toContain("REQ-ENG371-REDACTION-PARITY-001");
    expect(quickstart).toContain("REQ-ENG371-REPOSITORY-AMBIGUITY-001");
    expect(quickstart).toContain("REQ-ENG371-MERGE-GATE-CLOSURE-001");
    expect(quickstart).toContain("REQ-ENG371-VALIDATION-EVIDENCE-001");
    expect(quickstart).toContain("npm test -- tests/issue-contract-lint.test.ts");
    expect(quickstart).toContain("git diff --name-only origin/main...HEAD -- hermes/upstream-src");
    expect(quickstart).toContain("git status --short -- hermes/upstream-src");
    expect(quickstart).toContain("/api/v1/issues/<issue-identifier>");
    expect(quickstart).toContain("reviewLoop.lastCompletionReport.runId");
    expect(quickstart).toContain("reviewLoop.lastCompletionReport.id");
    expect(quickstart).toContain("reviewLoop.lastCompletionReport.acceptedAt");
    expect(quickstart).toContain("/api/v1/runs/<handoffWorkerRunId>");
    expect(quickstart).toContain("/api/v1/runs/<handoffWorkerRunId>/transcript?offset=<max(transcriptEventCount-15,0)>&limit=15");
    expect(quickstart).toContain("RUN_ID='<handoffWorkerRunId>' python - <<'PY'");
    expect(quickstart).toContain("run.prompt");
    expect(quickstart).toContain("~/.hermes/logs/");
    expect(quickstart).toContain("surfacesChecked");
    expect(quickstart).toContain("findings");
    expect(quickstart).toContain("prompt/log/transcript/doc sweep");
    expect(quickstart).toContain("completed");
    expect(quickstart).toContain("message_complete");
    expect(quickstart).toContain("lastEvidenceCursor");
    expect(quickstart).toContain("Do not cite `workspacePath` or `repoPath`");
    expect(quickstart).toContain("Do not paste credential values");
    expect(quickstart).toContain("credential-bearing repository URLs");
    expect(quickstart).toContain("workflow, doctor, prompt, log, transcript, or documentation excerpt");
    expect(quickstart).toContain("raw log lines");
    expect(credentialUrlDetector.test("https://alice:token@example.com/repo.git")).toBe(true);
    expect(credentialUrlDetector.test("https://user:pass@example.com/repo.git")).toBe(true);
    expect(credentialUrlDetector.test("https://svc-user:token@example.com/repo.git")).toBe(true);
    expect(credentialUrlDetector.test("https://github.com/org/repo.git")).toBe(false);
    expect(openaiKeyDetector.test("sk-abcdefghijklmnopqrstuvwxyz1234")).toBe(true);
    expect(openaiKeyDetector.test("sk-proj-abcdefghijklmnopqrstuvwxyz1234")).toBe(true);
    expect(openaiKeyDetector.test("sk-svcacct-abcdefghijklmnopqrstuvwxyz1234")).toBe(true);
    expect(openaiKeyDetector.test("https://example.com/sk-proj-not-a-key")).toBe(false);
    expect(quickstart).not.toContain("tool_call_completed");
    expect(quickstart).not.toContain("operator-only private logs");
  });

  it("keeps the ENG-372 routing child contract examples lintable and mapped to stable requirement ids", () => {
    const examples = eng372ContractExamples();
    const expectedRequirementIds = new Map<string, string[]>([
      ["Example A — Credential routing matrix", ["REQ-ENG372C-001"]],
      ["Example B — Redacted route evidence", ["REQ-ENG372C-002"]],
      ["Example C — Issue-contract lint coverage", ["REQ-ENG372C-003"]],
    ]);

    expect(examples.map((example) => example.title)).toEqual([...expectedRequirementIds.keys()]);
    for (const example of examples) {
      const analysis = analyzeIssueContractDescription(example.description, []);
      expect(analysis.missingSections, example.title).toEqual([]);
      expect(analysis.issueContractErrors, example.title).toEqual([]);
      expect(extractIssueContractRequirementIds(example.description), example.title).toEqual(
        expectedRequirementIds.get(example.title),
      );
    }
  });

  it("keeps the ENG-392 child contract family examples lintable and mapped to stable requirement ids", () => {
    const examples = eng392ContractExamples();
    const expectedRequirementIds = new Map<string, string[]>([
      ["Family A — `REQ-392-DECISION`", ["REQ-392-DECISION"]],
      ["Family B — `REQ-392-RUNTIME-ROUTING`", ["REQ-392-RUNTIME-ROUTING"]],
      ["Family C — `REQ-392-RELOAD-PRESERVATION`", ["REQ-392-RELOAD-PRESERVATION"]],
      ["Family D — `REQ-392-APPROVAL-WRITEBACK`", ["REQ-392-APPROVAL-WRITEBACK"]],
      ["Family E — `REQ-392-TEST-PROOF`", ["REQ-392-TEST-PROOF"]],
      ["Family F — `REQ-392-PUBLICATION-HYGIENE`", ["REQ-392-PUBLICATION-HYGIENE"]],
    ]);

    expect(examples.map((example) => example.title)).toEqual([...expectedRequirementIds.keys()]);
    for (const example of examples) {
      const analysis = analyzeIssueContractDescription(example.description, []);
      expect(analysis.missingSections, example.title).toEqual([]);
      expect(analysis.issueContractErrors, example.title).toEqual([]);
      expect(extractIssueContractRequirementIds(example.description), example.title).toEqual(
        expectedRequirementIds.get(example.title),
      );
    }
  });

  it("documents the ENG-2479 runtime-child preflight proof matrix and fallback order", () => {
    const childContracts = eng392ChildContracts();
    const validationEvidence = eng392ValidationEvidence();

    expect(childContracts).toContain("`spec.md`, `plan.md`, and `tasks.md` are not tracked");
    expect(childContracts).toContain("use the following authoritative fallback source order");
    expect(childContracts).toContain("specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md");
    expect(childContracts).toContain("specs/009-eng-392-routing-reload-split/data-model.md");
    expect(childContracts).toContain("specs/009-eng-392-routing-reload-split/quickstart.md");
    expect(childContracts).toContain("specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md");
    expect(childContracts).toContain("specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md");

    expect(validationEvidence).toContain("ENG-2479 runtime child preflight proof matrix");
    expect(validationEvidence).toContain("REQ-392-RUNTIME-ROUTING");
    expect(validationEvidence).toContain("REQ-392-RELOAD-PRESERVATION");
    expect(validationEvidence).toContain("REQ-392-APPROVAL-WRITEBACK");
    expect(validationEvidence).toContain("command string");
    expect(validationEvidence).toContain("outcome status");
    expect(validationEvidence).toContain("per-family coverage signal");
    expect(validationEvidence).toContain("findings");
    expect(validationEvidence).toContain("redaction statement");
    expect(validationEvidence).toContain("redactionStatement");
    expect(validationEvidence).toContain("does not authorize runtime implementation");
    expect(validationEvidence).toContain("live lifecycle state changes");
    expect(validationEvidence).toContain("protected branch updates");
    expect(validationEvidence).toContain("REQ-392-TEST-PROOF");
    expect(validationEvidence).toContain("REQ-392-PUBLICATION-HYGIENE");
    expect(validationEvidence).toContain("hermes/upstream-src/**");
    expect(validationEvidence).toContain("depends on `REQ-392-DECISION`");
    expect(validationEvidence).toContain("depends on `REQ-392-RUNTIME-ROUTING`");
    expect(validationEvidence).toContain("depends on both `REQ-392-RUNTIME-ROUTING` and `REQ-392-RELOAD-PRESERVATION`");
    expect(validationEvidence).toContain(
      "depends on `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, and `REQ-392-APPROVAL-WRITEBACK`",
    );
    expect(validationEvidence).toContain(
      "depends on `REQ-392-DECISION`, `REQ-392-APPROVAL-WRITEBACK`, and `REQ-392-TEST-PROOF`",
    );
  });

  it("documents the ENG-372 routing validation matrix and redacted evidence quickstart", () => {
    const quickstart = eng372Quickstart();

    expect(quickstart).toContain("REQ-ENG372C-001");
    expect(quickstart).toContain("REQ-ENG372C-002");
    expect(quickstart).toContain("REQ-ENG372C-003");
    expect(quickstart).toContain("npm test -- tests/linear.test.ts tests/orchestrator.test.ts tests/status-api.test.ts tests/workspace.test.ts");
    expect(quickstart).toContain("npm test -- tests/issue-contract-lint.test.ts");
    expect(quickstart).toContain("/api/v1/issues/docs:ENG-179/planning-run");
    expect(quickstart).toContain("/api/v1/issues/docs:ENG-179/planning-run/apply");
    expect(quickstart).toContain("/api/v1/issues/ENG-179/open-workspace");
    expect(quickstart).toContain("routeEvidence");
    expect(quickstart).toContain('"redacted": true');
    expect(quickstart).toContain("credential_unavailable");
    expect(quickstart).toContain("[REDACTED]");
    expect(quickstart).toContain("requestKey");
    expect(quickstart).toContain("requestedProjectContextId");
    expect(quickstart).toContain("resolvedProjectContextId");
    expect(quickstart).not.toContain("LINEAR_API_KEY=");
    expect(quickstart).not.toContain("credential_profiles.roles.worker.linear.tracker");
  });

  it("validates the original mirrored ENG-392 issue body and records its section findings", () => {
    const description = eng392OriginalMirroredIssueBody();
    const analysis = analyzeIssueContractDescription(description, []);

    expect(analysis.missingSections).toEqual(["Contract Checklist", "Out Of Scope"]);
    expect(analysis.issueContractErrors).toEqual([]);
    expect(extractIssueContractRequirementIds(description)).toEqual(["REQ-T037"]);
    expect(description).toContain("tests/orchestrator.test.ts");
    expect(description).toContain("## Validation Requirements");
    expect(description).toContain("## Promotion Readiness");
  });
});

interface IssueContractExample {
  title: string;
  description: string;
}

function eng371ContractExamples(): IssueContractExample[] {
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

function eng372ContractExamples(): IssueContractExample[] {
  const content = readFileSync(
    new URL("../specs/006-eng-372-context-credential-routing/contracts/live-tracker-routing.md", import.meta.url),
    "utf8",
  );
  const matches = Array.from(content.matchAll(/^## (.+?)\r?\n\r?\n````markdown\r?\n([\s\S]*?)\r?\n````/gm));
  return matches.map((match) => ({ title: match[1] ?? "", description: (match[2] ?? "").trim() }));
}

function eng372Quickstart(): string {
  return readFileSync(new URL("../specs/006-eng-372-context-credential-routing/quickstart.md", import.meta.url), "utf8");
}

function eng392ChildContracts(): string {
  return readFileSync(
    new URL("../specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md", import.meta.url),
    "utf8",
  );
}

function eng392ValidationEvidence(): string {
  return readFileSync(
    new URL("../specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md", import.meta.url),
    "utf8",
  );
}

function eng392ContractExamples(): IssueContractExample[] {
  const content = eng392ChildContracts();
  const matches = Array.from(content.matchAll(/^## (Family .+?)\r?\n[\s\S]*?````markdown\r?\n([\s\S]*?)\r?\n````/gm));
  return matches.map((match) => ({ title: match[1] ?? "", description: (match[2] ?? "").trim() }));
}

function eng392OriginalMirroredIssueBody(): string {
  return [
    "<!-- linear-linkback -->",
    "<details>",
    "<summary><a href=\"https://linear.app/john-halbert/issue/ENG-392/t037-add-orchestrator-routing-and-config-reload-preservation-tests\">ENG-392 T037 Add orchestrator routing and config-reload preservation tests</a></summary>",
    "<p>",
    "",
    "Source: `specs/003-multi-project-config/tasks.md`, commit `0f4db1e`.",
    "",
    "Phase: US2 Tests",
    "",
    "## Problem / Goal",
    "",
    "Add orchestrator dispatch and config-reload preservation tests for two Linear projects routing to distinct workspaces, state buckets, and persisted in-progress run contexts in `tests/orchestrator.test.ts`.",
    "",
    "## Issue Contract",
    "",
    "```json",
    '{"schemaVersion":1,"contractVersion":"2026-06-07.1","requirements":[{"id":"REQ-T037","requirement":"Add orchestrator tests proving two Linear projects route to distinct workspaces/state buckets and in-progress contexts survive config reload.","proofHint":"Show active runs keep their persisted projectContextId after reload or definition changes."}]}',
    "```",
    "",
    "## Touched Surfaces",
    "",
    "* Expected repo paths: `tests/orchestrator.test.ts`.",
    "* Surface category: testing, orchestration, persistence/replay.",
    "",
    "## Acceptance Criteria",
    "",
    "* Orchestrator dispatch and reload preservation are tested before implementation.",
    "",
    "## Validation Requirements",
    "",
    "* Run focused orchestrator tests.",
    "",
    "## Promotion Readiness",
    "",
    "* Ready for `dogfood-ready`: no",
    "* Remaining blocker: Operator review required before promotion.",
    "</p>",
    "</details>",
    "<!-- linear-review-link -->",
    "<p><a href=\"https://linear.app/john-halbert/review/eng-392-t037-add-orchestrator-routing-and-config-reload-preservation-68cc104e4ffe\">Review in Linear</a></p>",
    "",
  ].join("\n");
}

function extractDocumentedPythonRawRegex(document: string, detectorName: string): RegExp {
  const escapedDetectorName = detectorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.match(new RegExp(`'${escapedDetectorName}': re\\.compile\\(r'([^']+)'\\),`));

  expect(match, `${detectorName} detector must be documented`).not.toBeNull();
  return new RegExp(match?.[1] ?? "");
}
