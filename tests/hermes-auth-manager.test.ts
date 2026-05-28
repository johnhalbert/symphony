import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HermesAuthManager,
  normalizeHermesAuthProvider,
  redactHermesAuthMessage,
} from "../hermes/src/HermesAuthManager.js";

let root: string;

describe("HermesAuthManager", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-auth-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("bootstraps only selected provider auth into the managed root", async () => {
    const bootstrapFrom = path.join(root, "local-hermes");
    const managedRoot = path.join(root, "managed-auth");
    await writeAuthStore(bootstrapFrom, {
      version: 1,
      active_provider: "anthropic",
      providers: {
        "openai-codex": codexProviderState("source-access"),
        anthropic: { access_token: "anthropic-secret" },
      },
      credential_pool: {
        "openai-codex": [{ source: "device_code", access_token: "source-access" }],
        anthropic: [{ api_key: "anthropic-secret" }],
      },
    });

    const manager = managerFor({ managedRoot, bootstrapFrom, providers: ["openai-codex"] });
    await expect(manager.prepare()).resolves.toMatchObject({
      copiedProviders: ["openai-codex"],
      missingProviders: [],
    });

    const managed = JSON.parse(await readFile(path.join(managedRoot, "auth.json"), "utf8")) as Record<string, any>;
    expect(managed.providers).toEqual({ "openai-codex": codexProviderState("source-access") });
    expect(managed.credential_pool).toEqual({ "openai-codex": [{ source: "device_code", access_token: "source-access" }] });
    expect(managed.active_provider).toBe("openai-codex");
  });

  it("does not overwrite existing managed provider state", async () => {
    const bootstrapFrom = path.join(root, "local-hermes");
    const managedRoot = path.join(root, "managed-auth");
    await writeAuthStore(bootstrapFrom, {
      version: 1,
      providers: { "openai-codex": codexProviderState("source-access") },
    });
    await writeAuthStore(managedRoot, {
      version: 1,
      providers: { "openai-codex": codexProviderState("managed-access") },
    });

    const manager = managerFor({ managedRoot, bootstrapFrom, providers: ["openai-codex"] });
    await expect(manager.prepare()).resolves.toMatchObject({
      presentProviders: ["openai-codex"],
      copiedProviders: [],
      missingProviders: [],
    });

    const managed = JSON.parse(await readFile(path.join(managedRoot, "auth.json"), "utf8")) as Record<string, any>;
    expect(managed.providers["openai-codex"]).toEqual(codexProviderState("managed-access"));
  });

  it("reports missing and malformed bootstrap auth without leaking token-like values", async () => {
    const missingManager = managerFor({
      managedRoot: path.join(root, "managed-auth"),
      bootstrapFrom: path.join(root, "missing-hermes"),
      providers: ["openai-codex"],
    });

    await expect(missingManager.prepare()).resolves.toMatchObject({
      missingProviders: ["openai-codex"],
    });

    const malformedRoot = path.join(root, "malformed-hermes");
    await mkdir(malformedRoot, { recursive: true });
    await writeFile(path.join(malformedRoot, "auth.json"), '{"providers":', "utf8");

    const malformedManager = managerFor({
      managedRoot: path.join(root, "managed-auth-2"),
      bootstrapFrom: malformedRoot,
      providers: ["openai-codex"],
    });
    await expect(malformedManager.prepare()).rejects.toThrow(/Hermes bootstrap auth store is malformed/);
    expect(redactHermesAuthMessage('{"access_token":"sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz"}')).not.toContain(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
  });

  it("normalizes Codex provider aliases", () => {
    expect(normalizeHermesAuthProvider("codex")).toBe("openai-codex");
    expect(normalizeHermesAuthProvider("openai_codex")).toBe("openai-codex");
    expect(normalizeHermesAuthProvider("OpenAI-Codex")).toBe("openai-codex");
  });
});

function managerFor(input: { managedRoot: string; bootstrapFrom: string; providers: string[] }): HermesAuthManager {
  return new HermesAuthManager({
    ...input,
    upstreamRoot: path.join(root, "upstream"),
    python: "python",
    timeoutMs: 1_000,
  });
}

async function writeAuthStore(rootDir: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(path.join(rootDir, "auth.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function codexProviderState(accessToken: string): Record<string, unknown> {
  return {
    tokens: {
      access_token: accessToken,
      refresh_token: "refresh-token",
    },
    last_refresh: "2026-05-27T00:00:00Z",
    auth_mode: "chatgpt",
  };
}
