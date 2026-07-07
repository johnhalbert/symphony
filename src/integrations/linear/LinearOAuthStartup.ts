import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveConfigString, type RawWorkflowConfig } from "../../core/config/Config.js";
import { SymphonyError, errorMessage } from "../../core/errors.js";
import {
  loadWorkflowEnvironment,
  parseWorkflowFile,
  readWorkflowFile,
} from "../../core/workflow/WorkflowLoader.js";

type FetchLike = typeof fetch;

interface LinearGraphQlResponse<T> {
  data?: T;
  errors?: unknown[];
}

interface LinearStartupTokenBinding {
  authorizationHeader: string;
  endpoint: string;
  envVar: string | null;
}

export type LinearStartupAuthStatus = "valid" | "refreshed";

export interface LinearStartupAuthResult {
  status: LinearStartupAuthStatus;
  envPath: string;
  tokenEnvVar: string | null;
}

export interface LinearStartupAuthOptions {
  workflowPath: string;
  parentEnv?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: FetchLike | undefined;
  tokenEndpoint?: string | undefined;
}

export type LinearStartupTokenValidation =
  | { status: "valid" }
  | { status: "invalid"; reason: "missing" | "unauthorized" | "graphql_auth_error" };

export interface LinearStartupTokenValidationOptions {
  endpoint: string;
  authorizationHeader: string;
  fetchImpl?: FetchLike | undefined;
}

export interface LinearClientCredentialsTokenOptions {
  clientId: string;
  clientSecret: string;
  scopes?: string | undefined;
  tokenEndpoint?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

const DEFAULT_LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_OAUTH_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const DEFAULT_LINEAR_OAUTH_SCOPES = "read,write";
const STARTUP_VIEWER_QUERY = `
  query SymphonyLinearStartupAuth {
    viewer { id }
  }
`;

export async function ensureLinearOAuthStartupAuth(
  options: LinearStartupAuthOptions,
): Promise<LinearStartupAuthResult> {
  const workflowPath = path.resolve(options.workflowPath);
  const parentEnv = options.parentEnv ?? process.env;
  const definition = parseWorkflowFile(await readWorkflowFile(workflowPath), workflowPath);
  const env = await loadWorkflowEnvironment(workflowPath, parentEnv);
  const binding = resolveLinearStartupTokenBinding(definition.config, env);
  const validation = await validateLinearStartupToken({
    endpoint: binding.endpoint,
    authorizationHeader: binding.authorizationHeader,
    fetchImpl: options.fetchImpl,
  });
  const envPath = linearWorkflowEnvPath(workflowPath);
  if (validation.status === "valid") {
    return { status: "valid", envPath, tokenEnvVar: binding.envVar };
  }

  if (binding.envVar === null) {
    throw new SymphonyError(
      "tracker_error",
      "Linear startup OAuth refresh requires tracker.api_key to reference an environment variable",
    );
  }

  const clientId = normalizeOptionalString(env.LINEAR_OAUTH_CLIENT_ID);
  const clientSecret = normalizeOptionalString(env.LINEAR_OAUTH_CLIENT_SECRET);
  if (clientId === null || clientSecret === null) {
    throw new SymphonyError(
      "tracker_error",
      "Linear startup token is invalid and LINEAR_OAUTH_CLIENT_ID/LINEAR_OAUTH_CLIENT_SECRET are required to refresh it",
    );
  }

  const authorizationHeader = await requestLinearClientCredentialsToken({
    clientId,
    clientSecret,
    scopes: env.LINEAR_OAUTH_SCOPES,
    tokenEndpoint: options.tokenEndpoint,
    fetchImpl: options.fetchImpl,
  });
  await upsertDotEnvValue(envPath, binding.envVar, authorizationHeader);
  parentEnv[binding.envVar] = authorizationHeader;
  return { status: "refreshed", envPath, tokenEnvVar: binding.envVar };
}

export async function validateLinearStartupToken(
  options: LinearStartupTokenValidationOptions,
): Promise<LinearStartupTokenValidation> {
  const authorizationHeader = options.authorizationHeader.trim();
  if (authorizationHeader.length === 0) return { status: "invalid", reason: "missing" };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorizationHeader,
      },
      body: JSON.stringify({ query: STARTUP_VIEWER_QUERY, variables: {} }),
    });
  } catch (error) {
    throw new SymphonyError(
      "tracker_error",
      `Linear startup token validation failed before receiving a response: ${errorMessage(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "invalid", reason: "unauthorized" };
  }
  if (!response.ok) {
    throw new SymphonyError("tracker_error", `Linear startup token validation returned HTTP ${response.status}`);
  }

  const body = await readJsonResponse<LinearGraphQlResponse<{ viewer?: { id?: unknown } | null }>>(
    response,
    "Linear startup token validation response was not valid JSON",
  );
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    if (linearGraphQlErrorsLookAuthRelated(body.errors)) {
      return { status: "invalid", reason: "graphql_auth_error" };
    }
    throw new SymphonyError("tracker_error", "Linear startup token validation returned GraphQL errors");
  }
  const viewerId = body.data?.viewer?.id;
  if (typeof viewerId !== "string" || viewerId.trim().length === 0) {
    throw new SymphonyError("tracker_error", "Linear startup token validation response was missing viewer identity");
  }
  return { status: "valid" };
}

export async function requestLinearClientCredentialsToken(
  options: LinearClientCredentialsTokenOptions,
): Promise<string> {
  const scope = normalizeOptionalString(options.scopes) ?? DEFAULT_LINEAR_OAUTH_SCOPES;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope,
  });
  const authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString("base64")}`;

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.tokenEndpoint ?? DEFAULT_LINEAR_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization,
      },
      body: body.toString(),
    });
  } catch (error) {
    throw new SymphonyError(
      "tracker_error",
      `Linear OAuth client credentials request failed before receiving a response: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new SymphonyError("tracker_error", `Linear OAuth client credentials request returned HTTP ${response.status}`);
  }

  const token = await readJsonResponse<Record<string, unknown>>(
    response,
    "Linear OAuth client credentials response was not valid JSON",
  );
  const accessToken = asNonemptyString(token.access_token);
  const tokenType = asNonemptyString(token.token_type);
  if (accessToken === null) {
    throw new SymphonyError("tracker_error", "Linear OAuth client credentials response was missing access_token");
  }
  if (tokenType === null || tokenType.toLowerCase() !== "bearer") {
    throw new SymphonyError("tracker_error", "Linear OAuth client credentials response was missing Bearer token_type");
  }
  return `Bearer ${accessToken}`;
}

export async function upsertDotEnvValue(envPath: string, key: string, value: string): Promise<void> {
  let contents = "";
  try {
    contents = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new SymphonyError("config_validation_error", `Unable to read env file: ${envPath}`, error);
    }
  }
  await fs.writeFile(envPath, upsertDotEnvValueText(contents, key, value), "utf8");
}

export function upsertDotEnvValueText(contents: string, key: string, value: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = contents.length === 0 || /\r?\n$/u.test(contents);
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "" && hadFinalNewline) lines.pop();

  const assignment = `${key}=${quoteDotEnvValue(value)}`;
  const pattern = new RegExp(`^(\\s*)(export\\s+)?${escapeRegExp(key)}\\s*=`);
  let replaced = false;
  const nextLines = lines.map((line) => {
    const match = pattern.exec(line);
    if (!match) return line;
    replaced = true;
    return `${match[1] ?? ""}${match[2] ?? ""}${assignment}`;
  });
  if (!replaced) nextLines.push(assignment);
  return `${nextLines.join(newline)}${newline}`;
}

function resolveLinearStartupTokenBinding(
  raw: RawWorkflowConfig,
  env: NodeJS.ProcessEnv,
): LinearStartupTokenBinding {
  const rawApiKey = raw.tracker?.api_key;
  const envVar = envReference(rawApiKey) ?? (rawApiKey === undefined ? "LINEAR_API_KEY" : null);
  const authorizationHeader =
    rawApiKey === undefined
      ? resolveConfigString("$LINEAR_API_KEY", env) ?? ""
      : resolveConfigString(rawApiKey, env) ?? "";
  const endpoint = normalizeOptionalString(resolveConfigString(raw.tracker?.endpoint, env)) ?? DEFAULT_LINEAR_GRAPHQL_ENDPOINT;
  return { authorizationHeader, endpoint, envVar };
}

function linearWorkflowEnvPath(workflowPath: string): string {
  return path.join(path.dirname(path.resolve(workflowPath)), ".env");
}

async function readJsonResponse<T>(response: Response, failureMessage: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new SymphonyError("tracker_error", failureMessage, error);
  }
}

function linearGraphQlErrorsLookAuthRelated(errors: unknown[]): boolean {
  const rendered = JSON.stringify(errors).toLowerCase();
  return /unauthenticated|unauthorized|forbidden|invalid token|access token|api key|authentication|authorization|permission/u.test(
    rendered,
  );
}

function quoteDotEnvValue(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

function envReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(value.trim());
  return match?.[1] ?? null;
}

function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function asNonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
