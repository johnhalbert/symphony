import { describe, expect, it } from "vitest";
import { Cursor } from "@cursor/sdk";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { LinearTrackerClient } from "../src/integrations/linear/LinearTrackerClient.js";

const realSmoke = process.env.SYMPHONY_REAL_SMOKE === "1" ? describe : describe.skip;

realSmoke("real integration smoke tests", () => {
  it("can list Cursor models with CURSOR_API_KEY", async () => {
    const apiKey = process.env.CURSOR_API_KEY;
    expect(apiKey, "CURSOR_API_KEY is required").toBeTruthy();
    const result = await Cursor.models.list({ apiKey: apiKey ?? "" });
    expect(result.length).toBeGreaterThan(0);
  });

  it("can fetch Linear candidates with LINEAR_API_KEY and LINEAR_PROJECT_SLUG", async () => {
    expect(process.env.LINEAR_API_KEY, "LINEAR_API_KEY is required").toBeTruthy();
    expect(process.env.LINEAR_PROJECT_SLUG, "LINEAR_PROJECT_SLUG is required").toBeTruthy();
    const config = parseServiceConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: process.env.LINEAR_PROJECT_SLUG,
        },
      },
      `${process.cwd()}/WORKFLOW.md`,
    );
    const client = new LinearTrackerClient(config.tracker);
    await expect(client.fetchCandidateIssues()).resolves.toEqual(expect.any(Array));
  });

  it("can fetch Linear project workflow states with LINEAR_API_KEY and LINEAR_PROJECT_SLUG", async () => {
    expect(process.env.LINEAR_API_KEY, "LINEAR_API_KEY is required").toBeTruthy();
    expect(process.env.LINEAR_PROJECT_SLUG, "LINEAR_PROJECT_SLUG is required").toBeTruthy();
    const config = parseServiceConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: process.env.LINEAR_PROJECT_SLUG,
        },
      },
      `${process.cwd()}/WORKFLOW.md`,
    );
    const client = new LinearTrackerClient(config.tracker);
    const teams = await client.fetchWorkflowStatesByTeam();
    expect(teams.length).toBeGreaterThan(0);
    expect(teams[0]?.teamKey).toEqual(expect.any(String));
    await expect(client.fetchWorkflowStateNames()).resolves.toEqual(expect.any(Array));
  });
});
