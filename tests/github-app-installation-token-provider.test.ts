import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import { githubPublicationDoctorCheck, githubReviewFeedbackDoctorCheck } from "../src/doctor.js";
import { createGitHubPullRequestClientForCapability } from "../src/integrations/github/GitHubCredentialResolver.js";

describe("GitHub App installation token auth", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("parses env-backed app config without serializing private key material", () => {
    const secretPrivateKey = "env-config-sentinel-value-not-serialized";
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: { owner: "acme", repo: "symphony" },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_CLIENT_ID: "Iv1.client-id",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_APP_PRIVATE_KEY: secretPrivateKey,
      },
    );

    expect(config.github.app).toMatchObject({
      appId: "12345",
      clientId: "Iv1.client-id",
      installationId: "67890",
      privateKey: null,
      privateKeyEnvVar: "GITHUB_APP_PRIVATE_KEY",
      privateKeyPath: null,
      tokenRefreshBufferSeconds: 300,
    });
    const serialized = JSON.stringify(config.github.app);
    expect(serialized).not.toContain(secretPrivateKey);
    expect(serialized).not.toContain("secret-material");
  });

  it("falls back to the private key path when the default private key env var is empty", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "symphony-github-app-key-"));
    try {
      const keyPath = join(tempDir, "github-app-private-key.pem");
      await writeFile(keyPath, generatePrivateKey(), "utf8");
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          github: {
            owner: "acme",
            repo: "symphony",
            api_base_url: "https://api.github.test",
            publish_pull_requests: true,
            pr_handoff: { enabled: false },
            app: { app_id: "12345", client_id: "Iv1.client-id", installation_id: "67890" },
          },
        },
        join(tempDir, "WORKFLOW.md"),
        {
          LINEAR_API_KEY: "linear-secret",
          GITHUB_APP_PRIVATE_KEY: "",
          GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        },
      );
      expect(config.github.app).toMatchObject({
        privateKey: null,
        privateKeyEnvVar: null,
        privateKeyPath: keyPath,
      });

      const calls: FetchCall[] = [];
      vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const call = recordFetchCall(input, init);
        calls.push(call);
        if (call.url.pathname.endsWith("/access_tokens")) {
          return jsonResponse({ token: "ghs_path_backed_token", expires_at: "2026-01-01T01:00:00.000Z" });
        }
        return jsonResponse({ id: 1, full_name: "acme/symphony" });
      });

      await expect(githubPublicationDoctorCheck(config)).resolves.toEqual({
        id: "github.pr_publication",
        status: "ok",
        message: "GitHub PR publication can access acme/symphony using top-level GitHub App installation 67890",
      });
      await expect(githubReviewFeedbackDoctorCheck(config)).resolves.toEqual({
        id: "github.review_feedback_write",
        status: "ok",
        message: "GitHub PR review feedback can access acme/symphony using top-level GitHub App installation 67890",
      });
      expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        "POST /app/installations/67890/access_tokens",
        "GET /repos/acme/symphony",
        "POST /app/installations/67890/access_tokens",
        "GET /repos/acme/symphony",
      ]);
      expect(calls[1]?.authorization).toBe("Bearer ghs_path_backed_token");
      expect(calls[3]?.authorization).toBe("Bearer ghs_path_backed_token");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("honors an explicitly selected private key env var even when a key path is available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "symphony-github-app-key-"));
    try {
      const keyPath = join(tempDir, "github-app-private-key.pem");
      await writeFile(keyPath, generatePrivateKey(), "utf8");
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          github: {
            owner: "acme",
            repo: "symphony",
            api_base_url: "https://api.github.test",
            app: {
              app_id: "12345",
              installation_id: "67890",
              private_key: "$GITHUB_APP_PRIVATE_KEY",
              private_key_path: keyPath,
            },
          },
        },
        join(tempDir, "WORKFLOW.md"),
        {
          LINEAR_API_KEY: "linear-secret",
          GITHUB_APP_PRIVATE_KEY: "",
        },
      );
      expect(config.github.app).toMatchObject({ privateKeyEnvVar: "GITHUB_APP_PRIVATE_KEY", privateKeyPath: keyPath });

      await expect(
        createGitHubPullRequestClientForCapability(config, "github.publication", async () => {
          throw new Error("fetch should not be called when the explicit private key env var is empty");
        }).checkRepositoryAccess(),
      ).rejects.toMatchObject({
        code: "config_validation_error",
        message: "GitHub App private key environment variable GITHUB_APP_PRIVATE_KEY is unset or empty",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("mints an installation token at runtime and reuses it until the refresh window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const config = appServiceConfig({ token_refresh_buffer_seconds: 60 });
    const mintedTokens = ["ghs_variable_length_first", "ghs_second_token"];
    const expiresAt = ["2026-01-01T00:02:00.000Z", "2026-01-01T01:00:00.000Z"];
    const calls: FetchCall[] = [];
    let mintCount = 0;
    const client = createGitHubPullRequestClientForCapability(config, "github.publication", async (input, init) => {
      const call = recordFetchCall(input, init);
      calls.push(call);
      if (call.url.pathname === "/app/installations/67890/access_tokens") {
        const jwt = bearerToken(call.authorization);
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as {
          iss?: string;
          iat?: number;
          exp?: number;
        };
        expect(payload.iss).toBe("Iv1.client-id");
        expect(payload.iat).toBe(Math.floor(Date.now() / 1_000) - 60);
        expect(payload.exp).toBe(Math.floor(Date.now() / 1_000) + 9 * 60);
        const index = mintCount++;
        return jsonResponse({ token: mintedTokens[index], expires_at: expiresAt[index] });
      }
      expect(call.url.pathname).toBe("/repos/acme/symphony");
      return jsonResponse({ id: 1, full_name: "acme/symphony" });
    });

    await client.checkRepositoryAccess();
    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    await client.checkRepositoryAccess();
    vi.setSystemTime(new Date("2026-01-01T00:01:10.000Z"));
    await client.checkRepositoryAccess();

    expect(mintCount).toBe(2);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /app/installations/67890/access_tokens",
      "GET /repos/acme/symphony",
      "GET /repos/acme/symphony",
      "POST /app/installations/67890/access_tokens",
      "GET /repos/acme/symphony",
    ]);
    expect(calls.filter((call) => call.url.pathname === "/repos/acme/symphony").map((call) => call.authorization)).toEqual([
      "Bearer ghs_variable_length_first",
      "Bearer ghs_variable_length_first",
      "Bearer ghs_second_token",
    ]);
  });

  it("fails clearly for missing or invalid app credentials", async () => {
    const missingPrivateKey = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          api_base_url: "https://api.github.test",
          app: { app_id: "12345", installation_id: "67890" },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret" },
    );

    await expect(
      createGitHubPullRequestClientForCapability(missingPrivateKey, "github.publication", async () => {
        throw new Error("fetch should not be called without a private key");
      }).checkRepositoryAccess(),
    ).rejects.toMatchObject({
      code: "config_validation_error",
      message: "github.app.private_key or github.app.private_key_path is required for GitHub App installation auth",
    });

    const invalidPrivateKey = appServiceConfig({ private_key: "not a private key" });
    await expect(
      createGitHubPullRequestClientForCapability(invalidPrivateKey, "github.publication", async () => {
        throw new Error("fetch should not be called when JWT signing fails");
      }).checkRepositoryAccess(),
    ).rejects.toMatchObject({ code: "config_validation_error" });
  });

  it("redacts JWTs, private keys, and installation tokens from GitHub error details", async () => {
    const privateKey = generatePrivateKey();
    const mintFailureConfig = appServiceConfig({ private_key: privateKey });
    let mintJwt = "";
    try {
      await createGitHubPullRequestClientForCapability(mintFailureConfig, "github.publication", async (input, init) => {
        const call = recordFetchCall(input, init);
        mintJwt = bearerToken(call.authorization);
        return jsonResponse({ message: `bad jwt ${mintJwt} ${privateKey}` }, 401);
      }).checkRepositoryAccess();
      throw new Error("Expected minting to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("GitHub App installation token minting returned HTTP 401");
      expect(message).not.toContain(mintJwt);
      expect(message).not.toContain(privateKey);
      expect(message).toContain("[redacted]");
    }

    const token = "ghs_installation_token_with_no_fixed_length_assumption";
    const repoFailureConfig = appServiceConfig({ private_key: privateKey });
    try {
      await createGitHubPullRequestClientForCapability(repoFailureConfig, "github.review_feedback_write", async (input, init) => {
        const call = recordFetchCall(input, init);
        if (call.url.pathname.endsWith("/access_tokens")) {
          return jsonResponse({ token, expires_at: "2026-01-01T01:00:00.000Z" });
        }
        return jsonResponse({ message: `repository denied for ${token} Bearer ${token}` }, 403);
      }).checkRepositoryAccess();
      throw new Error("Expected repository access to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("GitHub repository access returned HTTP 403");
      expect(message).not.toContain(token);
      expect(message).toContain("[redacted]");
    }
  });

  it.each([
    {
      name: "top-level github.token ref",
      githubTokenConfig: "$GITHUB_TOKEN",
      legacyEnv: { GITHUB_TOKEN: "static-secret" },
      mintedToken: "ghs_top_level_app_token",
    },
    {
      name: "ambient GITHUB_TOKEN fallback",
      githubTokenConfig: undefined,
      legacyEnv: { GITHUB_TOKEN: "ambient-static-secret" },
      mintedToken: "ghs_ambient_app_token",
    },
    {
      name: "literal github.token",
      githubTokenConfig: "literal-static-secret",
      legacyEnv: {},
      mintedToken: "ghs_literal_app_token",
    },
  ])(
    "doctor defaults to App auth when App auth is mixed with $name",
    async ({ githubTokenConfig, legacyEnv, mintedToken }) => {
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          github: {
            owner: "acme",
            repo: "symphony",
            ...(githubTokenConfig === undefined ? {} : { token: githubTokenConfig }),
            api_base_url: "https://api.github.test",
            publish_pull_requests: true,
            pr_handoff: { enabled: false },
            app: {
              app_id: "12345",
              client_id: "Iv1.client-id",
              installation_id: "67890",
              private_key: generatePrivateKey(),
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "linear-secret", ...legacyEnv },
      );
      const calls: FetchCall[] = [];
      vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const call = recordFetchCall(input, init);
        calls.push(call);
        if (call.url.pathname.endsWith("/access_tokens")) {
          return jsonResponse({ token: mintedToken, expires_at: "2026-01-01T01:00:00.000Z" });
        }
        return jsonResponse({ id: 1, full_name: "acme/symphony" });
      });

      await expect(githubPublicationDoctorCheck(config)).resolves.toEqual({
        id: "github.pr_publication",
        status: "ok",
        message: "GitHub PR publication can access acme/symphony using top-level GitHub App installation 67890",
      });
      await expect(githubReviewFeedbackDoctorCheck(config)).resolves.toEqual({
        id: "github.review_feedback_write",
        status: "ok",
        message: "GitHub PR review feedback can access acme/symphony using top-level GitHub App installation 67890",
      });
      expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        "POST /app/installations/67890/access_tokens",
        "GET /repos/acme/symphony",
        "POST /app/installations/67890/access_tokens",
        "GET /repos/acme/symphony",
      ]);
      expect(calls.filter((call) => call.url.pathname === "/repos/acme/symphony").map((call) => call.authorization)).toEqual([
        `Bearer ${mintedToken}`,
        `Bearer ${mintedToken}`,
      ]);
      expect(calls.map((call) => call.authorization)).not.toContain("Bearer static-secret");
      expect(calls.map((call) => call.authorization)).not.toContain("Bearer ambient-static-secret");
      expect(calls.map((call) => call.authorization)).not.toContain("Bearer literal-static-secret");
    },
  );

  it("doctor validates App-backed repository access and reports the installation", async () => {
    const config = appServiceConfig({ private_key: generatePrivateKey() });
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const call = recordFetchCall(input, init);
      calls.push(call);
      if (call.url.pathname.endsWith("/access_tokens")) {
        return jsonResponse({ token: "ghs_short", expires_at: "2026-01-01T01:00:00.000Z" });
      }
      return jsonResponse({ id: 1, full_name: "acme/symphony" });
    });

    await expect(githubPublicationDoctorCheck(config)).resolves.toEqual({
      id: "github.pr_publication",
      status: "ok",
      message: "GitHub PR publication can access acme/symphony using top-level GitHub App installation 67890",
    });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /app/installations/67890/access_tokens",
      "GET /repos/acme/symphony",
    ]);
  });

  it("mints installation tokens from distinct app-backed credential profiles", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          api_base_url: "https://api.github.test",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
        credential_profiles: {
          profiles: {
            publication: {
              kind: "github_app",
              app_id: "111",
              client_id: "Iv1.publication",
              installation_id: "222",
              private_key: generatePrivateKey(),
              capabilities: ["github.publication", "github.merge"],
            },
            reviewer: {
              kind: "github_app",
              app_id: "333",
              client_id: "Iv1.reviewer",
              installation_id: "444",
              private_key: generatePrivateKey(),
              capabilities: ["github.review_feedback_write"],
            },
          },
          roles: {
            service: {
              "github.publication": "publication",
              "github.merge": "publication",
            },
            reviewer: {
              "github.review_feedback_write": "reviewer",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret" },
    );
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const call = recordFetchCall(input, init);
      calls.push(call);
      if (call.url.pathname === "/app/installations/222/access_tokens") {
        return jsonResponse({ token: "ghs_publication_app_token", expires_at: "2026-01-01T01:00:00.000Z" });
      }
      if (call.url.pathname === "/app/installations/444/access_tokens") {
        return jsonResponse({ token: "ghs_reviewer_app_token", expires_at: "2026-01-01T01:00:00.000Z" });
      }
      return jsonResponse({ id: 1, full_name: "acme/symphony" });
    });

    await expect(githubPublicationDoctorCheck(config)).resolves.toEqual({
      id: "github.pr_publication",
      status: "ok",
      message: "GitHub PR publication can access acme/symphony using GitHub App profile publication installation 222",
    });
    await expect(githubReviewFeedbackDoctorCheck(config)).resolves.toEqual({
      id: "github.review_feedback_write",
      status: "ok",
      message: "GitHub PR review feedback can access acme/symphony using GitHub App profile reviewer installation 444",
    });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /app/installations/222/access_tokens",
      "GET /repos/acme/symphony",
      "POST /app/installations/444/access_tokens",
      "GET /repos/acme/symphony",
    ]);
    expect(calls.filter((call) => call.url.pathname === "/repos/acme/symphony").map((call) => call.authorization)).toEqual([
      "Bearer ghs_publication_app_token",
      "Bearer ghs_reviewer_app_token",
    ]);
  });
});

interface FetchCall {
  url: URL;
  method: string;
  authorization: string;
}

function appServiceConfig(appOverrides: Record<string, unknown> = {}): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      github: {
        owner: "acme",
        repo: "symphony",
        api_base_url: "https://api.github.test",
        publish_pull_requests: true,
        pr_handoff: { enabled: false },
        app: {
          app_id: "12345",
          client_id: "Iv1.client-id",
          installation_id: "67890",
          private_key: generatePrivateKey(),
          ...appOverrides,
        },
      },
    },
    "/repo/WORKFLOW.md",
    { LINEAR_API_KEY: "linear-secret" },
  );
}

function generatePrivateKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

function recordFetchCall(input: Parameters<typeof fetch>[0], init?: RequestInit): FetchCall {
  const headers = init?.headers as Record<string, string> | undefined;
  return {
    url: new URL(String(input)),
    method: init?.method ?? "GET",
    authorization: headers?.authorization ?? "",
  };
}

function bearerToken(authorization: string): string {
  const prefix = "Bearer ";
  expect(authorization.startsWith(prefix)).toBe(true);
  return authorization.slice(prefix.length);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
