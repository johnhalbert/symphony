import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BacklogColumn } from "../src/components/issues/BacklogColumn";
import { IssueCard } from "../src/components/issues/IssueCard";
import { DetailColumn } from "../src/components/issues/DetailColumn";
import { resolveSelectedIssueId } from "../src/components/issues/IssuesView";
import { Swimlanes } from "../src/components/issues/Swimlanes";
import { ReferenceDataProvider } from "../src/data/referenceDataContext";
import type { IssueBoardModel, IssueModel } from "../src/types/symphony";

function makeIssue(overrides: Partial<IssueModel> = {}): IssueModel {
  return {
    id: "ENG-105",
    title: "Integrate GET /api/v1/web/issues",
    status: "progress",
    priority: 2,
    labels: ["frontend"],
    assignee: "operator",
    agent: null,
    project: "Symphony",
    cycle: "Dogfood",
    desc: ["Wire the issues board to live API data."],
    ...overrides,
  };
}

describe("issues components", () => {
  it("renders active agent chrome from issue agent metadata instead of assignee sentinel values", () => {
    const html = renderToStaticMarkup(
      <IssueCard issue={makeIssue({ assignee: "human", agent: "codex-07" })} selected={false} onSelect={() => {}} />,
    );

    expect(html).toContain("codex-07");
    expect(html).toContain("box-shadow:inset 2px 0 0 var(--accent)");
  });

  it("keeps the selected issue across API refreshes while it remains present", () => {
    const current = makeIssue({ id: "ENG-104" });
    const fallback = makeIssue({ id: "ENG-105" });

    expect(resolveSelectedIssueId("ENG-104", { issues: [current, fallback], selectedIssueId: "ENG-105" })).toBe("ENG-104");
  });

  it("falls back to the API-selected issue when the local selection disappears", () => {
    const fallback = makeIssue({ id: "ENG-105" });

    expect(resolveSelectedIssueId("ENG-104", { issues: [fallback], selectedIssueId: "ENG-105" })).toBe("ENG-105");
  });

  it("does not select an unavailable API-selected issue for empty or mismatched boards", () => {
    const fallback = makeIssue({ id: "ENG-106" });

    expect(resolveSelectedIssueId("ENG-104", { issues: [fallback], selectedIssueId: "ENG-MISSING" })).toBe("ENG-106");
    expect(resolveSelectedIssueId("ENG-104", { issues: [], selectedIssueId: "ENG-MISSING" })).toBe("");
  });

  it("falls back to the assignee id when API reference data is missing or blank", () => {
    const missingHtml = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: {}, labels: {} }}>
        <DetailColumn issue={makeIssue({ assignee: "missing-user" })} onClose={() => {}} />
      </ReferenceDataProvider>,
    );
    const blankHtml = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: { blank: { name: "", color: null } }, labels: {} }}>
        <DetailColumn issue={makeIssue({ assignee: "blank" })} onClose={() => {}} />
      </ReferenceDataProvider>,
    );

    expect(missingHtml).toContain("missing-user");
    expect(blankHtml).toContain("blank");
  });

  it("renders existing issue empty activity with neutral copy", () => {
    const html = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: {}, labels: {} }}>
        <DetailColumn issue={makeIssue({ activity: [] })} onClose={() => {}} />
      </ReferenceDataProvider>,
    );

    expect(html).toContain("No issue activity available.");
    expect(html).not.toContain("mock data");
  });

  it("renders the empty detail state without dereferencing a null issue", () => {
    const html = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: {}, labels: {} }}>
        <DetailColumn issue={null} onClose={() => {}} />
      </ReferenceDataProvider>,
    );

    expect(html).toContain("Select an issue to inspect details.");
  });

  it("keeps stale issue detail visible while refreshes load or fail", () => {
    const loadingHtml = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: {}, labels: {} }}>
        <DetailColumn issue={makeIssue()} loading onClose={() => {}} />
      </ReferenceDataProvider>,
    );
    const errorHtml = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: {}, labels: {} }}>
        <DetailColumn issue={makeIssue()} error="Symphony API returned HTTP 503" onClose={() => {}} />
      </ReferenceDataProvider>,
    );

    expect(loadingHtml).toContain("Refreshing issue detail… showing previous details.");
    expect(loadingHtml).toContain("Integrate GET /api/v1/web/issues");
    expect(errorHtml).toContain("Could not refresh issue detail: Symphony API returned HTTP 503. Showing previous details.");
    expect(errorHtml).toContain("Wire the issues board to live API data.");
  });

  it("renders explicit empty states for empty backlog and swimlanes", () => {
    const emptyBoard: IssueBoardModel = {
      issues: [],
      backlog: [],
      lanes: { todo: [], progress: [], review: [] },
      cycleLabel: "Empty cycle",
      cycleDateRange: "no active issues",
      selectedIssueId: "",
    };
    const backlogHtml = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: {}, labels: {} }}>
        <BacklogColumn backlog={[]} selectedId="" onSelect={() => {}} />
      </ReferenceDataProvider>,
    );
    const swimlanesHtml = renderToStaticMarkup(
      <ReferenceDataProvider value={{ users: {}, labels: {} }}>
        <Swimlanes board={emptyBoard} selectedId="" onSelect={() => {}} />
      </ReferenceDataProvider>,
    );

    expect(backlogHtml).toContain("No backlog issues in this projection.");
    expect(swimlanesHtml).toContain("No todo issues in this projection.");
    expect(swimlanesHtml).toContain("No in progress issues in this projection.");
    expect(swimlanesHtml).toContain("No in review issues in this projection.");
  });
});
