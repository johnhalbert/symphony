import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, Label } from "../src/components/common";
import { labels as mockLabels, users as mockUsers } from "../src/data/mockData";
import { ReferenceDataProvider, fallbackReferenceData } from "../src/data/referenceDataContext";

describe("reference data consumers", () => {
  it("renders fallback names and colors when API reference entries are missing or nullable", () => {
    const markup = renderToStaticMarkup(
      createElement(ReferenceDataProvider, {
        value: {
          users: {
            alice: { name: "", color: null },
          },
          labels: {
            bug: { name: "", color: null },
          },
        },
        children: createElement(
          Fragment,
          null,
          createElement(Avatar, { user: "alice" }),
          createElement(Label, { name: "bug" }),
          createElement(Avatar, { user: "unknown-user" }),
          createElement(Label, { name: "unknown-label" }),
        ),
      }),
    );

    expect(markup).toContain("#5a5a62");
    expect(markup).toContain(">A<");
    expect(markup).toContain("bug");
    expect(markup).toContain("unknown-label");
  });

  it("keeps the deterministic unassigned user entry in fallback reference data", () => {
    const markup = renderToStaticMarkup(
      createElement(ReferenceDataProvider, {
        value: fallbackReferenceData,
        children: createElement(Avatar, { user: "unassigned" }),
      }),
    );

    expect(markup).toContain("#5a5a62");
    expect(markup).toContain(">U<");
  });

  it("renders provided mock reference data without falling back to raw IDs", () => {
    const markup = renderToStaticMarkup(
      createElement(ReferenceDataProvider, {
        value: { users: mockUsers, labels: mockLabels },
        children: createElement(
          Fragment,
          null,
          createElement(Avatar, { user: "sherwinwu" }),
          createElement(Label, { name: "orchestrator" }),
        ),
      }),
    );

    expect(markup).toContain("#7fc28b");
    expect(markup).toContain(">SW<");
    expect(markup).toContain("#f0b86c");
    expect(markup).toContain("orchestrator");
  });
});
