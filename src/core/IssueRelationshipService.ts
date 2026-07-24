import {
  issueReferenceMatches,
  parseIssueContract,
  validateIssueContractRelationshipsAgainstIssue,
  type ParsedIssueContractSnapshot,
} from "./IssueContractLint.js";
import type {
  IssueRelationshipEdgeState,
  IssueRelationshipState,
  IssueSuccessionRecord,
} from "./persistence/IssueLifecycleStore.js";
import type { TrackerClient } from "./tracker/TrackerClient.js";
import type { Issue, IssueBlockerRef } from "./types.js";

export type IssueSuccessionAgreementResult =
  | {
      kind: "none";
      issue: Issue;
      relationshipState: IssueRelationshipState;
    }
  | {
      kind: "invalid";
      issue: Issue;
      counterpart: Issue | null;
      errors: string[];
      relationshipState: IssueRelationshipState;
      succession: IssueSuccessionRecord | null;
    }
  | {
      kind: "agreed";
      issue: Issue;
      sourceIssue: Issue;
      targetIssue: Issue;
      sourceContract: ParsedIssueContractSnapshot;
      targetContract: ParsedIssueContractSnapshot;
      relationshipState: IssueRelationshipState;
      succession: IssueSuccessionRecord;
    };

export function buildIssueRelationshipState(
  issue: Issue,
  observedAt = new Date().toISOString(),
): IssueRelationshipState {
  const parsedResult = parseIssueContract(issue.description);
  let parseErrors: string[] = [];
  let parsed: ParsedIssueContractSnapshot | null = null;
  if (parsedResult.valid) {
    parsed = {
      ...parsedResult.contract,
      document: parsedResult.contract,
      canonicalJson: parsedResult.canonicalJson,
      fingerprint: parsedResult.fingerprint,
    };
  } else {
    parseErrors = parsedResult.errors;
  }
  const localErrors =
    parsed === null
      ? parseErrors
      : validateIssueContractRelationshipsAgainstIssue(issue);
  const contractBlocks = parsed?.relationships?.blocks ?? [];
  const contractBlockedBy = parsed?.relationships?.blockedBy ?? [];
  const trackerBlocks = cloneIssueRefs(issue.blocks ?? []);
  const trackerBlockedBy = cloneIssueRefs(issue.blockedBy);

  return {
    version: 1,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    contractSchemaVersion: parsed?.schemaVersion ?? null,
    contractFingerprint: parsed?.fingerprint ?? null,
    contractBlocks: [...contractBlocks].sort(compareIssueReferences),
    contractBlockedBy: [...contractBlockedBy].sort(compareIssueReferences),
    trackerBlocks,
    trackerBlockedBy,
    edges: normalizeRelationshipEdges({
      issue,
      contractBlocks,
      contractBlockedBy,
      trackerBlocks,
      trackerBlockedBy,
    }),
    status:
      parsed !== null && parsed.schemaVersion === 1
        ? "legacy"
        : localErrors.length === 0
          ? "valid"
          : "invalid",
    validationErrors: [...localErrors],
    observedAt,
  };
}

export function buildDeclaredIssueSuccessionRecord(
  issue: Issue,
  observedAt = new Date().toISOString(),
): IssueSuccessionRecord | null {
  const parsed = parseSnapshot(issue);
  if (parsed?.schemaVersion !== 2) return null;
  const declaration = parsed.relationships?.succession;
  if (!declaration) return null;
  if (declaration.successor !== undefined) {
    const targetReference = declaration.successor.issue;
    const targetEdge =
      (issue.blocks ?? []).find((edge) =>
        issueReferenceMatches(targetReference, edge),
      ) ?? null;
    return {
      version: 1,
      id: declaration.id,
      purpose: declaration.purpose,
      role: "succeeded",
      succeededIssue: {
        id: issue.id,
        identifier: issue.identifier,
        contractFingerprint: parsed.fingerprint,
      },
      successorIssue: {
        id: targetEdge?.id ?? null,
        identifier: targetEdge?.identifier ?? targetReference,
        contractFingerprint: null,
      },
      linearBlockVerified: false,
      status: "declared",
      artifactId: null,
      workspaceSeedId: null,
      mergeCommitSha: null,
      validationErrors: [],
      declaredAt: observedAt,
      agreedAt: null,
      updatedAt: observedAt,
    };
  }
  const sourceReference = declaration.succeeds.issue;
  const sourceEdge =
    issue.blockedBy.find((edge) =>
      issueReferenceMatches(sourceReference, edge),
    ) ?? null;
  return {
    version: 1,
    id: declaration.id,
    purpose: declaration.purpose,
    role: "successor",
    succeededIssue: {
      id: sourceEdge?.id ?? null,
      identifier: sourceEdge?.identifier ?? sourceReference,
      contractFingerprint: null,
    },
    successorIssue: {
      id: issue.id,
      identifier: issue.identifier,
      contractFingerprint: parsed.fingerprint,
    },
    linearBlockVerified: false,
    status: "declared",
    artifactId: null,
    workspaceSeedId: null,
    mergeCommitSha: null,
    validationErrors: [],
    declaredAt: observedAt,
    agreedAt: null,
    updatedAt: observedAt,
  };
}

export async function resolveIssueSuccessionAgreement(
  issue: Issue,
  tracker: Pick<TrackerClient, "fetchIssueStatesByIds">,
  observedAt = new Date().toISOString(),
): Promise<IssueSuccessionAgreementResult> {
  const refreshedIssues = await tracker.fetchIssueStatesByIds([issue.id]);
  const refreshedIssue =
    refreshedIssues.find(
      (candidate) =>
        candidate.id === issue.id ||
        candidate.identifier.toLowerCase() === issue.identifier.toLowerCase(),
    ) ?? null;
  if (refreshedIssue === null) {
    const relationshipState = buildIssueRelationshipState(issue, observedAt);
    return {
      kind: "invalid",
      issue,
      counterpart: null,
      errors: [
        `Current issue ${issue.identifier} could not be refreshed from the tracker`,
      ],
      relationshipState: {
        ...relationshipState,
        status: "invalid",
        validationErrors: [
          ...relationshipState.validationErrors,
          `Current issue ${issue.identifier} could not be refreshed from the tracker`,
        ],
      },
      succession: null,
    };
  }
  issue = refreshedIssue;
  const relationshipState = buildIssueRelationshipState(issue, observedAt);
  const parsed = parseSnapshot(issue);
  const relationshipGateErrors =
    relationshipState.status === "legacy"
      ? ["Issue Contract must use schemaVersion 2 with explicit relationships"]
      : [...relationshipState.validationErrors];
  if (parsed === null) {
    return {
      kind: "invalid",
      issue,
      counterpart: null,
      errors:
        relationshipGateErrors.length > 0
          ? relationshipGateErrors
          : ["Issue Contract is missing or invalid"],
      relationshipState,
      succession: null,
    };
  }
  const succession = parsed?.relationships?.succession;
  if (succession === undefined) {
    const incoming = await findIncomingSuccessionDeclarations(
      issue,
      tracker,
    );
    if (incoming.missingReferences.length > 0) {
      const missingErrors = incoming.missingReferences.map(
        (reference) =>
          `Blocked-by issue ${reference} could not be inspected for an incoming succession declaration`,
      );
      return {
        kind: "invalid",
        issue,
        counterpart: null,
        errors: [...relationshipGateErrors, ...missingErrors],
        relationshipState,
        succession: null,
      };
    }
    if (incoming.sources.length > 0) {
      const [sourceIssue] = incoming.sources;
      if (!sourceIssue) {
        throw new Error("Incoming succession source resolution was empty");
      }
      const sourceContract = parseSnapshot(sourceIssue);
      const sourceDeclaration =
        sourceContract?.relationships?.succession;
      const successionErrors = [
        `Issue ${issue.identifier} does not declare \`relationships.succession.succeeds\`, but ${sourceIssue.identifier} explicitly declares it as a successor`,
        ...(incoming.sources.length > 1
          ? [
              `Multiple issues explicitly declare ${issue.identifier} as their successor: ${incoming.sources
                .map((candidate) => candidate.identifier)
                .join(", ")}`,
            ]
          : []),
      ];
      const sourceRelationshipState =
        buildIssueRelationshipState(sourceIssue, observedAt);
      const relationshipErrors = [
        ...relationshipGateErrors,
        ...(sourceRelationshipState.status === "legacy"
          ? [
              `Succession source ${sourceIssue.identifier} must use schemaVersion 2 with explicit relationships`,
            ]
          : sourceRelationshipState.validationErrors),
      ];
      if (
        !issueHasRelationship(sourceIssue.blocks ?? [], issue) ||
        !issueHasRelationship(issue.blockedBy, sourceIssue)
      ) {
        successionErrors.push(
          `Linear must contain the independent block edge ${sourceIssue.identifier} blocks ${issue.identifier}`,
        );
      }
      const successionRecord = buildSuccessionRecord({
        issue,
        sourceIssue,
        targetIssue: issue,
        sourceContract,
        targetContract: parsed,
        successionId:
          sourceDeclaration?.id ??
          `invalid-incoming-${sourceIssue.identifier}-${issue.identifier}`,
        errors: successionErrors,
        observedAt,
      });
      return {
        kind: "invalid",
        issue,
        counterpart: sourceIssue,
        errors: [...relationshipErrors, ...successionErrors],
        relationshipState,
        succession: successionRecord,
      };
    }
    if (relationshipGateErrors.length > 0) {
      return {
        kind: "invalid",
        issue,
        counterpart: null,
        errors: relationshipGateErrors,
        relationshipState,
        succession: null,
      };
    }
    return { kind: "none", issue, relationshipState };
  }

  const sourceRole = succession.successor !== undefined;
  const counterpartReference =
    succession.successor?.issue ?? succession.succeeds?.issue;
  if (counterpartReference === undefined) {
    return { kind: "none", issue, relationshipState };
  }
  const orderingRefs = sourceRole ? issue.blocks ?? [] : issue.blockedBy;
  const orderingRef =
    orderingRefs.find((edge) => issueReferenceMatches(counterpartReference, edge)) ?? null;
  const fetchReference = orderingRef?.id ?? orderingRef?.identifier ?? counterpartReference;
  const [counterpart] = await tracker.fetchIssueStatesByIds([fetchReference]);

  const relationshipErrors: string[] = [...relationshipGateErrors];
  const successionErrors: string[] = [];
  if (orderingRef === null) {
    successionErrors.push(
      `Linear ${sourceRole ? "blocks" : "blockedBy"} does not contain succession counterpart ${counterpartReference}`,
    );
  }
  if (counterpart === undefined) {
    successionErrors.push(`Succession counterpart ${counterpartReference} could not be loaded from the tracker`);
  }

  const counterpartContract = counterpart === undefined ? null : parseSnapshot(counterpart);
  if (counterpart !== undefined && counterpartContract === null) {
    successionErrors.push(`Succession counterpart ${counterpart.identifier} has an invalid Issue Contract`);
  }

  const counterpartSuccession = counterpartContract?.relationships?.succession;
  if (counterpartContract !== null && counterpartSuccession === undefined) {
    successionErrors.push(
      `Succession counterpart ${counterpart?.identifier ?? counterpartReference} does not declare a reciprocal succession`,
    );
  } else if (counterpartSuccession !== undefined) {
    if (counterpartSuccession.id !== succession.id) {
      successionErrors.push(
        `Succession id mismatch: ${succession.id} does not agree with ${counterpartSuccession.id}`,
      );
    }
    if (counterpartSuccession.purpose !== succession.purpose) {
      successionErrors.push(
        `Succession purpose mismatch: ${succession.purpose} does not agree with ${counterpartSuccession.purpose}`,
      );
    }
    const expectedCounterpartRole = sourceRole ? "succeeds" : "successor";
    if (!(expectedCounterpartRole in counterpartSuccession)) {
      successionErrors.push(
        `Succession counterpart must declare \`relationships.succession.${expectedCounterpartRole}\``,
      );
    } else {
      const reciprocalReference =
        expectedCounterpartRole === "succeeds"
          ? (
              counterpartSuccession as {
                succeeds: { issue: string };
              }
            ).succeeds.issue
          : (
              counterpartSuccession as {
                successor: { issue: string };
              }
            ).successor.issue;
      if (!issueReferenceMatches(reciprocalReference, issue)) {
        successionErrors.push(
          `Succession counterpart points to ${reciprocalReference}, not ${issue.identifier}`,
        );
      }
    }
  }

  if (counterpart !== undefined && counterpartContract !== null) {
    const counterpartRelationshipState = buildIssueRelationshipState(
      counterpart,
      observedAt,
    );
    if (counterpartRelationshipState.status === "legacy") {
      relationshipErrors.push(
        `Succession counterpart ${counterpart.identifier} must use schemaVersion 2 with explicit relationships`,
      );
    } else {
      relationshipErrors.push(
        ...counterpartRelationshipState.validationErrors,
      );
    }
  }

  const sourceIssue = sourceRole ? issue : counterpart ?? issue;
  const targetIssue = sourceRole ? counterpart ?? issue : issue;
  const sourceContract = sourceRole ? parsed : counterpartContract;
  const targetContract = sourceRole ? counterpartContract : parsed;

  if (
    sourceIssue.id === targetIssue.id ||
    sourceIssue.identifier.toLowerCase() === targetIssue.identifier.toLowerCase()
  ) {
    successionErrors.push("An issue cannot succeed itself");
  }
  if (
    !issueHasRelationship(sourceIssue.blocks ?? [], targetIssue) ||
    !issueHasRelationship(targetIssue.blockedBy, sourceIssue)
  ) {
    successionErrors.push(
      `Linear must contain the independent block edge ${sourceIssue.identifier} blocks ${targetIssue.identifier}`,
    );
  }
  if (sourceContract?.delivery.mode !== "accepted_artifact") {
    successionErrors.push("The succeeded issue must deliver expected-red tests as an accepted artifact");
  }
  if (targetContract?.delivery.mode !== "merge") {
    successionErrors.push("The successor issue must use merge delivery");
  }

  const errors = [...relationshipErrors, ...successionErrors];
  const successionRecord = buildSuccessionRecord({
    issue,
    sourceIssue,
    targetIssue,
    sourceContract,
    targetContract,
    successionId: succession.id,
    errors: successionErrors,
    observedAt,
  });
  if (
    errors.length > 0 ||
    counterpart === undefined ||
    sourceContract === null ||
    targetContract === null
  ) {
    return {
      kind: "invalid",
      issue,
      counterpart: counterpart ?? null,
      errors,
      relationshipState,
      succession: successionRecord,
    };
  }
  return {
    kind: "agreed",
    issue,
    sourceIssue,
    targetIssue,
    sourceContract,
    targetContract,
    relationshipState,
    succession: successionRecord,
  };
}

export function mergeIssueSuccessionProgress(
  existing: IssueSuccessionRecord | null | undefined,
  observed: IssueSuccessionRecord,
): IssueSuccessionRecord {
  if (
    existing === null ||
    existing === undefined ||
    existing.status === "invalid" ||
    observed.status === "invalid" ||
    !sameIssueSuccessionBinding(existing, observed)
  ) {
    return observed;
  }
  const existingRank = successionStatusRank(existing.status);
  const observedRank = successionStatusRank(observed.status);
  return {
    ...observed,
    status: existingRank > observedRank ? existing.status : observed.status,
    artifactId: observed.artifactId ?? existing.artifactId,
    workspaceSeedId: observed.workspaceSeedId ?? existing.workspaceSeedId,
    mergeCommitSha: observed.mergeCommitSha ?? existing.mergeCommitSha,
    declaredAt: existing.declaredAt,
    agreedAt: existing.agreedAt ?? observed.agreedAt,
  };
}

async function findIncomingSuccessionDeclarations(
  issue: Issue,
  tracker: Pick<TrackerClient, "fetchIssueStatesByIds">,
): Promise<{
  sources: Issue[];
  missingReferences: string[];
}> {
  const references = issue.blockedBy.map((edge, index) => ({
    edge,
    lookup: edge.id ?? edge.identifier,
    label: edge.identifier ?? edge.id ?? `blockedBy[${index}]`,
  }));
  const lookups = [
    ...new Set(
      references
        .map((reference) => reference.lookup)
        .filter((value): value is string => value !== null),
    ),
  ];
  const loaded =
    lookups.length === 0
      ? []
      : await tracker.fetchIssueStatesByIds(lookups);
  const missingReferences = references
    .filter(
      ({ edge, lookup }) =>
        lookup === null ||
        !loaded.some(
          (candidate) =>
            (edge.id !== null && candidate.id === edge.id) ||
            (edge.identifier !== null &&
              candidate.identifier.toLowerCase() ===
                edge.identifier.toLowerCase()),
        ),
    )
    .map((reference) => reference.label);
  const sources = loaded
    .filter((candidate) => {
      const contract = parseSnapshot(candidate);
      const declaration = contract?.relationships?.succession;
      return (
        declaration?.successor !== undefined &&
        issueReferenceMatches(declaration.successor.issue, issue)
      );
    })
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex(
          (other) =>
            other.id === candidate.id ||
            other.identifier.toLowerCase() ===
              candidate.identifier.toLowerCase(),
        ) === index,
    )
    .sort((left, right) =>
      left.identifier.localeCompare(right.identifier),
    );
  return { sources, missingReferences };
}

function parseSnapshot(issue: Issue): ParsedIssueContractSnapshot | null {
  const result = parseIssueContract(issue.description);
  if (!result.valid) return null;
  return {
    ...result.contract,
    document: result.contract,
    canonicalJson: result.canonicalJson,
    fingerprint: result.fingerprint,
  };
}

export function sameIssueSuccessionBinding(
  left: IssueSuccessionRecord,
  right: IssueSuccessionRecord,
): boolean {
  return (
    sameIssueSuccessionIdentity(left, right) &&
    left.role === right.role &&
    sameSuccessionIssueRef(left.succeededIssue, right.succeededIssue) &&
    sameSuccessionIssueRef(left.successorIssue, right.successorIssue)
  );
}

/**
 * Compares the durable identity of a succession agreement without treating
 * issue-local role or contract-observation fingerprints as part of that
 * identity. This is intentionally narrower than blocker adjacency: both
 * records must already name the same explicit succession and endpoints.
 */
export function sameIssueSuccessionIdentity(
  left: IssueSuccessionRecord,
  right: IssueSuccessionRecord,
): boolean {
  return (
    left.id === right.id &&
    left.purpose === right.purpose &&
    sameSuccessionIssueIdentity(
      left.succeededIssue,
      right.succeededIssue,
    ) &&
    sameSuccessionIssueIdentity(
      left.successorIssue,
      right.successorIssue,
    )
  );
}

function sameSuccessionIssueRef(
  left: IssueSuccessionRecord["succeededIssue"],
  right: IssueSuccessionRecord["succeededIssue"],
): boolean {
  return (
    left.id === right.id &&
    left.identifier.toLowerCase() === right.identifier.toLowerCase() &&
    left.contractFingerprint === right.contractFingerprint
  );
}

function sameSuccessionIssueIdentity(
  left: IssueSuccessionRecord["succeededIssue"],
  right: IssueSuccessionRecord["succeededIssue"],
): boolean {
  if (left.id !== null && right.id !== null) return left.id === right.id;
  return (
    left.identifier.toLowerCase() === right.identifier.toLowerCase()
  );
}

function successionStatusRank(
  status: Exclude<IssueSuccessionRecord["status"], "invalid">,
): number {
  switch (status) {
    case "declared":
      return 0;
    case "agreed":
      return 1;
    case "checkpointed":
      return 2;
    case "seeded":
      return 3;
    case "verified_green":
      return 4;
    case "integrated":
      return 5;
  }
}

function buildSuccessionRecord(input: {
  issue: Issue;
  sourceIssue: Issue;
  targetIssue: Issue;
  sourceContract: ParsedIssueContractSnapshot | null;
  targetContract: ParsedIssueContractSnapshot | null;
  successionId: string;
  errors: readonly string[];
  observedAt: string;
}): IssueSuccessionRecord {
  return {
    version: 1,
    id: input.successionId,
    purpose: "expected_red_implementation",
    role: input.issue.id === input.sourceIssue.id ? "succeeded" : "successor",
    succeededIssue: {
      id: input.sourceIssue.id,
      identifier: input.sourceIssue.identifier,
      contractFingerprint: input.sourceContract?.fingerprint ?? null,
    },
    successorIssue: {
      id: input.targetIssue.id,
      identifier: input.targetIssue.identifier,
      contractFingerprint: input.targetContract?.fingerprint ?? null,
    },
    linearBlockVerified:
      issueHasRelationship(input.sourceIssue.blocks ?? [], input.targetIssue) &&
      issueHasRelationship(input.targetIssue.blockedBy, input.sourceIssue),
    status: input.errors.length === 0 ? "agreed" : "invalid",
    artifactId: null,
    workspaceSeedId: null,
    mergeCommitSha: null,
    validationErrors: [...input.errors],
    declaredAt: input.observedAt,
    agreedAt: input.errors.length === 0 ? input.observedAt : null,
    updatedAt: input.observedAt,
  };
}

function normalizeRelationshipEdges(input: {
  issue: Issue;
  contractBlocks: readonly string[];
  contractBlockedBy: readonly string[];
  trackerBlocks: readonly IssueBlockerRef[];
  trackerBlockedBy: readonly IssueBlockerRef[];
}): IssueRelationshipEdgeState[] {
  const edges = new Map<string, IssueRelationshipEdgeState>();
  for (const reference of input.contractBlocks) {
    const observed =
      input.trackerBlocks.find((edge) => issueReferenceMatches(reference, edge)) ?? null;
    addEdge(edges, {
      type: "blocks",
      sourceIssueId: input.issue.id,
      sourceIssueIdentifier: input.issue.identifier,
      targetIssueId: observed?.id ?? null,
      targetIssueIdentifier: observed?.identifier ?? reference,
      declared: true,
      observed: observed !== null,
    });
  }
  for (const observed of input.trackerBlocks) {
    addEdge(edges, {
      type: "blocks",
      sourceIssueId: input.issue.id,
      sourceIssueIdentifier: input.issue.identifier,
      targetIssueId: observed.id,
      targetIssueIdentifier: observed.identifier,
      declared: input.contractBlocks.some((reference) =>
        issueReferenceMatches(reference, observed),
      ),
      observed: true,
    });
  }
  for (const reference of input.contractBlockedBy) {
    const observed =
      input.trackerBlockedBy.find((edge) => issueReferenceMatches(reference, edge)) ?? null;
    addEdge(edges, {
      type: "blocks",
      sourceIssueId: observed?.id ?? null,
      sourceIssueIdentifier: observed?.identifier ?? reference,
      targetIssueId: input.issue.id,
      targetIssueIdentifier: input.issue.identifier,
      declared: true,
      observed: observed !== null,
    });
  }
  for (const observed of input.trackerBlockedBy) {
    addEdge(edges, {
      type: "blocks",
      sourceIssueId: observed.id,
      sourceIssueIdentifier: observed.identifier,
      targetIssueId: input.issue.id,
      targetIssueIdentifier: input.issue.identifier,
      declared: input.contractBlockedBy.some((reference) =>
        issueReferenceMatches(reference, observed),
      ),
      observed: true,
    });
  }
  return [...edges.values()].sort((left, right) =>
    edgeKey(left).localeCompare(edgeKey(right)),
  );
}

function addEdge(
  edges: Map<string, IssueRelationshipEdgeState>,
  edge: IssueRelationshipEdgeState,
): void {
  const key = edgeKey(edge);
  const existing = edges.get(key);
  edges.set(
    key,
    existing === undefined
      ? edge
      : {
          ...existing,
          declared: existing.declared || edge.declared,
          observed: existing.observed || edge.observed,
          sourceIssueId: existing.sourceIssueId ?? edge.sourceIssueId,
          sourceIssueIdentifier:
            existing.sourceIssueIdentifier ?? edge.sourceIssueIdentifier,
          targetIssueId: existing.targetIssueId ?? edge.targetIssueId,
          targetIssueIdentifier:
            existing.targetIssueIdentifier ?? edge.targetIssueIdentifier,
        },
  );
}

function edgeKey(edge: IssueRelationshipEdgeState): string {
  return `${edge.sourceIssueId ?? edge.sourceIssueIdentifier ?? "unknown"}->${
    edge.targetIssueId ?? edge.targetIssueIdentifier ?? "unknown"
  }`.toLowerCase();
}

function issueHasRelationship(
  relationships: readonly IssueBlockerRef[],
  issue: Pick<Issue, "id" | "identifier">,
): boolean {
  return relationships.some(
    (edge) =>
      edge.id === issue.id ||
      edge.identifier?.toLowerCase() === issue.identifier.toLowerCase(),
  );
}

function cloneIssueRefs(refs: readonly IssueBlockerRef[]): IssueBlockerRef[] {
  return refs
    .map((ref) => ({ ...ref }))
    .sort((left, right) =>
      (left.identifier ?? left.id ?? "").localeCompare(
        right.identifier ?? right.id ?? "",
      ),
    );
}

function compareIssueReferences(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}
