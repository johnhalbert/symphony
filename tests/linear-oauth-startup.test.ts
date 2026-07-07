import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDotEnvFile, WorkflowLoader } from "../src/core/workflow/WorkflowLoader.js";
import {
  ensureLinearOAuthStartupAuth,
  requestLinearClientCredentialsToken,
  upsertDotEnvValueText,
} from "../src/integrations/linear/LinearOAuthStartup.js";

interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

describe("Linear OAuth startup auth", () => {
  it("continues with a valid current token without requesting or storing a replacement", async () => {
    const fixture = await createWorkflowFixture([
      'LINEAR_API_KEY="Bearer current-token"',
      "LINEAR_OAUTH_CLIENT_ID=client-id",
      "LINEAR_OAUTH_CLIENT_SECRET=client-secret",
    ]);
    try {
      const originalEnv = await readFile(fixture.envPath, "utf8");
      const { fetchImpl, requests } = recordingFetch((request) => {
        expect(request.url).toBe("https://api.linear.app/graphql");
        expect(request.headers.authorization).toBe("Bearer current-token");
        return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
      });

      const result = await ensureLinearOAuthStartupAuth({
        workflowPath: fixture.workflowPath,
        parentEnv: {},
        fetchImpl,
      });

      expect(result.status).toBe("valid");
      expect(requests).toHaveLength(1);
      expect(await readFile(fixture.envPath, "utf8")).toBe(originalEnv);
    } finally {
      await fixture.cleanup();
    }
  });

  it("requests and stores a new token when the current token is missing", async () => {
    const fixture = await createWorkflowFixture([
      "LINEAR_OAUTH_CLIENT_ID=client-id",
      "LINEAR_OAUTH_CLIENT_SECRET=client-secret",
    ]);
    const parentEnv: NodeJS.ProcessEnv = {};
    try {
      const { fetchImpl, requests } = recordingFetch((request) => {
        expect(request.url).toBe("https://api.linear.app/oauth/token");
        expect(Buffer.from((request.headers.authorization ?? "").replace(/^Basic /u, ""), "base64").toString("utf8")).toBe(
          "client-id:client-secret",
        );
        const form = new URLSearchParams(request.body);
        expect(form.get("grant_type")).toBe("client_credentials");
        expect(form.get("scope")).toBe("read,write");
        return jsonResponse({ access_token: "new-token", token_type: "Bearer", expires_in: 2_591_999 });
      });

      const result = await ensureLinearOAuthStartupAuth({
        workflowPath: fixture.workflowPath,
        parentEnv,
        fetchImpl,
      });

      expect(result.status).toBe("refreshed");
      expect(requests).toHaveLength(1);
      const parsed = parseDotEnvFile(await readFile(fixture.envPath, "utf8"));
      expect(parsed.LINEAR_API_KEY).toBe("Bearer new-token");
      expect(parentEnv.LINEAR_API_KEY).toBe("Bearer new-token");
    } finally {
      await fixture.cleanup();
    }
  });

  it("requests and stores a new token when Linear rejects the current token", async () => {
    const fixture = await createWorkflowFixture([
      'LINEAR_API_KEY="Bearer expired-token"',
      "LINEAR_OAUTH_CLIENT_ID=client-id",
      "LINEAR_OAUTH_CLIENT_SECRET=client-secret",
    ]);
    try {
      const { fetchImpl, requests } = recordingFetch((request, index) => {
        if (index === 0) return new Response("unauthorized", { status: 401 });
        expect(request.url).toBe("https://api.linear.app/oauth/token");
        return jsonResponse({ access_token: "replacement-token", token_type: "Bearer", expires_in: 2_591_999 });
      });

      const result = await ensureLinearOAuthStartupAuth({
        workflowPath: fixture.workflowPath,
        parentEnv: {},
        fetchImpl,
      });

      expect(result.status).toBe("refreshed");
      expect(requests).toHaveLength(2);
      const parsed = parseDotEnvFile(await readFile(fixture.envPath, "utf8"));
      expect(parsed.LINEAR_API_KEY).toBe("Bearer replacement-token");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when the current token is invalid and client credentials are missing", async () => {
    const fixture = await createWorkflowFixture(['LINEAR_API_KEY="Bearer expired-token"']);
    try {
      const originalEnv = await readFile(fixture.envPath, "utf8");
      const { fetchImpl, requests } = recordingFetch(() => new Response("forbidden", { status: 403 }));

      await expect(
        ensureLinearOAuthStartupAuth({
          workflowPath: fixture.workflowPath,
          parentEnv: {},
          fetchImpl,
        }),
      ).rejects.toThrow("LINEAR_OAUTH_CLIENT_ID/LINEAR_OAUTH_CLIENT_SECRET");

      expect(requests).toHaveLength(1);
      expect(await readFile(fixture.envPath, "utf8")).toBe(originalEnv);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not rotate the token for non-auth validation failures", async () => {
    const fixture = await createWorkflowFixture([
      'LINEAR_API_KEY="Bearer current-token"',
      "LINEAR_OAUTH_CLIENT_ID=client-id",
      "LINEAR_OAUTH_CLIENT_SECRET=client-secret",
    ]);
    try {
      const originalEnv = await readFile(fixture.envPath, "utf8");
      const { fetchImpl, requests } = recordingFetch(() => new Response("unavailable", { status: 500 }));

      await expect(
        ensureLinearOAuthStartupAuth({
          workflowPath: fixture.workflowPath,
          parentEnv: {},
          fetchImpl,
        }),
      ).rejects.toThrow("HTTP 500");

      expect(requests).toHaveLength(1);
      expect(await readFile(fixture.envPath, "utf8")).toBe(originalEnv);
    } finally {
      await fixture.cleanup();
    }
  });

  it("honors LINEAR_OAUTH_SCOPES when requesting a client credentials token", async () => {
    const { fetchImpl } = recordingFetch((request) => {
      const form = new URLSearchParams(request.body);
      expect(form.get("scope")).toBe("read");
      return jsonResponse({ access_token: "scoped-token", token_type: "Bearer" });
    });

    await expect(
      requestLinearClientCredentialsToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        scopes: "read",
        fetchImpl,
      }),
    ).resolves.toBe("Bearer scoped-token");
  });

  it("rejects malformed client credentials token responses", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ token_type: "Bearer" }));

    await expect(
      requestLinearClientCredentialsToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        fetchImpl,
      }),
    ).rejects.toThrow("missing access_token");
  });

  it("preserves unrelated dotenv content while replacing or appending the target key", () => {
    const replaced = upsertDotEnvValueText(
      ["# keep this", "OTHER=1", "LINEAR_API_KEY=old", "export KEEP_EXPORT=yes", ""].join("\n"),
      "LINEAR_API_KEY",
      "Bearer new token",
    );
    expect(replaced).toContain("# keep this");
    expect(replaced).toContain("OTHER=1");
    expect(replaced).toContain("export KEEP_EXPORT=yes");
    expect(parseDotEnvFile(replaced).LINEAR_API_KEY).toBe("Bearer new token");

    const appended = upsertDotEnvValueText("OTHER=1\n", "LINEAR_API_KEY", "Bearer appended");
    expect(parseDotEnvFile(appended).LINEAR_API_KEY).toBe("Bearer appended");
    expect(appended).toMatch(/LINEAR_API_KEY="Bearer appended"\n$/u);
  });

  it("updates process env so a subsequent workflow reload uses the refreshed token", async () => {
    const fixture = await createWorkflowFixture([
      "LINEAR_OAUTH_CLIENT_ID=client-id",
      "LINEAR_OAUTH_CLIENT_SECRET=client-secret",
    ]);
    const previous = snapshotEnv([
      "LINEAR_API_KEY",
      "LINEAR_OAUTH_CLIENT_ID",
      "LINEAR_OAUTH_CLIENT_SECRET",
      "LINEAR_OAUTH_SCOPES",
    ]);
    try {
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_OAUTH_CLIENT_ID;
      delete process.env.LINEAR_OAUTH_CLIENT_SECRET;
      delete process.env.LINEAR_OAUTH_SCOPES;
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse({ access_token: "reload-token", token_type: "Bearer", expires_in: 2_591_999 }),
      );

      await expect(
        ensureLinearOAuthStartupAuth({
          workflowPath: fixture.workflowPath,
          parentEnv: process.env,
          fetchImpl,
        }),
      ).resolves.toMatchObject({ status: "refreshed" });

      const loaded = await new WorkflowLoader(fixture.workflowPath).load();
      expect(loaded.serviceConfig.tracker.apiKey).toBe("Bearer reload-token");
    } finally {
      restoreEnv(previous);
      await fixture.cleanup();
    }
  });
});

async function createWorkflowFixture(envLines: string[]): Promise<{
  root: string;
  workflowPath: string;
  envPath: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-linear-oauth-"));
  const workflowPath = path.join(root, "WORKFLOW.md");
  const envPath = path.join(root, ".env");
  await writeFile(envPath, `${envLines.join("\n")}\n`, "utf8");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: TEST
---
Work on {{ issue.identifier }}.
`,
    "utf8",
  );
  return {
    root,
    workflowPath,
    envPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function recordingFetch(
  handler: (request: RecordedRequest, index: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const request: RecordedRequest = {
      url: String(url),
      method: init?.method,
      headers: normalizeHeaders(init?.headers),
      body: String(init?.body ?? ""),
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function normalizeHeaders(headers: NonNullable<Parameters<typeof fetch>[1]>["headers"] | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), value]));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
