#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { buildIssueHandoffState, type IssueCompletionReportRecord, type IssueLifecyclePhase, type IssueLifecycleRecord, type IssueLifecycleSummaryPointers, type IssueReviewVerdictRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import type { RunRecord, RunStatus, TranscriptEvent, WorkspaceRecord } from "../src/core/persistence/RunTranscriptStore.js";
import type { WritebackOperation, WritebackStatus } from "../src/core/writeback/WritebackOutbox.js";
import { runKindForPhase, type AgentRunPhase, type AgentRunRole } from "../src/core/types.js";

const DEFAULT_OPTIONS = {
  outputDir: path.resolve(process.cwd(), ".symphony-fixtures", "large-history"),
  issueCount: 200,
  runsPerIssue: 5,
  eventsPerRun: 40,
  writebacksPerIssue: 3,
  baseTimestamp: "2026-01-01T00:00:00.000Z",
  issuePrefix: "FIX",
  force: false,
  allowDestructiveOverwrite: false,
} as const;

export interface LargeHistoryFixtureOptions {
  outputDir?: string;
  issueCount?: number;
  runsPerIssue?: number;
  eventsPerRun?: number;
  writebacksPerIssue?: number;
  baseTimestamp?: string;
  issuePrefix?: string;
  force?: boolean;
  allowDestructiveOverwrite?: boolean;
}

interface NormalizedLargeHistoryFixtureOptions {
  outputDir: string;
  issueCount: number;
  runsPerIssue: number;
  eventsPerRun: number;
  writebacksPerIssue: number;
  baseTimestamp: string;
  issuePrefix: string;
  force: boolean;
  allowDestructiveOverwrite: boolean;
}

export interface LargeHistoryFixtureIssueSummary {
  id: string;
  identifier: string;
  workspaceKey: string;
  runIds: string[];
}

export interface LargeHistoryFixtureManifest {
  version: 1;
  generator: "scripts/generate-large-history-fixture.ts";
  generatedAt: string;
  stateDir: string;
  options: {
    issueCount: number;
    runsPerIssue: number;
    eventsPerRun: number;
    writebacksPerIssue: number;
    baseTimestamp: string;
    issuePrefix: string;
  };
  counts: {
    issues: number;
    workspaces: number;
    lifecycleRecords: number;
    runs: number;
    transcriptEvents: number;
    writebackOperations: number;
  };
  apiHints: {
    historyEndpoint: string;
    issueHistoryEndpointTemplate: string;
    transcriptEndpointTemplate: string;
    stateDirUsage: string;
  };
  issues: LargeHistoryFixtureIssueSummary[];
}

interface FixtureIssueBuildResult {
  issue: LargeHistoryFixtureIssueSummary;
  runs: RunRecord[];
  transcriptEvents: number;
  writebackOperations: number;
}

class FixtureOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureOptionError";
  }
}

export async function generateLargeHistoryFixture(
  input: LargeHistoryFixtureOptions = {},
): Promise<LargeHistoryFixtureManifest> {
  const options = normalizeOptions(input);
  await prepareOutputDirectory(options.outputDir, options.force, options.allowDestructiveOverwrite);

  const baseMs = Date.parse(options.baseTimestamp);
  const issues: LargeHistoryFixtureIssueSummary[] = [];
  let runCount = 0;
  let transcriptEventCount = 0;
  let writebackOperationCount = 0;

  for (let issueIndex = 0; issueIndex < options.issueCount; issueIndex += 1) {
    const result = await writeFixtureIssue(options, issueIndex, baseMs);
    issues.push(result.issue);
    runCount += result.runs.length;
    transcriptEventCount += result.transcriptEvents;
    writebackOperationCount += result.writebackOperations;
  }

  const manifest: LargeHistoryFixtureManifest = {
    version: 1,
    generator: "scripts/generate-large-history-fixture.ts",
    generatedAt: iso(baseMs),
    stateDir: options.outputDir,
    options: {
      issueCount: options.issueCount,
      runsPerIssue: options.runsPerIssue,
      eventsPerRun: options.eventsPerRun,
      writebacksPerIssue: options.writebacksPerIssue,
      baseTimestamp: iso(baseMs),
      issuePrefix: options.issuePrefix,
    },
    counts: {
      issues: options.issueCount,
      workspaces: options.issueCount,
      lifecycleRecords: options.issueCount,
      runs: runCount,
      transcriptEvents: transcriptEventCount,
      writebackOperations: writebackOperationCount,
    },
    apiHints: {
      historyEndpoint: "/api/v1/web/history?limit=100&offset=0",
      issueHistoryEndpointTemplate: "/api/v1/web/history?issue={issueIdentifier}&limit=100&offset=0",
      transcriptEndpointTemplate: "/api/v1/web/sessions/{sessionId}/transcript?limit=100&offset=0",
      stateDirUsage: "Point workspace.state_dir at this directory, then start the Symphony status server and browse /api/v1/web/history.",
    },
    issues,
  };

  await writeJson(path.join(options.outputDir, "large-history-fixture-manifest.json"), manifest);
  return manifest;
}

function normalizeOptions(input: LargeHistoryFixtureOptions): NormalizedLargeHistoryFixtureOptions {
  const outputDir = path.resolve(input.outputDir ?? DEFAULT_OPTIONS.outputDir);
  const issueCount = positiveInteger(input.issueCount ?? DEFAULT_OPTIONS.issueCount, "issueCount");
  const runsPerIssue = positiveInteger(input.runsPerIssue ?? DEFAULT_OPTIONS.runsPerIssue, "runsPerIssue");
  const eventsPerRun = nonNegativeInteger(input.eventsPerRun ?? DEFAULT_OPTIONS.eventsPerRun, "eventsPerRun");
  const writebacksPerIssue = nonNegativeInteger(
    input.writebacksPerIssue ?? DEFAULT_OPTIONS.writebacksPerIssue,
    "writebacksPerIssue",
  );
  const baseTimestamp = input.baseTimestamp ?? DEFAULT_OPTIONS.baseTimestamp;
  const baseMs = Date.parse(baseTimestamp);
  if (!Number.isFinite(baseMs)) throw new FixtureOptionError(`baseTimestamp must be a valid ISO timestamp: ${baseTimestamp}`);
  const issuePrefix = sanitizeIssuePrefix(input.issuePrefix ?? DEFAULT_OPTIONS.issuePrefix);
  return {
    outputDir,
    issueCount,
    runsPerIssue,
    eventsPerRun,
    writebacksPerIssue,
    baseTimestamp: iso(baseMs),
    issuePrefix,
    force: input.force ?? DEFAULT_OPTIONS.force,
    allowDestructiveOverwrite: input.allowDestructiveOverwrite ?? DEFAULT_OPTIONS.allowDestructiveOverwrite,
  };
}

async function prepareOutputDirectory(outputDir: string, force: boolean, allowDestructiveOverwrite: boolean): Promise<void> {
  const exists = await pathExists(outputDir);
  if (!exists) {
    await fs.mkdir(outputDir, { recursive: true });
    return;
  }
  const entries = await fs.readdir(outputDir);
  if (entries.length === 0) return;
  if (!force) {
    throw new FixtureOptionError(`Output directory is not empty: ${outputDir}. Pass --force to replace a fixture directory.`);
  }
  assertSafeForceTarget(outputDir, allowDestructiveOverwrite);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
}

function assertSafeForceTarget(outputDir: string, allowDestructiveOverwrite: boolean): void {
  const normalized = path.resolve(outputDir);
  const root = path.parse(normalized).root;
  const protectedPaths = new Set([root, path.resolve(process.cwd()), path.resolve(os.homedir())]);
  if (protectedPaths.has(normalized)) {
    throw new FixtureOptionError(`Refusing to remove protected path: ${normalized}`);
  }
  const looksLikeFixture = /fixture|large-history|large_history/i.test(path.basename(normalized));
  if (!allowDestructiveOverwrite && !looksLikeFixture) {
    throw new FixtureOptionError(
      `Refusing to force-remove non-fixture-looking path: ${normalized}. Use --allow-destructive-overwrite if this is intentional.`,
    );
  }
}

async function writeFixtureIssue(
  options: NormalizedLargeHistoryFixtureOptions,
  issueIndex: number,
  baseMs: number,
): Promise<FixtureIssueBuildResult> {
  const ordinal = issueIndex + 1;
  const issueNumber = pad(ordinal, 4);
  const issueId = `fixture-issue-${issueNumber}`;
  const issueIdentifier = `${options.issuePrefix}-${issueNumber}`;
  const workspaceKey = issueIdentifier;
  const workspacePath = `/tmp/symphony-fixtures/workspaces/${issueIdentifier}`;
  const repoPath = `/tmp/symphony-fixtures/repos/${issueIdentifier}`;
  const branchName = `fixture/${issueIdentifier.toLowerCase()}`;
  const baseRef = "main";
  const issueStartMs = baseMs + issueIndex * 60 * 60 * 1000;

  const workspace: WorkspaceRecord = {
    workspaceKey,
    issueId,
    issueIdentifier,
    path: workspacePath,
    sourceKind: "large_history_fixture",
    repoPath,
    baseRef,
    gitBranchName: branchName,
    createdAt: iso(issueStartMs),
    updatedAt: iso(issueStartMs + options.runsPerIssue * 15 * 60 * 1000),
  };
  await writeJson(path.join(options.outputDir, "workspaces", `${safeFileName(workspaceKey)}.json`), workspace);

  const runs: RunRecord[] = [];
  let transcriptEvents = 0;
  for (let runIndex = 0; runIndex < options.runsPerIssue; runIndex += 1) {
    const run = buildRunRecord({
      issueId,
      issueIdentifier,
      workspaceKey,
      workspacePath,
      repoPath,
      branchName,
      baseRef,
      issueNumber,
      issueIndex,
      runIndex,
      eventCount: options.eventsPerRun,
      startedAtMs: issueStartMs + runIndex * 15 * 60 * 1000,
    });
    runs.push(run);
    const events = buildTranscriptEvents(run, options.eventsPerRun);
    transcriptEvents += events.length;
    await writeJson(path.join(options.outputDir, "runs", safeFileName(run.runId), "meta.json"), run);
    await writeJsonl(path.join(options.outputDir, "runs", safeFileName(run.runId), "events.jsonl"), events);
  }

  const writebackOperations = await writeWritebackOperations({
    options,
    issueId,
    issueIdentifier,
    runIds: runs.map((run) => run.runId),
    issueStartMs,
  });

  const lifecycle = buildLifecycleRecord({
    issueId,
    issueIdentifier,
    workspaceKey,
    workspacePath,
    repoPath,
    branchName,
    baseRef,
    issueIndex,
    issueStartMs,
    runs,
    writebackOperationKeys: writebackOperations.map((operation) => operation.idempotencyKey),
  });
  await writeJson(path.join(options.outputDir, "issue-lifecycle", `${safeFileName(issueId)}.json`), lifecycle);

  return {
    issue: {
      id: issueId,
      identifier: issueIdentifier,
      workspaceKey,
      runIds: runs.map((run) => run.runId),
    },
    runs,
    transcriptEvents,
    writebackOperations: writebackOperations.length,
  };
}

function buildRunRecord(input: {
  issueId: string;
  issueIdentifier: string;
  workspaceKey: string;
  workspacePath: string;
  repoPath: string;
  branchName: string;
  baseRef: string;
  issueNumber: string;
  issueIndex: number;
  runIndex: number;
  eventCount: number;
  startedAtMs: number;
}): RunRecord {
  const role: AgentRunRole = input.runIndex % 3 === 1 ? "reviewer" : "worker";
  const runPhase: AgentRunPhase = role === "reviewer" ? "review" : input.runIndex % 5 === 4 ? "merge_conflict_resolution" : "implementation";
  const runKind = runKindForPhase(runPhase);
  const runId = `fixture-run-${input.issueNumber}-${pad(input.runIndex + 1, 2)}`;
  const sessionId = `fixture-session-${input.issueNumber}-${pad(input.runIndex + 1, 2)}`;
  const startedAt = iso(input.startedAtMs);
  const terminalAtMs = input.startedAtMs + Math.max(input.eventCount, 1) * 60 * 1000;
  const status = runStatusFor(input.issueIndex, input.runIndex);
  const completedAt = status === "running" ? null : iso(terminalAtMs);
  const updatedAt = completedAt ?? iso(input.startedAtMs + Math.max(input.eventCount, 1) * 60 * 1000);
  const error = status === "failed" ? "Synthetic fixture failure for large-history UI validation" : null;
  const hasPullRequest = role === "worker" && input.runIndex % 2 === 0 && input.issueIndex % 4 === 0;
  return {
    runId,
    sessionId,
    agentId: `fixture-agent-${role}-${pad(input.issueIndex + 1, 4)}-${pad(input.runIndex + 1, 2)}`,
    role,
    runPhase,
    runKind,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    attempt: role === "worker" ? input.runIndex + 1 : null,
    turnNumber: input.runIndex + 1,
    prompt: `Large history fixture ${input.issueIdentifier} run ${input.runIndex + 1}`,
    promptCharCount: `Large history fixture ${input.issueIdentifier} run ${input.runIndex + 1}`.length,
    harnessId: "hermes",
    runtimeModel: "gpt-5.5-fixture",
    runtimeModelParams: [
      { id: "context", value: "272k" },
      { id: "reasoning", value: "extra-high" },
    ],
    runtimeSettingSources: ["fixture"],
    runtimeMode: role === "reviewer" ? "plan" : "agent",
    runtimeAllowLargeContext: true,
    runtimeAgentLifecycle: role === "worker" ? "reuse_by_issue" : "fresh_per_run",
    cursorModel: null,
    cursorModelParams: [],
    cursorSettingSources: [],
    cursorMode: null,
    cursorAllowLargeContext: false,
    cursorWorkerAgentLifecycle: "fresh_per_run",
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    gitBranchName: input.branchName,
    repoPath: input.repoPath,
    baseRef: input.baseRef,
    status,
    startedAt,
    updatedAt,
    completedAt,
    error,
    tokens: tokenCountsFor(input.issueIndex, input.runIndex, input.eventCount),
    transcriptEventCount: input.eventCount,
    ...(hasPullRequest
      ? {
          prUrl: `https://github.com/example/symphony/pull/${1000 + input.issueIndex}`,
          prNumber: 1000 + input.issueIndex,
          prHeadSha: `fixture-head-${input.issueNumber}`,
          prBranch: input.branchName,
          ciStatus: status === "failed" ? "failure" : "success",
          lastPushedAt: iso(terminalAtMs - 30_000),
          lastEvidenceCursor: `fixture-cursor-${input.issueNumber}`,
        }
      : {}),
    ...(status === "cancelled"
      ? {
          cancellationRequestedAt: iso(terminalAtMs - 30_000),
          cancellationSource: "operator" as const,
          cancellationReason: "Synthetic fixture cancellation",
          cancellationOutcome: "cancelled" as const,
        }
      : {}),
    ...(status === "running" && input.issueIndex % 6 === 0
      ? {
          pendingApprovalRequestId: `fixture-approval-${input.issueNumber}`,
          pendingApprovalRequestedAt: iso(input.startedAtMs + 90_000),
        }
      : {}),
    ...(status === "failed"
      ? {
          failureKind: "fixture_failure",
          failureDiagnosticCode: "FIXTURE_SYNTHETIC_FAILURE",
          failureDiagnosticMessage: "Synthetic failed run included to exercise error projections.",
          failureDiagnosticAt: completedAt,
        }
      : {}),
  };
}

function buildTranscriptEvents(run: RunRecord, eventCount: number): TranscriptEvent[] {
  const startedMs = Date.parse(run.startedAt);
  return Array.from({ length: eventCount }, (_, index): TranscriptEvent => {
    const sequence = index + 1;
    const at = iso(startedMs + sequence * 60 * 1000);
    if (sequence === 1) {
      return {
        runId: run.runId,
        sequence,
        at,
        source: "harness",
        eventType: "user_prompt",
        message: `Fixture prompt accepted for ${run.issueIdentifier}`,
      };
    }
    if (sequence === eventCount && run.status !== "running") {
      return terminalTranscriptEvent(run, sequence, at);
    }
    if (sequence % 11 === 0) {
      return {
        runId: run.runId,
        sequence,
        at,
        source: "cursor",
        eventType: "tool_call",
        message: `Fixture tool call ${sequence} completed`,
        payload: {
          name: sequence % 22 === 0 ? "read_file" : "search_files",
          status: "completed",
          truncated: false,
        },
      };
    }
    if (sequence % 7 === 0) {
      return {
        runId: run.runId,
        sequence,
        at,
        source: "runtime",
        eventType: "thinking",
        message: `Fixture reasoning checkpoint ${sequence}`,
      };
    }
    if (sequence % 5 === 0) {
      return {
        runId: run.runId,
        sequence,
        at,
        source: "runtime",
        eventType: "assistant_message",
        message: `Fixture assistant progress update ${sequence}`,
      };
    }
    return {
      runId: run.runId,
      sequence,
      at,
      source: "harness",
      eventType: "progress",
      message: `Fixture progress event ${sequence}`,
    };
  });
}

function terminalTranscriptEvent(run: RunRecord, sequence: number, at: string): TranscriptEvent {
  if (run.status === "failed") {
    return {
      runId: run.runId,
      sequence,
      at,
      source: "harness",
      eventType: "error",
      message: run.error ?? "Fixture run failed",
    };
  }
  if (run.status === "cancelled") {
    return {
      runId: run.runId,
      sequence,
      at,
      source: "harness",
      eventType: "cancelled",
      message: "Fixture run cancelled",
    };
  }
  return {
    runId: run.runId,
    sequence,
    at,
    source: "harness",
    eventType: "completed",
    message: "Fixture run completed",
  };
}

async function writeWritebackOperations(input: {
  options: NormalizedLargeHistoryFixtureOptions;
  issueId: string;
  issueIdentifier: string;
  runIds: string[];
  issueStartMs: number;
}): Promise<WritebackOperation[]> {
  const operations: WritebackOperation[] = [];
  for (let index = 0; index < input.options.writebacksPerIssue; index += 1) {
    const createdAt = iso(input.issueStartMs + (index + input.options.runsPerIssue + 1) * 12 * 60 * 1000);
    const status = writebackStatusFor(index);
    const idempotencyKey = `fixture:${input.issueIdentifier}:writeback:${pad(index + 1, 2)}`;
    const runId = input.runIds[index % input.runIds.length];
    if (runId === undefined) throw new FixtureOptionError("writebacksPerIssue requires at least one run per issue");
    const base = {
      idempotencyKey,
      issueId: input.issueId,
      runId,
      status,
      attempt: status === "retrying" || status === "dead_letter" ? 1 : 0,
      createdAt,
      updatedAt: createdAt,
      nextAttemptAt: status === "retrying" ? iso(Date.parse(createdAt) + 15 * 60 * 1000) : createdAt,
      lastError:
        status === "skipped"
          ? "Synthetic fixture skip"
          : status === "retrying" || status === "dead_letter"
            ? "Synthetic fixture transient writeback error"
            : null,
      resultStatus: status === "succeeded" ? ("applied" as const) : status === "skipped" ? ("skipped" as const) : null,
      resultMessage: status === "succeeded" ? "Fixture writeback applied" : status === "skipped" ? "Fixture writeback skipped" : null,
      resultEvidence: null,
    };
    const operation: WritebackOperation =
      index % 2 === 0
        ? {
            ...base,
            kind: "transition",
            payload: {
              toState: transitionStateFor(index),
              fromStates: ["Todo", "In Progress", "In Review"],
              reason: "Synthetic large-history fixture transition",
            },
          }
        : {
            ...base,
            kind: "comment",
            payload: {
              body: `Synthetic large-history fixture comment for ${input.issueIdentifier} (${index + 1}).`,
              dedupeKey: idempotencyKey,
            },
          };
    operations.push(operation);
    await writeJson(path.join(input.options.outputDir, "writeback", `${safeFileName(idempotencyKey)}.json`), operation);
  }
  return operations;
}

function buildLifecycleRecord(input: {
  issueId: string;
  issueIdentifier: string;
  workspaceKey: string;
  workspacePath: string;
  repoPath: string;
  branchName: string;
  baseRef: string;
  issueIndex: number;
  issueStartMs: number;
  runs: RunRecord[];
  writebackOperationKeys: string[];
}): IssueLifecycleRecord {
  const phase = lifecyclePhaseFor(input.issueIndex);
  const lastWorkerRun = [...input.runs].reverse().find((run) => run.role === "worker") ?? input.runs.at(-1) ?? null;
  const lastReviewerRun = [...input.runs].reverse().find((run) => run.role === "reviewer") ?? null;
  const updatedAt = input.runs.at(-1)?.updatedAt ?? iso(input.issueStartMs);
  const summaryPointers: IssueLifecycleSummaryPointers = {
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    branchName: input.branchName,
    gitBranchName: input.branchName,
    repoPath: input.repoPath,
    baseRef: input.baseRef,
    lastRunId: input.runs.at(-1)?.runId ?? null,
    prUrl: lastWorkerRun?.prUrl ?? null,
    prNumber: lastWorkerRun?.prNumber ?? null,
    prHeadSha: lastWorkerRun?.prHeadSha ?? null,
    prBranch: lastWorkerRun?.prBranch ?? null,
    ciStatus: lastWorkerRun?.ciStatus ?? null,
    lastPushedAt: lastWorkerRun?.lastPushedAt ?? null,
    lastEvidenceCursor: lastWorkerRun?.lastEvidenceCursor ?? null,
  };
  const completionReports = buildCompletionReports(input, lastWorkerRun, summaryPointers);
  const reviewVerdicts = buildReviewVerdicts(input, lastReviewerRun, phase);
  const baseRecord: Omit<IssueLifecycleRecord, "handoff"> = {
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    phase,
    reviewRound: phase === "implementation" ? 0 : (input.issueIndex % 3) + 1,
    incompleteTurnCount: input.issueIndex % 9 === 0 ? 1 : 0,
    lastIssueBreakdownPlanId: null,
    planningFailureCount: input.issueIndex % 13 === 0 ? 1 : 0,
    planningDispatchRetryCount: input.issueIndex % 17 === 0 ? 1 : 0,
    lastPlanningFailureRunId: input.issueIndex % 13 === 0 ? input.runs[0]?.runId ?? null : null,
    lastPlanningFailureAt: input.issueIndex % 13 === 0 ? iso(input.issueStartMs + 5 * 60 * 1000) : null,
    lastCompletionReportId: completionReports.at(-1)?.id ?? null,
    lastReviewVerdictId: reviewVerdicts.at(-1)?.id ?? null,
    blockedReason: phase === "blocked" ? "Synthetic large-history fixture blocker" : null,
    summaryPointers,
    summaryReferences: [
      {
        id: `fixture-summary-${input.issueIdentifier}`,
        kind: "continuation_history",
        summary: `Synthetic continuation summary for ${input.issueIdentifier}.`,
        runIds: input.runs.map((run) => run.runId),
        transcriptEventCount: input.runs.reduce((count, run) => count + (run.transcriptEventCount ?? 0), 0),
        transcriptPointers: input.runs.map((run) => `/api/v1/runs/${run.runId}/transcript`),
        statusApiPointers: [
          `/api/v1/issues/${input.issueIdentifier}`,
          `/api/v1/web/history?issue=${input.issueIdentifier}`,
        ],
        issueUpdatedAt: updatedAt,
        issueContentFingerprint: `fixture-content-${input.issueIdentifier}`,
        configFingerprint: "large-history-fixture",
        cursorMode: null,
        createdAt: iso(input.issueStartMs + 30 * 60 * 1000),
      },
    ],
    issueBreakdownPlans: [],
    completionReports,
    reviewVerdicts,
    reviewFeedback: [],
    reviewEvidence: {
      pullRequest: null,
      lastIngestedCursor: null,
      lastWorkerEvidenceCursor: null,
      items: [],
      updatedAt: null,
    },
    mergeGate: null,
    merge: null,
    mergeConflict: null,
    mergeConflictResolutionReports: [],
    createdAt: iso(input.issueStartMs),
    updatedAt,
  };
  return {
    ...baseRecord,
    handoff: buildIssueHandoffState(baseRecord),
  };
}

function buildCompletionReports(
  input: {
    issueId: string;
    issueIdentifier: string;
    issueIndex: number;
    issueStartMs: number;
    writebackOperationKeys: string[];
  },
  lastWorkerRun: RunRecord | null,
  pointers: IssueLifecycleSummaryPointers,
): IssueCompletionReportRecord[] {
  if (lastWorkerRun === null || lifecyclePhaseFor(input.issueIndex) === "implementation") return [];
  const pullRequest = pointers.prUrl === null
    ? null
    : {
        url: pointers.prUrl,
        number: pointers.prNumber,
        headSha: pointers.prHeadSha,
        branch: pointers.prBranch,
      };
  return [
    {
      id: `fixture-report-${input.issueIdentifier}`,
      idempotencyKey: `fixture:${input.issueIdentifier}:completion-report`,
      runId: lastWorkerRun.runId,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      summary: `Synthetic worker completion report for ${input.issueIdentifier}.`,
      validationEvidence: ["Generated by scripts/generate-large-history-fixture.ts"],
      acceptanceChecklist: [
        {
          text: "Large-history fixture includes durable run, transcript, lifecycle, and writeback records.",
          satisfied: true,
          evidence: "Manifest counts and file-backed stores load successfully.",
        },
      ],
      changedFiles: ["scripts/generate-large-history-fixture.ts"],
      branchName: pointers.branchName,
      pullRequest,
      risks: [],
      acceptedAt: iso(input.issueStartMs + 45 * 60 * 1000),
      writebackOperationKeys: input.writebackOperationKeys,
    },
  ];
}

function buildReviewVerdicts(
  input: {
    issueId: string;
    issueIdentifier: string;
    issueIndex: number;
    issueStartMs: number;
  },
  lastReviewerRun: RunRecord | null,
  phase: IssueLifecyclePhase,
): IssueReviewVerdictRecord[] {
  if (lastReviewerRun === null || phase === "implementation" || phase === "review") return [];
  const passing = phase === "passed" || phase === "terminal";
  return [
    {
      id: `fixture-verdict-${input.issueIdentifier}`,
      idempotencyKey: `fixture:${input.issueIdentifier}:review-verdict`,
      runId: lastReviewerRun.runId,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      verdict: passing ? "pass" : "fail",
      acceptanceResults: [
        {
          text: "Fixture projection accepts large durable history without unbounded transcript reads.",
          satisfied: passing,
          evidence: passing ? "Synthetic reviewer pass evidence." : "Synthetic reviewer finding retained for UI filtering.",
        },
      ],
      findings: passing ? [] : ["Synthetic reviewer finding for blocked/error fixture coverage."],
      evidence: ["Generated by scripts/generate-large-history-fixture.ts"],
      reviewer: "large-history-fixture",
      submittedAt: iso(input.issueStartMs + 55 * 60 * 1000),
      writebackOperationKeys: [],
    },
  ];
}

function runStatusFor(issueIndex: number, runIndex: number): RunStatus {
  if (runIndex === 0 && issueIndex % 12 === 0) return "running";
  if ((issueIndex + runIndex) % 7 === 0) return "failed";
  if ((issueIndex + runIndex) % 5 === 0) return "cancelled";
  return "succeeded";
}

function lifecyclePhaseFor(issueIndex: number): IssueLifecyclePhase {
  const phases: IssueLifecyclePhase[] = ["implementation", "review", "passed", "blocked", "terminal", "merge_conflict_resolution"];
  return phases[issueIndex % phases.length] ?? "implementation";
}

function tokenCountsFor(issueIndex: number, runIndex: number, eventCount: number): RunRecord["tokens"] {
  const inputTokens = 1_000 + issueIndex * 17 + runIndex * 101 + eventCount * 3;
  const outputTokens = 500 + issueIndex * 13 + runIndex * 43 + eventCount * 2;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function writebackStatusFor(index: number): WritebackStatus {
  const statuses: WritebackStatus[] = ["pending", "succeeded", "skipped", "retrying", "dead_letter"];
  return statuses[index % statuses.length] ?? "pending";
}

function transitionStateFor(index: number): string {
  const states = ["In Progress", "In Review", "Ready to Merge", "Blocked", "Done"];
  return states[index % states.length] ?? "In Progress";
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new FixtureOptionError(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new FixtureOptionError(`${field} must be a non-negative integer`);
  return value;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  return positiveInteger(parsed, "option");
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  return nonNegativeInteger(parsed, "option");
}

function sanitizeIssuePrefix(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,12}$/.test(normalized)) {
    throw new FixtureOptionError("issuePrefix must be 2-13 alphanumeric characters and start with a letter");
  }
  return normalized;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "record";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath: string, values: readonly unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
  await fs.writeFile(filePath, body, "utf8");
}

interface CliOptions {
  output: string;
  issues: number;
  runsPerIssue: number;
  eventsPerRun: number;
  writebacksPerIssue: number;
  baseTimestamp: string;
  issuePrefix: string;
  force: boolean;
  allowDestructiveOverwrite: boolean;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("generate-large-history-fixture")
    .description("Generate a deterministic file-backed Symphony state fixture with many issues, runs, transcripts, lifecycle records, and writeback operations.")
    .option("--output <path>", "output state directory", DEFAULT_OPTIONS.outputDir)
    .option("--issues <count>", "number of synthetic issues", parsePositiveInteger, DEFAULT_OPTIONS.issueCount)
    .option("--runs-per-issue <count>", "number of runs per issue", parsePositiveInteger, DEFAULT_OPTIONS.runsPerIssue)
    .option("--events-per-run <count>", "number of transcript events per run", parseNonNegativeInteger, DEFAULT_OPTIONS.eventsPerRun)
    .option("--writebacks-per-issue <count>", "number of durable writeback operations per issue", parseNonNegativeInteger, DEFAULT_OPTIONS.writebacksPerIssue)
    .option("--base-timestamp <iso>", "base ISO timestamp for deterministic fixture chronology", DEFAULT_OPTIONS.baseTimestamp)
    .option("--issue-prefix <prefix>", "synthetic issue identifier prefix", DEFAULT_OPTIONS.issuePrefix)
    .option("--force", "replace an existing non-empty fixture output directory", false)
    .option(
      "--allow-destructive-overwrite",
      "allow --force on paths that do not look like fixture directories; protected roots are still refused",
      false,
    );

  program.parse(process.argv);
  const cli = program.opts<CliOptions>();
  const manifest = await generateLargeHistoryFixture({
    outputDir: cli.output,
    issueCount: cli.issues,
    runsPerIssue: cli.runsPerIssue,
    eventsPerRun: cli.eventsPerRun,
    writebacksPerIssue: cli.writebacksPerIssue,
    baseTimestamp: cli.baseTimestamp,
    issuePrefix: cli.issuePrefix,
    force: cli.force,
    allowDestructiveOverwrite: cli.allowDestructiveOverwrite,
  });

  console.log(
    JSON.stringify(
      {
        generated: true,
        stateDir: manifest.stateDir,
        counts: manifest.counts,
        manifestPath: path.join(manifest.stateDir, "large-history-fixture-manifest.json"),
        historyEndpoint: manifest.apiHints.historyEndpoint,
      },
      null,
      2,
    ),
  );
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isEntrypoint()) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[large-history-fixture] ${message}`);
    process.exitCode = 1;
  });
}
