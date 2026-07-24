import { describe, expect, it, vi } from "vitest";
import {
  buildIssueRelationshipState,
  mergeIssueSuccessionProgress,
  resolveIssueSuccessionAgreement,
} from "../src/core/IssueRelationshipService.js";
import type { Issue, IssueBlockerRef } from "../src/core/types.js";
import { agentEligibleIssueContract, issue } from "./helpers.js";

const OBSERVED_AT = "2026-07-23T12:00:00.000Z";
const SUCCESSION_ID = "tdd-test-1";

describe("IssueRelationshipService", () => {
  it("normalizes generalized ordering edges without inferring succession", () => {
    const current = issue({
      id: "issue-2",
      identifier: "TEST-2",
      description: agentEligibleIssueContract({
        issueContractDelivery: { mode: "merge" },
        issueContractRelationships: {
          blocks: ["TEST-3"],
          blockedBy: ["TEST-1"],
        },
      }),
      blocks: [issueRef("issue-3", "TEST-3")],
      blockedBy: [issueRef("issue-1", "TEST-1")],
    });

    const state = buildIssueRelationshipState(current, OBSERVED_AT);

    expect(state).toMatchObject({
      issueId: "issue-2",
      issueIdentifier: "TEST-2",
      contractBlocks: ["TEST-3"],
      contractBlockedBy: ["TEST-1"],
      status: "valid",
      validationErrors: [],
      observedAt: OBSERVED_AT,
    });
    expect(state.edges).toEqual([
      {
        type: "blocks",
        sourceIssueId: "issue-1",
        sourceIssueIdentifier: "TEST-1",
        targetIssueId: "issue-2",
        targetIssueIdentifier: "TEST-2",
        declared: true,
        observed: true,
      },
      {
        type: "blocks",
        sourceIssueId: "issue-2",
        sourceIssueIdentifier: "TEST-2",
        targetIssueId: "issue-3",
        targetIssueIdentifier: "TEST-3",
        declared: true,
        observed: true,
      },
    ]);
    expect(state).not.toHaveProperty("succession");
  });

  it("rejects an ordinary contract whose declared graph disagrees with Linear", async () => {
    const current = issue({
      description: agentEligibleIssueContract({
        issueContractRelationships: {
          blocks: ["TEST-2"],
          blockedBy: [],
        },
      }),
      blocks: [],
      blockedBy: [],
    });

    const result = await resolveIssueSuccessionAgreement(current, {
      fetchIssueStatesByIds: vi.fn(async () => [current]),
    });

    expect(result).toMatchObject({
      kind: "invalid",
      succession: null,
      relationshipState: { status: "invalid" },
      errors: [
        "Issue Contract `relationships.blocks` declares edges absent from Linear: TEST-2",
      ],
    });
  });

  it("agrees the same reciprocal succession when resolved from either issue", async () => {
    const source = sourceIssue();
    const target = targetIssue();
    const fetchIssueStatesByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => [source, target].find((candidate) => candidate.id === id)).filter(isIssue),
    );
    const tracker = { fetchIssueStatesByIds };

    const fromSource = await resolveIssueSuccessionAgreement(
      source,
      tracker,
      OBSERVED_AT,
    );
    const fromTarget = await resolveIssueSuccessionAgreement(
      target,
      tracker,
      OBSERVED_AT,
    );

    expect(fetchIssueStatesByIds.mock.calls).toEqual([
      [["issue-1"]],
      [["issue-2"]],
      [["issue-2"]],
      [["issue-1"]],
    ]);
    expect(fromSource).toMatchObject({
      kind: "agreed",
      sourceIssue: { id: "issue-1", identifier: "TEST-1" },
      targetIssue: { id: "issue-2", identifier: "TEST-2" },
      succession: {
        id: SUCCESSION_ID,
        purpose: "expected_red_implementation",
        role: "succeeded",
        status: "agreed",
        linearBlockVerified: true,
        validationErrors: [],
        agreedAt: OBSERVED_AT,
      },
    });
    expect(fromTarget).toMatchObject({
      kind: "agreed",
      sourceIssue: { id: "issue-1", identifier: "TEST-1" },
      targetIssue: { id: "issue-2", identifier: "TEST-2" },
      succession: {
        id: SUCCESSION_ID,
        role: "successor",
        status: "agreed",
        linearBlockVerified: true,
      },
    });
  });

  it("preserves checkpoint linkage when a live agreement is revalidated", async () => {
    const source = sourceIssue();
    const target = targetIssue();
    const tracker = {
      fetchIssueStatesByIds: vi.fn(async (ids: string[]) =>
        ids
          .map((id) =>
            [source, target].find(
              (candidate) =>
                candidate.id === id || candidate.identifier === id,
            ),
          )
          .filter(isIssue),
      ),
    };
    const first = await resolveIssueSuccessionAgreement(
      source,
      tracker,
      OBSERVED_AT,
    );
    const second = await resolveIssueSuccessionAgreement(
      source,
      tracker,
      "2026-07-23T13:00:00.000Z",
    );
    if (first.kind !== "agreed" || second.kind !== "agreed") {
      throw new Error("expected agreed succession");
    }
    const checkpointed = {
      ...first.succession,
      status: "checkpointed" as const,
      artifactId: "artifact-1",
      updatedAt: "2026-07-23T12:30:00.000Z",
    };

    expect(
      mergeIssueSuccessionProgress(checkpointed, second.succession),
    ).toMatchObject({
      status: "checkpointed",
      artifactId: "artifact-1",
      declaredAt: OBSERVED_AT,
      updatedAt: "2026-07-23T13:00:00.000Z",
    });
  });

  it("rejects a one-sided succession declaration", async () => {
    const source = sourceIssue();
    const target = targetIssue({ successionId: null });
    const tracker = {
      fetchIssueStatesByIds: vi.fn(async (ids: string[]) =>
        ids
          .map((id) =>
            [source, target].find(
              (candidate) =>
                candidate.id === id || candidate.identifier === id,
            ),
          )
          .filter(isIssue),
      ),
    };

    const result = await resolveIssueSuccessionAgreement(
      source,
      tracker,
      OBSERVED_AT,
    );

    expect(result).toMatchObject({
      kind: "invalid",
      counterpart: { id: "issue-2", identifier: "TEST-2" },
      succession: {
        id: SUCCESSION_ID,
        status: "invalid",
        linearBlockVerified: true,
      },
    });
    if (result.kind !== "invalid") throw new Error("expected invalid succession");
    expect(result.errors).toContain(
      "Succession counterpart TEST-2 does not declare a reciprocal succession",
    );
  });

  it("finds an explicit incoming succession when the successor omits its local declaration", async () => {
    const source = sourceIssue();
    const target = targetIssue({ successionId: null });
    const tracker = {
      fetchIssueStatesByIds: vi.fn(async (ids: string[]) =>
        ids
          .map((id) =>
            [source, target].find(
              (candidate) =>
                candidate.id === id || candidate.identifier === id,
            ),
          )
          .filter(isIssue),
      ),
    };

    const result = await resolveIssueSuccessionAgreement(
      target,
      tracker,
      OBSERVED_AT,
    );

    expect(tracker.fetchIssueStatesByIds.mock.calls).toEqual([
      [["issue-2"]],
      [["issue-1"]],
    ]);
    expect(result).toMatchObject({
      kind: "invalid",
      issue: { id: "issue-2", identifier: "TEST-2" },
      counterpart: { id: "issue-1", identifier: "TEST-1" },
      succession: {
        id: SUCCESSION_ID,
        role: "successor",
        status: "invalid",
        linearBlockVerified: true,
      },
      errors: [
        expect.stringContaining(
          "does not declare `relationships.succession.succeeds`",
        ),
      ],
    });
  });

  it("rejects reciprocal succession declarations with different ids", async () => {
    const source = sourceIssue();
    const target = targetIssue({ successionId: "tdd-other" });
    const tracker = {
      fetchIssueStatesByIds: vi.fn(async (ids: string[]) =>
        ids
          .map((id) =>
            [source, target].find(
              (candidate) =>
                candidate.id === id || candidate.identifier === id,
            ),
          )
          .filter(isIssue),
      ),
    };

    const result = await resolveIssueSuccessionAgreement(
      source,
      tracker,
      OBSERVED_AT,
    );

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid succession");
    expect(result.errors).toContain(
      `Succession id mismatch: ${SUCCESSION_ID} does not agree with tdd-other`,
    );
    expect(result.succession?.status).toBe("invalid");
  });

  it("rejects a reciprocal succession declared by a legacy counterpart contract", async () => {
    const source = sourceIssue();
    const target = targetIssue();
    target.description = agentEligibleIssueContract({
      issueContractJson: JSON.stringify({
        schemaVersion: 1,
        contractVersion: "2026-07-23.legacy",
        requirements: [
          {
            id: "REQ-001",
            requirement: "Implement the expected-red behavior.",
          },
        ],
        delivery: { mode: "merge" },
        relationships: {
          blocks: [],
          blockedBy: ["TEST-1"],
          succession: {
            id: SUCCESSION_ID,
            purpose: "expected_red_implementation",
            succeeds: { issue: "TEST-1" },
          },
        },
      }),
    });
    const tracker = {
      fetchIssueStatesByIds: vi.fn(async (ids: string[]) =>
        ids
          .map((id) =>
            [source, target].find(
              (candidate) =>
                candidate.id === id || candidate.identifier === id,
            ),
          )
          .filter(isIssue),
      ),
    };

    const result = await resolveIssueSuccessionAgreement(
      source,
      tracker,
      OBSERVED_AT,
    );

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid succession");
    expect(result.errors).toContain(
      "Succession counterpart TEST-2 must use schemaVersion 2 with explicit relationships",
    );
  });

  it("rejects a succession relationship that points back to the same issue", async () => {
    const self = sourceIssue({
      targetId: "issue-1",
      targetIdentifier: "TEST-1",
    });
    const tracker = {
      fetchIssueStatesByIds: vi.fn(async () => [self]),
    };

    const result = await resolveIssueSuccessionAgreement(
      self,
      tracker,
      OBSERVED_AT,
    );

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid succession");
    expect(result.errors).toContain("An issue cannot succeed itself");
  });

  it("resolves only the declared successor when the source also blocks an ordinary dependent", async () => {
    const source = sourceIssue({
      ordinaryDependentId: "issue-99",
      ordinaryDependentIdentifier: "TEST-99",
    });
    const target = targetIssue();
    const unrelated = issue({
      id: "issue-99",
      identifier: "TEST-99",
      description: agentEligibleIssueContract({
        issueContractDelivery: { mode: "merge" },
        issueContractRelationships: {
          blocks: [],
          blockedBy: ["TEST-1"],
        },
      }),
      blocks: [],
      blockedBy: [issueRef("issue-1", "TEST-1")],
    });
    const fetchIssueStatesByIds = vi.fn(async (ids: string[]) =>
      ids
        .map((id) =>
          [source, target, unrelated].find(
            (candidate) =>
              candidate.id === id || candidate.identifier === id,
          ),
        )
        .filter(isIssue),
    );

    const result = await resolveIssueSuccessionAgreement(
      source,
      { fetchIssueStatesByIds },
      OBSERVED_AT,
    );

    expect(fetchIssueStatesByIds).toHaveBeenCalledTimes(2);
    expect(fetchIssueStatesByIds).toHaveBeenNthCalledWith(1, ["issue-1"]);
    expect(fetchIssueStatesByIds).toHaveBeenNthCalledWith(2, ["issue-2"]);
    expect(result).toMatchObject({
      kind: "agreed",
      targetIssue: { id: "issue-2", identifier: "TEST-2" },
      succession: {
        successorIssue: { id: "issue-2", identifier: "TEST-2" },
        status: "agreed",
      },
      relationshipState: {
        status: "valid",
        contractBlocks: ["TEST-2", "TEST-99"],
      },
    });
    expect(result.relationshipState.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIssueId: "issue-1",
          targetIssueId: "issue-2",
          declared: true,
          observed: true,
        }),
        expect.objectContaining({
          sourceIssueId: "issue-1",
          targetIssueId: "issue-99",
          declared: true,
          observed: true,
        }),
      ]),
    );
  });

  it("keeps succession agreed when an unrelated ordering edge drifts", async () => {
    const source = sourceIssue({
      ordinaryDependentId: "issue-99",
      ordinaryDependentIdentifier: "TEST-99",
    });
    source.blocks = (source.blocks ?? []).filter(
      (edge) => edge.identifier !== "TEST-99",
    );
    const target = targetIssue();
    const fetchIssueStatesByIds = vi.fn(async (ids: string[]) =>
      ids
        .map((id) =>
          [source, target].find(
            (candidate) =>
              candidate.id === id || candidate.identifier === id,
          ),
        )
        .filter(isIssue),
    );

    const result = await resolveIssueSuccessionAgreement(
      source,
      { fetchIssueStatesByIds },
      OBSERVED_AT,
    );

    expect(result).toMatchObject({
      kind: "invalid",
      relationshipState: {
        status: "invalid",
      },
      succession: {
        id: SUCCESSION_ID,
        status: "agreed",
        linearBlockVerified: true,
        validationErrors: [],
      },
    });
    if (result.kind !== "invalid") throw new Error("expected graph invalidity");
    expect(result.errors).toContain(
      "Issue Contract `relationships.blocks` declares edges absent from Linear: TEST-99",
    );
  });
});

function sourceIssue(
  options: {
    targetId?: string;
    targetIdentifier?: string;
    ordinaryDependentId?: string;
    ordinaryDependentIdentifier?: string;
  } = {},
): Issue {
  const targetId = options.targetId ?? "issue-2";
  const targetIdentifier = options.targetIdentifier ?? "TEST-2";
  const ordinaryDependent =
    options.ordinaryDependentId && options.ordinaryDependentIdentifier
      ? issueRef(
          options.ordinaryDependentId,
          options.ordinaryDependentIdentifier,
        )
      : null;
  const blocks = [
    issueRef(targetId, targetIdentifier),
    ...(ordinaryDependent === null ? [] : [ordinaryDependent]),
  ];
  return issue({
    id: "issue-1",
    identifier: "TEST-1",
    description: agentEligibleIssueContract({
      issueContractDelivery: {
        mode: "accepted_artifact",
        artifact: "expected_red_tests",
      },
      issueContractRelationships: {
        blocks: blocks.map((edge) => edge.identifier!),
        blockedBy: [],
        succession: {
          id: SUCCESSION_ID,
          purpose: "expected_red_implementation",
          successor: { issue: targetIdentifier },
        },
      },
    }),
    blocks,
    blockedBy: [],
  });
}

function targetIssue(
  options: {
    successionId?: string | null;
  } = {},
): Issue {
  const successionId =
    options.successionId === undefined ? SUCCESSION_ID : options.successionId;
  return issue({
    id: "issue-2",
    identifier: "TEST-2",
    description: agentEligibleIssueContract({
      issueContractDelivery: { mode: "merge" },
      issueContractRelationships: {
        blocks: [],
        blockedBy: ["TEST-1"],
        ...(successionId === null
          ? {}
          : {
              succession: {
                id: successionId,
                purpose: "expected_red_implementation" as const,
                succeeds: { issue: "TEST-1" },
              },
            }),
      },
    }),
    blocks: [],
    blockedBy: [issueRef("issue-1", "TEST-1")],
  });
}

function issueRef(id: string, identifier: string): IssueBlockerRef {
  return { id, identifier, state: "Todo" };
}

function isIssue(value: Issue | undefined): value is Issue {
  return value !== undefined;
}
