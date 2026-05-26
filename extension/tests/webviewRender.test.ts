import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityFeedResponse, TranscriptPage } from "../src/statusApiTypes";
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
