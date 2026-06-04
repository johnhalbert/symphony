// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "../src/components/dashboard/DashboardView";
import type { SymphonyDataSource, TriggerPollResult } from "../src/data/dataSource";
import { DataSourceProvider } from "../src/data/dataSourceContext";
import { createApiModeDataSource, makeHarnessDashboard } from "./support/componentHarness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const dashboard = makeHarnessDashboard({ pollLabel: "poll 30s" });

async function renderInteractiveDashboard(input: {
  dataSource: SymphonyDataSource;
  onPollTriggered?: (result: TriggerPollResult) => void;
}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <DataSourceProvider value={input.dataSource}>
        <DashboardView dashboard={dashboard} onPollTriggered={input.onPollTriggered} />
      </DataSourceProvider>,
    );
  });

  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Could not find button with text ${text}`);
  return button as HTMLButtonElement;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("dashboard action buttons", () => {
  it("wires Trigger poll to the configured data-source command and reports the accepted operations", async () => {
    const result: TriggerPollResult = {
      queued: true,
      coalesced: false,
      requested_at: "2026-06-03T13:30:00.000Z",
      operations: ["poll", "reconcile"],
    };
    const triggerPoll = vi.fn(async () => result);
    const onPollTriggered = vi.fn();
    const dataSource: SymphonyDataSource = { ...createApiModeDataSource(), triggerPoll };
    const container = await renderInteractiveDashboard({ dataSource, onPollTriggered });

    const button = buttonByText(container, "Trigger poll");
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("data-unavailable-action")).toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(triggerPoll).toHaveBeenCalledTimes(1);
    expect(onPollTriggered).toHaveBeenCalledWith(result);
    expect(container.textContent).toContain("Poll trigger queued: poll, reconcile");
    expect(container.textContent).toContain("2026-06-03T13:30:00.000Z");
  });

  it("surfaces Trigger poll command failures without a fake success", async () => {
    const triggerPoll = vi.fn(async () => {
      throw new Error("Symphony API returned HTTP 503");
    });
    const onPollTriggered = vi.fn();
    const dataSource: SymphonyDataSource = { ...createApiModeDataSource(), triggerPoll };
    const container = await renderInteractiveDashboard({ dataSource, onPollTriggered });

    await act(async () => {
      buttonByText(container, "Trigger poll").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(triggerPoll).toHaveBeenCalledTimes(1);
    expect(onPollTriggered).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Poll trigger failed: Symphony API returned HTTP 503");
    expect(container.textContent).not.toContain("Poll trigger queued");
  });

  it("renders Trigger poll as honestly unavailable when the active data source has no command route", () => {
    const markup = renderToStaticMarkup(
      <DataSourceProvider value={createApiModeDataSource()}>
        <DashboardView dashboard={dashboard} />
      </DataSourceProvider>,
    );

    expect(markup).toContain('data-unavailable-action="Trigger poll"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("/api/v1/refresh command");
  });
});
