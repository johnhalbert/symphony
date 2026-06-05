import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- The browser smoke harness is authored as plain ESM; this focused test imports it directly to verify the fixture contract.
import { startFixtureBackend } from "../scripts/browser-smoke.mjs";

type SmokeProjection = {
  state: string;
  conversation?: { status?: string; messageCount?: number };
  chat?: Array<{ who?: string; text?: string; status?: string }>;
};

describe("browser smoke harness fixture backend", () => {
  let closeBackend: null | (() => Promise<void>) = null;

  afterEach(async () => {
    if (closeBackend) {
      await closeBackend();
      closeBackend = null;
    }
  });

  it("persists pending durable orchestrator chat state across POST, dashboard/sidebar reads, and follow-up GETs", async () => {
    const backend = await startFixtureBackend();
    closeBackend = backend.close;

    const initialResponse = await fetch(`${backend.baseUrl}/api/v1/web/orchestrator-chat`);
    expect(initialResponse.status).toBe(200);
    const initialProjection = await initialResponse.json() as SmokeProjection;
    expect(initialProjection).toMatchObject({
      state: "completed",
      conversation: { status: "completed", messageCount: 1 },
      chat: [{ who: "agent", text: "Fixture chat from local backend.", status: "completed" }],
    });

    const submittedInput = "Fixture backend pending smoke message";
    const postResponse = await fetch(`${backend.baseUrl}/api/v1/web/orchestrator-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: submittedInput }),
    });
    expect(postResponse.status).toBe(202);
    const postProjection = await postResponse.json() as SmokeProjection;
    expect(postProjection).toMatchObject({
      state: "pending",
      conversation: { status: "pending", messageCount: 2 },
    });
    expect(postProjection.chat?.at(-1)).toMatchObject({
      who: "user",
      text: submittedInput,
      status: "pending",
    });

    const dashboardResponse = await fetch(`${backend.baseUrl}/api/v1/web/dashboard`);
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json() as { chat?: SmokeProjection["chat"] };
    expect(dashboard.chat?.at(-1)).toMatchObject({
      who: "user",
      text: submittedInput,
      status: "pending",
    });

    const sidebarResponse = await fetch(`${backend.baseUrl}/api/v1/web/sidebar`);
    expect(sidebarResponse.status).toBe(200);
    const sidebar = await sidebarResponse.json() as { chat?: SmokeProjection["chat"] };
    expect(sidebar.chat?.at(-1)).toMatchObject({
      who: "user",
      text: submittedInput,
      status: "pending",
    });

    const followUpResponse = await fetch(`${backend.baseUrl}/api/v1/web/orchestrator-chat`);
    expect(followUpResponse.status).toBe(200);
    const followUpProjection = await followUpResponse.json() as SmokeProjection;
    expect(followUpProjection).toMatchObject({
      state: "pending",
      conversation: { status: "pending", messageCount: 2 },
    });
    expect(followUpProjection.chat?.at(-1)).toMatchObject({
      who: "user",
      text: submittedInput,
      status: "pending",
    });
  });
});
