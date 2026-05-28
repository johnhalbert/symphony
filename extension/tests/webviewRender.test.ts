import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityFeedResponse, BoardIssueDetailResponse, IssueBoardResponse, TranscriptPage } from "../src/statusApiTypes";
import type { ConnectionState } from "../src/connectionState";
import type { ExtensionMessage } from "../src/webviewMessages";

describe("webview transcript rendering", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sanitizes transcript and activity messages while preserving safe token telemetry", async () => {
    const { root, emit, click } = await loadWebview();
    const unsafeActivityMessage =
      "activity SECRET_ACTIVITY token=activity-token access_token=activity-access github_token=activity-github client_secret: activity-client private_key=activity-private ghp_ABCDEFGH1 sk-ABCDEFGH1 inputTokens: 7 totalTokens: 9 tokenConfigured: true";
    const unsafeTranscriptMessage =
      "transcript SECRET_TRANSCRIPT token=transcript-token refreshToken: transcript-refresh client_secret: transcript-client private_key=transcript-private ghp_HIJKLMNO1 sk-HIJKLMNO1 inputTokens: 7 totalTokens: 9 tokenConfigured: true";

    emit({
      type: "dashboardState",
      dashboardGeneration: 1,
      activity: activityPage(unsafeActivityMessage),
    });
    click({ action: "selectRun", run: "run-redaction" });
    emit({
      type: "runState",
      runId: "run-redaction",
      runEpoch: 1,
      offset: 0,
      run: { runId: "run-redaction", issueIdentifier: "TEST-REDACTION", status: "running" },
      transcript: transcriptPage(unsafeTranscriptMessage),
    });

    expect(root.innerHTML).not.toContain("SECRET_ACTIVITY");
    expect(root.innerHTML).not.toContain("activity-token");
    expect(root.innerHTML).not.toContain("activity-access");
    expect(root.innerHTML).not.toContain("activity-github");
    expect(root.innerHTML).not.toContain("activity-client");
    expect(root.innerHTML).not.toContain("activity-private");
    expect(root.innerHTML).not.toContain("ghp_ABCDEFGH1");
    expect(root.innerHTML).not.toContain("sk-ABCDEFGH1");
    expect(root.innerHTML).not.toContain("SECRET_TRANSCRIPT");
    expect(root.innerHTML).not.toContain("transcript-token");
    expect(root.innerHTML).not.toContain("transcript-refresh");
    expect(root.innerHTML).not.toContain("transcript-client");
    expect(root.innerHTML).not.toContain("transcript-private");
    expect(root.innerHTML).not.toContain("ghp_HIJKLMNO1");
    expect(root.innerHTML).not.toContain("sk-HIJKLMNO1");
    expect(root.innerHTML).toContain("[redacted]");
    expect(root.innerHTML).toContain("inputTokens: 7");
    expect(root.innerHTML).toContain("totalTokens: 9");
    expect(root.innerHTML).toContain("tokenConfigured: true");
  });

  it("sanitizes run error rows in history and issue detail views", async () => {
    const { root, emit, click } = await loadWebview();
    const unsafeError =
      "failed SECRET_RUN_ERROR token=run-token access_token=run-access Bearer run-bearer ghp_ABCDEFGH1 sk-ABCDEFGH1 inputTokens: 7";

    click({ action: "selectRun", run: "run-redaction" });
    emit({
      type: "runState",
      runId: "run-redaction",
      runEpoch: 1,
      offset: 0,
      run: { runId: "run-redaction", issueIdentifier: "TEST-REDACTION", status: "failed", error: unsafeError },
      transcript: { runId: "run-redaction", offset: 0, limit: 100, nextOffset: null, events: [] },
    });

    expect(root.innerHTML).not.toContain("SECRET_RUN_ERROR");
    expect(root.innerHTML).not.toContain("run-token");
    expect(root.innerHTML).not.toContain("run-access");
    expect(root.innerHTML).not.toContain("run-bearer");
    expect(root.innerHTML).not.toContain("ghp_ABCDEFGH1");
    expect(root.innerHTML).not.toContain("sk-ABCDEFGH1");
    expect(root.innerHTML).toContain("failed");
    expect(root.innerHTML).toContain("[redacted]");
    expect(root.innerHTML).toContain("inputTokens: 7");

    emit({
      type: "dashboardState",
      dashboardGeneration: 1,
      board: issueBoardWithCard(unsafeError),
      activity: null,
    });
    click({ action: "selectIssue", issue: "TEST-REDACTION" });
    emit({
      type: "issueDetailState",
      issueKey: "TEST-REDACTION",
      issueEpoch: 1,
      offset: 0,
      detail: issueDetailWithLatestRunError(unsafeError),
      activity: null,
    });

    expect(root.innerHTML).not.toContain("SECRET_RUN_ERROR");
    expect(root.innerHTML).not.toContain("run-token");
    expect(root.innerHTML).not.toContain("run-access");
    expect(root.innerHTML).not.toContain("run-bearer");
    expect(root.innerHTML).toContain("Latest Run");
    expect(root.innerHTML).toContain("failed");
    expect(root.innerHTML).toContain("[redacted]");
    expect(root.innerHTML).toContain("inputTokens: 7");
  });

  it("renders structured transcript summaries and JSON fallbacks without raw secrets", async () => {
    const { root, emit, click } = await loadWebview();

    click({ action: "selectRun", run: "run-structured" });
    emit({
      type: "runState",
      runId: "run-structured",
      runEpoch: 1,
      offset: 0,
      run: { runId: "run-structured", issueIdentifier: "TEST-STRUCTURED", status: "running" },
      transcript: structuredTranscriptPage(),
    });

    expect(root.innerHTML).toContain("tool_call");
    expect(root.innerHTML).toContain("shell");
    expect(root.innerHTML).toContain("call-1");
    expect(root.innerHTML).toContain("safe output");
    expect(root.innerHTML).toContain("thinking");
    expect(root.innerHTML).toContain("considered");
    expect(root.innerHTML).toContain("status");
    expect(root.innerHTML).toContain("running");
    expect(root.innerHTML).toContain("activitySource");
    expect(root.innerHTML).toContain("inputTokens");
    expect(root.innerHTML).toContain("tokenConfigured");
    expect(root.innerHTML).toContain("[redacted]");

    for (const raw of [
      "SECRET_TOOL",
      "tool-token",
      "SECRET_OUTPUT",
      "ghp_ABCDEFGH1",
      "sk-HIJKLMNO1",
      "bearer-secret",
      "SECRET_THINK",
      "think-token",
      "SECRET_STATUS",
      "status-access",
      "SECRET_JSON_BOUNDARY",
      "json-token",
      "json-access",
      "json-client",
    ]) {
      expect(root.innerHTML).not.toContain(raw);
    }
  });
});

async function loadWebview(): Promise<{
  root: FakeRoot;
  emit: (message: ExtensionMessage) => void;
  click: (dataset: Record<string, string>) => void;
}> {
  const root = new FakeRoot();
  let messageListener: ((event: MessageEvent<ExtensionMessage>) => void) | null = null;
  vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: vi.fn() }));
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "root" ? root : null),
  });
  vi.stubGlobal("window", {
    __SYMPHONY_INITIAL_STATE__: connectedState(),
    addEventListener: (type: string, listener: (event: MessageEvent<ExtensionMessage>) => void) => {
      if (type === "message") messageListener = listener;
    },
  });
  vi.stubGlobal("Element", FakeElement);

  await import("../src/webview/main.js");

  return {
    root,
    emit: (message) => {
      if (!messageListener) throw new Error("webview message listener was not registered");
      messageListener({ data: message } as MessageEvent<ExtensionMessage>);
    },
    click: (dataset) => {
      if (!root.onclick) throw new Error("webview click handler was not registered");
      root.onclick({ target: new FakeElement(dataset) } as unknown as MouseEvent);
    },
  };
}

function connectedState(): ConnectionState {
  return {
    kind: "connected",
    baseUrl: "http://127.0.0.1:7331",
    generatedAt: "2030-01-01T00:00:00.000Z",
    summary: {
      runningCount: 1,
      retryingCount: 0,
      tokenConfigured: true,
      mutationsRequireToken: false,
    },
  };
}

function activityPage(message: string): ActivityFeedResponse {
  return {
    generatedAt: "2030-01-01T00:00:00.000Z",
    offset: 0,
    limit: 50,
    nextOffset: null,
    activity: [
      {
        id: "transcript:run-redaction:1",
        at: "2030-01-01T00:00:01.000Z",
        kind: "transcript_event",
        source: "harness",
        issue: { id: "issue-redaction", identifier: "TEST-REDACTION" },
        run: { runId: "run-redaction", role: "worker", status: "running" },
        transcript: { sequence: 1, eventType: "progress", message },
        writeback: null,
        links: {},
      },
    ],
    counts: {},
    source: {},
    filter: { issue: null },
  };
}

function transcriptPage(message: string): TranscriptPage {
  return {
    runId: "run-redaction",
    offset: 0,
    limit: 100,
    nextOffset: null,
    events: [
      {
        runId: "run-redaction",
        sequence: 1,
        at: "2030-01-01T00:00:01.000Z",
        source: "harness",
        eventType: "progress",
        message,
      },
    ],
  };
}

function structuredTranscriptPage(): TranscriptPage {
  return {
    runId: "run-structured",
    offset: 0,
    limit: 100,
    nextOffset: null,
    events: [
      {
        runId: "run-structured",
        sequence: 1,
        at: "2030-01-01T00:00:01.000Z",
        source: "harness",
        eventType: "tool_call",
        payload: {
          kind: "tool_call",
          name: "shell",
          status: "failed",
          callId: "call-1",
          argumentsPreview: "echo SECRET_TOOL token=tool-token inputTokens: 7",
          resultPreview: "result Bearer bearer-secret",
          outputPreview: "safe output SECRET_OUTPUT ghp_ABCDEFGH1",
          errorPreview: "failed sk-HIJKLMNO1",
        },
      },
      {
        runId: "run-structured",
        sequence: 2,
        at: "2030-01-01T00:00:02.000Z",
        source: "cursor",
        eventType: "thinking",
        payload: {
          kind: "thinking",
          summary: "considered SECRET_THINK token=think-token totalTokens: 9",
        },
      },
      {
        runId: "run-structured",
        sequence: 3,
        at: "2030-01-01T00:00:03.000Z",
        source: "harness",
        eventType: "status",
        payload: {
          kind: "status",
          status: "running",
          messagePreview: "progress SECRET_STATUS access_token=status-access tokenConfigured: true",
        },
      },
      {
        runId: "run-structured",
        sequence: 4,
        at: "2030-01-01T00:00:04.000Z",
        source: "harness",
        eventType: "progress",
        payload: {
          activitySource: "stream",
          inputTokens: 7,
          tokenConfigured: true,
          detail: `${"x".repeat(1_950)} SECRET_JSON_BOUNDARY token=json-token`,
          access_token: "json-access",
          nested: { client_secret: "json-client" },
        },
      },
    ],
  };
}

function issueDetailWithLatestRunError(error: string): BoardIssueDetailResponse {
  return {
    issue: "TEST-REDACTION",
    boardCard: null,
    issueDetails: {
      source: "durable",
      completeness: "partial",
      issue: {
        id: "issue-redaction",
        identifier: "TEST-REDACTION",
        title: "Redaction issue",
        description: null,
        priority: null,
        state: "In Progress",
        branchName: null,
        url: null,
        assigneeId: null,
        delegateId: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      tracker: {},
      blockers: { available: false, totalCount: 0, openCount: 0, open: [], blocked: false, humanBlockedReason: null },
      workspace: {
        workspaceKey: "TEST-REDACTION",
        path: null,
        sourceKind: null,
        branchName: null,
        gitBranchName: null,
        repoPath: null,
        baseRef: null,
      },
      pullRequest: { url: null, number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null },
      latestRun: {
        runId: "run-redaction",
        runPhase: "implementation",
        runKind: "implementation",
        status: "failed",
        terminalReason: "failed",
        error,
        completedAt: "2030-01-01T00:00:05.000Z",
      },
    },
    live: null,
    workspace: null,
    latestRun: { runId: "run-redaction", error },
    runs: [],
    lifecycle: null,
    reviewLoop: {},
    metadata: {},
    pullRequest: { url: null, number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null },
    blockers: { available: false, totalCount: 0, openCount: 0, open: [], blocked: false, humanBlockedReason: null },
    operatorLiveness: null,
    capabilities: {
      openWorkspace: false,
      transcript: false,
      mutationsRequireToken: false,
      humanRequired: { active: false, reason: null },
      continuationSummary: {},
    },
  };
}

function issueBoardWithCard(error: string): IssueBoardResponse {
  const detail = issueDetailWithLatestRunError(error);
  const card = {
    key: "TEST-REDACTION",
    issueId: "issue-redaction",
    issueIdentifier: "TEST-REDACTION",
    origin: "symphony",
    lane: "progress",
    issueDetails: detail.issueDetails,
    paused: false,
    live: null,
    operatorLiveness: null,
    reviewLoop: {},
    metadata: {},
    capabilities: {
      detail: "/api/v1/board/issues/TEST-REDACTION",
      runs: "/api/v1/issues/TEST-REDACTION/runs",
      humanRequired: { active: false, reason: null },
      continuationSummary: {},
    },
  };
  return {
    generatedAt: "2030-01-01T00:00:00.000Z",
    tracker: {},
    columns: [{ id: "progress", title: "In Progress", states: ["In Progress"], count: 1, issues: [card] }],
    issues: [card],
    counts: {},
  };
}

class FakeRoot {
  innerHTML = "";
  onclick: ((event: MouseEvent) => void) | null = null;
}

class FakeElement {
  constructor(readonly dataset: Record<string, string>) {}

  closest(): FakeElement {
    return this;
  }
}
