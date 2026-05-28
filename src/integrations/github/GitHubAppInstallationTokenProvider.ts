import { createSign } from "node:crypto";
import { promises as fs } from "node:fs";
import type { GitHubAppConfig } from "../../core/config/Config.js";
import { SymphonyError } from "../../core/errors.js";

const GITHUB_APP_JWT_CLOCK_SKEW_SECONDS = 60;
const GITHUB_APP_JWT_TTL_SECONDS = 9 * 60;

type FetchLike = typeof fetch;

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

export class GitHubAppInstallationTokenProvider {
  #cached: CachedInstallationToken | null = null;
  #pending: Promise<CachedInstallationToken> | null = null;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  describe(): string {
    const installationId = this.config.installationId?.trim();
    return installationId ? "GitHub App installation " + installationId : "GitHub App installation";
  }

  async getToken(): Promise<string> {
    const nowMs = Date.now();
    if (this.isUsable(this.#cached, nowMs)) {
      return this.#cached.token;
    }
    if (this.#pending) {
      const pending = await this.#pending;
      this.#cached = pending;
      return pending.token;
    }

    this.#pending = this.mintToken(nowMs);
    try {
      const minted = await this.#pending;
      this.#cached = minted;
      return minted.token;
    } finally {
      this.#pending = null;
    }
  }

  private isUsable(token: CachedInstallationToken | null, nowMs: number): token is CachedInstallationToken {
    return token !== null && token.expiresAtMs - nowMs > this.refreshBufferMs();
  }

  private refreshBufferMs(): number {
    return Math.max(0, this.config.tokenRefreshBufferSeconds) * 1_000;
  }

  private async mintToken(nowMs: number): Promise<CachedInstallationToken> {
    const appId = requireConfigField(this.config.appId, "github.app.app_id");
    const installationId = requireConfigField(this.config.installationId, "github.app.installation_id");
    const privateKey = await this.loadPrivateKey();
    let jwt: string;
    try {
      jwt = createGitHubAppJwt({
        issuer: this.config.clientId?.trim() || appId,
        privateKey,
        nowMs,
      });
    } catch (error) {
      throw new SymphonyError(
        "config_validation_error",
        "GitHub App private key could not sign installation JWT: " + errorMessage(error),
      );
    }

    const response = await this.fetchImpl(installationAccessTokenUrl(this.apiBaseUrl, installationId), {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + jwt,
        "user-agent": "symphony",
        "x-github-api-version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const detail = await githubAppErrorDetail(response, [jwt, privateKey]);
      throw new SymphonyError(
        "tracker_error",
        detail.length === 0
          ? "GitHub App installation token minting returned HTTP " + response.status
          : "GitHub App installation token minting returned HTTP " + response.status + ": " + detail,
      );
    }

    const body = (await response.json()) as Record<string, unknown>;
    const rawToken = asString(body.token)?.trim() ?? "";
    const expiresAt = asString(body.expires_at)?.trim() ?? "";
    const expiresAtMs = Date.parse(expiresAt);
    if (rawToken.length === 0 || !Number.isFinite(expiresAtMs)) {
      throw new SymphonyError("tracker_error", "GitHub App installation token response is invalid");
    }

    return { token: rawToken, expiresAtMs };
  }

  private async loadPrivateKey(): Promise<string> {
    const inlinePrivateKey = normalizePrivateKeyText(this.config.privateKey ?? "");
    if (inlinePrivateKey.trim().length > 0) {
      return inlinePrivateKey;
    }

    if (this.config.privateKeyEnvVar) {
      const value = process.env[this.config.privateKeyEnvVar] ?? "";
      if (value.trim().length === 0) {
        throw new SymphonyError(
          "config_validation_error",
          "GitHub App private key environment variable " + this.config.privateKeyEnvVar + " is unset or empty",
        );
      }
      return normalizePrivateKeyText(value);
    }

    if (this.config.privateKeyPath) {
      try {
        const value = normalizePrivateKeyText(await fs.readFile(this.config.privateKeyPath, "utf8"));
        if (value.trim().length === 0) {
          throw new SymphonyError("config_validation_error", "GitHub App private key file is empty");
        }
        return value;
      } catch (error) {
        if (error instanceof SymphonyError) throw error;
        throw new SymphonyError(
          "config_validation_error",
          "GitHub App private key file could not be read: " + errorMessage(error),
        );
      }
    }

    throw new SymphonyError(
      "config_validation_error",
      "github.app.private_key or github.app.private_key_path is required for GitHub App installation auth",
    );
  }
}

function createGitHubAppJwt(input: { issuer: string; privateKey: string; nowMs: number }): string {
  const nowSeconds = Math.floor(input.nowMs / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - GITHUB_APP_JWT_CLOCK_SKEW_SECONDS,
      exp: nowSeconds + GITHUB_APP_JWT_TTL_SECONDS,
      iss: input.issuer,
    }),
  );
  const signingInput = header + "." + payload;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(input.privateKey);
  return signingInput + "." + base64Url(signature);
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function installationAccessTokenUrl(apiBaseUrl: string, installationId: string): URL {
  return new URL(
    "app/installations/" + encodeURIComponent(installationId) + "/access_tokens",
    normalizedApiBaseUrl(apiBaseUrl),
  );
}

function normalizedApiBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : trimmed + "/";
}

function requireConfigField(value: string | null, path: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new SymphonyError("config_validation_error", path + " is required for GitHub App installation auth");
  }
  return trimmed;
}

function normalizePrivateKeyText(value: string): string {
  const newline = "\n";
  return value.includes("\n") && !value.includes(newline) ? value.replace(/\n/g, newline) : value;
}

async function githubAppErrorDetail(response: Response, secrets: string[]): Promise<string> {
  let text = "";
  try {
    const body = (await response.clone().json()) as unknown;
    if (isRecord(body)) {
      const message = asString(body.message);
      const errors = Array.isArray(body.errors)
        ? body.errors
            .map((error) => (isRecord(error) ? asString(error.message) : null))
            .filter((item): item is string => item !== null)
        : [];
      text = [message, ...errors].filter((item): item is string => item !== null && item.length > 0).join("; ");
    }
  } catch {
    try {
      text = await response.text();
    } catch {
      text = "";
    }
  }
  return redactSensitiveText(text, secrets).slice(0, 500);
}

function redactSensitiveText(input: string, secrets: string[]): string {
  let redacted = input;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, (_match, scheme: string) => scheme + " [redacted]");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
