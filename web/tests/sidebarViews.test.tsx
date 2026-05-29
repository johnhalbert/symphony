import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SidebarViews } from "../src/components/sidebar/SidebarViews";
import type { SidebarModel } from "../src/types/symphony";

const representativeSidebar: SidebarModel = {
  providerGates: [
    {
      id: "gate-1",
      provider: "openai-codex",
      kind: "rate_limit",
      message: "Waiting for provider reset",
      resumeAt: null,
      resumePolicy: "manual",
      sourceIssue: "ENG-7",
      sourceRunId: "run-1",
      affected: "worker",
    },
  ],
  runningAgents: [
    {
      id: "agent-1",
      issue: "ENG-7",
      title: "Wire sidebar API payload",
      state: "running",
      step: "Rendering /api/v1/web/sidebar",
      duration: "2m",
      tokens: "1.2k",
    },
  ],
  reviewIssues: [
    {
      id: "ENG-8",
      title: "Review enriched issue fields",
      status: "review",
      priority: "urgent",
      labels: ["dogfood", "api"],
      assignee: "reviewer-1",
      agent: "agent-2",
      project: "Symphony",
      cycle: "Cycle 1",
      desc: ["Rendered from the API sidebar projection."],
      activity: [{ t: "now", verb: "reviewed", val: "pass", who: "bot" }],
      pr: "#123",
      ci: "green",
      workspace: "ENG-8",
      session: "session-8",
    },
  ],
  activity: [{ t: "now", who: "orchestrator", verb: "accepted", id: "ENG-8", extra: "completion" }],
  sessions: [
    {
      id: "session-1",
      issue: "ENG-7",
      title: "Sidebar integration run",
      state: "finished",
      model: "gpt-5.5",
      startedAt: "2026-05-29T00:00:00Z",
      updatedAt: "1m ago",
      msgCount: 4,
      lastEvent: "completed sidebar render",
      toolCount: 2,
    },
  ],
  chat: [
    { who: "agent", text: "Sidebar **ready**", suggestions: ["Open ENG-7"] },
    { who: "user", text: "Show history" },
  ],
  totals: { backlog: 1, todo: 2, progress: 3, review: 1, done: 4, cancelled: 0, open: 7, all: 11, completeness: 36 },
};

const emptySidebar: SidebarModel = {
  providerGates: [],
  runningAgents: [],
  reviewIssues: [],
  activity: [],
  sessions: [],
  chat: [],
  totals: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 },
};

describe("sidebar views", () => {
  it("renders primary sidebar fields from the API SidebarModel", () => {
    const html = renderToStaticMarkup(<SidebarViews sidebar={representativeSidebar} variant="primary" />);

    expect(html).toContain("openai-codex");
    expect(html).toContain("ENG-7");
    expect(html).toContain("Wire sidebar API payload");
    expect(html).toContain("Rendering /api/v1/web/sidebar");
    expect(html).toContain("ENG-8");
    expect(html).toContain("Review enriched issue fields");
    expect(html).toContain("@reviewer-1");
    expect(html).toContain("#dogfood");
    expect(html).toContain("ci green");
    expect(html).toContain("ws ENG-8");
    expect(html).toContain("session session-8");
    expect(html).toContain("orchestrator");
    expect(html).toContain("accepted");
    expect(html).toContain("11 total issues");
    expect(html).not.toContain("Velocity");
    expect(html).not.toContain("poll in 8s");
  });

  it("renders API sidebar history sessions", () => {
    const html = renderToStaticMarkup(<SidebarViews sidebar={representativeSidebar} variant="history" />);

    expect(html).toContain("Chat history");
    expect(html).toContain("Sidebar integration run");
    expect(html).toContain("4 msgs");
    expect(html).toContain("2 tools");
    expect(html).toContain("completed sidebar render");
  });

  it("renders API sidebar chat messages and suggestions", () => {
    const html = renderToStaticMarkup(<SidebarViews sidebar={representativeSidebar} variant="chat" />);

    expect(html).toContain("Sidebar");
    expect(html).toContain("ready");
    expect(html).toContain("Open ENG-7");
    expect(html).toContain("Show history");
  });

  it("renders empty API sidebar arrays without mock fallback content", () => {
    const primary = renderToStaticMarkup(<SidebarViews sidebar={emptySidebar} variant="primary" />);
    const history = renderToStaticMarkup(<SidebarViews sidebar={emptySidebar} variant="history" />);
    const chat = renderToStaticMarkup(<SidebarViews sidebar={emptySidebar} variant="chat" />);

    expect(primary).toContain("No running agents.");
    expect(primary).toContain("No review issues.");
    expect(primary).toContain("No recent activity.");
    expect(history).toContain("No sidebar sessions yet.");
    expect(chat).toContain("No orchestrator messages yet.");
    expect(chat).not.toContain("chat__suggestion");
    expect(chat).not.toContain("Show running agents");
  });
});
