import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, Label } from "../src/components/common";
import { ReferenceDataProvider } from "../src/data/referenceDataContext";

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
});
