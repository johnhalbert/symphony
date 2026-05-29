import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SymphonyError } from "../errors.js";
import type { AgentRunRole } from "../types.js";

export const CREDENTIAL_CAPABILITIES = [
  "github.discovery",
  "github.publication",
  "github.review_evidence_read",
  "github.review_feedback_write",
  "github.merge",
  "linear.tracker",
  "linear.writeback",
  "runtime.cursor",
  "runtime.hermes",
  "cursor.runtime",
  "server.open_workspace",
] as const;

const credentialCapabilitySchema = z.enum(CREDENTIAL_CAPABILITIES);

export type CredentialCapability = z.infer<typeof credentialCapabilitySchema>;
export type CredentialRole = AgentRunRole | "service";

const rawCredentialProfileBaseSchema = z
  .object({
    capabilities: z.array(credentialCapabilitySchema).min(1),
  })
  .passthrough();

const rawStaticCredentialProfileSchema = rawCredentialProfileBaseSchema.extend({
  kind: z.literal("static_token").optional(),
  value: z.string(),
});

const rawGitHubAppCredentialProfileSchema = rawCredentialProfileBaseSchema.extend({
  kind: z.literal("github_app"),
  app_id: z.string().optional(),
  client_id: z.string().optional(),
  installation_id: z.string().optional(),
  private_key: z.string().optional(),
  private_key_path: z.string().optional(),
  token_refresh_buffer_seconds: z.number().int().nonnegative().optional(),
});

export const rawCredentialProfilesSchema = z
  .object({
    profiles: z
      .record(
        z.string(),
        z.union([rawGitHubAppCredentialProfileSchema, rawStaticCredentialProfileSchema]),
      )
      .optional(),
    roles: z
      .object({
        worker: z.record(z.string(), z.string()).optional(),
        reviewer: z.record(z.string(), z.string()).optional(),
        service: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type RawCredentialProfilesConfig = z.infer<typeof rawCredentialProfilesSchema>;

export interface CredentialLegacyFallbacks {
  githubToken: string | null;
  linearApiKey: string | null;
  cursorRuntimeApiKey: string | null;
  openWorkspaceToken: string | null;
}

export interface CredentialProfileGitHubAppConfig {
  appId: string | null;
  clientId: string | null;
  installationId: string | null;
  privateKey: string | null;
  privateKeyEnvVar: string | null;
  privateKeyPath: string | null;
  tokenRefreshBufferSeconds: number;
}

export interface StaticTokenCredentialProfileDefinition {
  kind: "static_token";
  name: string;
  envVar: string;
  capabilities: CredentialCapability[];
}

export interface GitHubAppCredentialProfileDefinition {
  kind: "github_app";
  name: string;
  app: CredentialProfileGitHubAppConfig;
  capabilities: CredentialCapability[];
}

export type CredentialProfileDefinition =
  | StaticTokenCredentialProfileDefinition
  | GitHubAppCredentialProfileDefinition;

export interface ResolvedCredential {
  kind: "static_token" | "github_app";
  role: CredentialRole;
  capability: CredentialCapability;
  value: string;
  app: CredentialProfileGitHubAppConfig | null;
  source: "profile" | "legacy";
  profileName: string | null;
}

export const DEFAULT_ROLE_CREDENTIAL_CAPABILITIES: Readonly<Record<CredentialRole, readonly CredentialCapability[]>> = {
  worker: [
    "github.discovery",
    "linear.tracker",
    "linear.writeback",
    "runtime.cursor",
    "server.open_workspace",
  ],
  reviewer: [
    "github.review_evidence_read",
    "github.review_feedback_write",
    "linear.tracker",
    "linear.writeback",
    "runtime.cursor",
  ],
  service: ["github.publication", "github.merge", "linear.writeback"],
};

const ROLE_NAMES: readonly CredentialRole[] = ["worker", "reviewer", "service"];
const VALID_CAPABILITIES = new Set<CredentialCapability>(CREDENTIAL_CAPABILITIES);
const ENV_REFERENCE_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const DEFAULT_GITHUB_APP_TOKEN_REFRESH_BUFFER_SECONDS = 300;

export class CredentialProfileRegistry {
  readonly #profiles: Map<string, CredentialProfileDefinition>;
  readonly #roleAssignments: Map<CredentialRole, Map<CredentialCapability, string>>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fallbacks: CredentialLegacyFallbacks;

  constructor(input: {
    profiles: Map<string, CredentialProfileDefinition>;
    roleAssignments: Map<CredentialRole, Map<CredentialCapability, string>>;
    env: NodeJS.ProcessEnv;
    fallbacks: CredentialLegacyFallbacks;
  }) {
    this.#profiles = input.profiles;
    this.#roleAssignments = input.roleAssignments;
    this.#env = input.env;
    this.#fallbacks = input.fallbacks;
  }

  resolveForRole(role: CredentialRole, capability: CredentialCapability): ResolvedCredential | null {
    const assignment = this.#assignmentFor(role, capability);
    if (assignment !== null) {
      const { profileName } = assignment;
      const profile = this.#profiles.get(profileName);
      if (profile === undefined) {
        throw new SymphonyError("config_validation_error", `Credential profile "${profileName}" is not defined`);
      }
      if (profile.kind === "github_app") {
        return {
          kind: "github_app",
          role,
          capability,
          value: "",
          app: profile.app,
          source: "profile",
          profileName: profile.name,
        };
      }
      const value = this.#env[profile.envVar] ?? "";
      if (value.length === 0) {
        throw new SymphonyError(
          "config_validation_error",
          `Credential profile "${profile.name}" for ${role} ${capability} references unset or empty environment variable ${profile.envVar}`,
        );
      }
      return { kind: "static_token", role, capability, value, app: null, source: "profile", profileName: profile.name };
    }

    const fallbackValue = this.#legacyFallback(capability);
    if (fallbackValue === null || fallbackValue.length === 0) return null;
    return { kind: "static_token", role, capability, value: fallbackValue, app: null, source: "legacy", profileName: null };
  }

  hasAssignment(role: CredentialRole, capability: CredentialCapability): boolean {
    return this.#assignmentFor(role, capability) !== null;
  }

  profileForRole(role: CredentialRole, capability: CredentialCapability): CredentialProfileDefinition | null {
    const assignment = this.#assignmentFor(role, capability);
    if (assignment === null) return null;
    return this.#profiles.get(assignment.profileName) ?? null;
  }

  assignmentRolesFor(capability: CredentialCapability): CredentialRole[] {
    return ROLE_NAMES.filter((role) => this.hasAssignment(role, capability));
  }

  capabilitiesForRole(role: CredentialRole): CredentialCapability[] {
    const defaults = DEFAULT_ROLE_CREDENTIAL_CAPABILITIES[role] ?? [];
    return [
      ...new Set<CredentialCapability>([
        ...defaults,
        ...Array.from(this.#roleAssignments.get(role)?.keys() ?? []).map(canonicalCredentialCapability),
      ]),
    ];
  }

  toJSON(): {
    profiles: Record<string, SerializedCredentialProfile>;
    roles: Record<CredentialRole, Partial<Record<CredentialCapability, string>>>;
  } {
    return {
      profiles: Object.fromEntries(
        Array.from(this.#profiles.entries()).map(([name, profile]) => [
          name,
          serializeCredentialProfile(profile),
        ]),
      ),
      roles: {
        worker: Object.fromEntries(this.#roleAssignments.get("worker") ?? []),
        reviewer: Object.fromEntries(this.#roleAssignments.get("reviewer") ?? []),
        service: Object.fromEntries(this.#roleAssignments.get("service") ?? []),
      },
    };
  }

  #legacyFallback(capability: CredentialCapability): string | null {
    if (capability.startsWith("github.")) return this.#fallbacks.githubToken;
    if (capability.startsWith("linear.")) return this.#fallbacks.linearApiKey;
    if (capability === "runtime.cursor" || capability === "cursor.runtime") return this.#fallbacks.cursorRuntimeApiKey;
    if (capability === "server.open_workspace") return this.#fallbacks.openWorkspaceToken;
    return null;
  }

  #assignmentFor(
    role: CredentialRole,
    capability: CredentialCapability,
  ): { capability: CredentialCapability; profileName: string } | null {
    const roleAssignments = this.#roleAssignments.get(role);
    if (!roleAssignments) return null;
    const profileName = roleAssignments.get(capability);
    if (profileName !== undefined) return { capability, profileName };
    const alias = credentialCapabilityAlias(capability);
    if (alias === null) return null;
    const aliasProfileName = roleAssignments.get(alias);
    return aliasProfileName === undefined ? null : { capability: alias, profileName: aliasProfileName };
  }
}

export function createCredentialProfileRegistry(input: {
  raw: RawCredentialProfilesConfig | undefined;
  env: NodeJS.ProcessEnv;
  workflowDir: string;
  fallbacks: CredentialLegacyFallbacks;
}): CredentialProfileRegistry {
  const profiles = parseProfiles(input.raw?.profiles, input.workflowDir, input.env);
  const roleAssignments = parseRoleAssignments(input.raw?.roles, profiles);
  return new CredentialProfileRegistry({
    profiles,
    roleAssignments,
    env: input.env,
    fallbacks: input.fallbacks,
  });
}

function parseProfiles(
  rawProfiles: RawCredentialProfilesConfig["profiles"] | undefined,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
): Map<string, CredentialProfileDefinition> {
  const profiles = new Map<string, CredentialProfileDefinition>();
  for (const [name, rawProfile] of Object.entries(rawProfiles ?? {})) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new SymphonyError("config_validation_error", "Credential profile names must not be empty");
    }
    const capabilities = [...new Set(rawProfile.capabilities)];
    if (rawProfile.kind === "github_app") {
      const nonGitHubCapabilities = capabilities.filter((capability) => !capability.startsWith("github."));
      if (nonGitHubCapabilities.length > 0) {
        throw new SymphonyError(
          "config_validation_error",
          `credential_profiles.profiles.${trimmedName} kind github_app only supports github.* capabilities: ${nonGitHubCapabilities.join(", ")}`,
        );
      }
      profiles.set(trimmedName, {
        kind: "github_app",
        name: trimmedName,
        app: normalizeGitHubAppProfileConfig(rawProfile, workflowDir, env),
        capabilities,
      });
      continue;
    }

    const envVar = parseEnvReference(rawProfile.value, `credential_profiles.profiles.${trimmedName}.value`);
    profiles.set(trimmedName, {
      kind: "static_token",
      name: trimmedName,
      envVar,
      capabilities,
    });
  }
  return profiles;
}

function parseRoleAssignments(
  rawRoles: RawCredentialProfilesConfig["roles"] | undefined,
  profiles: Map<string, CredentialProfileDefinition>,
): Map<CredentialRole, Map<CredentialCapability, string>> {
  const result = new Map<CredentialRole, Map<CredentialCapability, string>>();
  for (const role of ROLE_NAMES) {
    const assignments = new Map<CredentialCapability, string>();
    for (const [capabilityName, profileName] of Object.entries(rawRoles?.[role] ?? {})) {
      const capability = parseCapabilityName(capabilityName, `credential_profiles.roles.${role}`);
      const profile = profiles.get(profileName);
      if (profile === undefined) {
        throw new SymphonyError(
          "config_validation_error",
          `credential_profiles.roles.${role}.${capability} references unknown profile "${profileName}"`,
        );
      }
      if (!profileSupportsCapability(profile, capability)) {
        throw new SymphonyError(
          "config_validation_error",
          `credential_profiles.roles.${role}.${capability} references profile "${profileName}" without that capability`,
        );
      }
      assignments.set(capability, profileName);
    }
    result.set(role, assignments);
  }
  return result;
}

function parseCapabilityName(value: string, path: string): CredentialCapability {
  if (VALID_CAPABILITIES.has(value as CredentialCapability)) return value as CredentialCapability;
  throw new SymphonyError("config_validation_error", `${path} contains unsupported credential capability "${value}"`);
}

function profileSupportsCapability(profile: CredentialProfileDefinition, capability: CredentialCapability): boolean {
  if (profile.capabilities.includes(capability)) return true;
  const alias = credentialCapabilityAlias(capability);
  return alias !== null && profile.capabilities.includes(alias);
}

function credentialCapabilityAlias(capability: CredentialCapability): CredentialCapability | null {
  if (capability === "runtime.cursor") return "cursor.runtime";
  if (capability === "cursor.runtime") return "runtime.cursor";
  return null;
}

function canonicalCredentialCapability(capability: CredentialCapability): CredentialCapability {
  return capability === "cursor.runtime" ? "runtime.cursor" : capability;
}

function parseEnvReference(value: string, path: string): string {
  const match = ENV_REFERENCE_PATTERN.exec(value);
  if (!match?.[1]) {
    throw new SymphonyError("config_validation_error", `${path} must reference an environment variable as $NAME`);
  }
  return match[1];
}

type RawGitHubAppCredentialProfile = z.infer<typeof rawGitHubAppCredentialProfileSchema>;

type SerializedCredentialProfile =
  | {
      kind: "static_token";
      source: { kind: "env"; name: string };
      capabilities: CredentialCapability[];
    }
  | {
      kind: "github_app";
      source: {
        kind: "github_app";
        appId: string | null;
        clientId: string | null;
        installationId: string | null;
        privateKey: { kind: "env"; name: string } | { kind: "inline"; redacted: true } | null;
        privateKeyPath: string | null;
        tokenRefreshBufferSeconds: number;
      };
      capabilities: CredentialCapability[];
    };

function serializeCredentialProfile(profile: CredentialProfileDefinition): SerializedCredentialProfile {
  if (profile.kind === "static_token") {
    return {
      kind: "static_token",
      source: { kind: "env", name: profile.envVar },
      capabilities: profile.capabilities,
    };
  }

  return {
    kind: "github_app",
    source: {
      kind: "github_app",
      appId: profile.app.appId,
      clientId: profile.app.clientId,
      installationId: profile.app.installationId,
      privateKey:
        profile.app.privateKeyEnvVar !== null
          ? { kind: "env", name: profile.app.privateKeyEnvVar }
          : profile.app.privateKey !== null
          ? { kind: "inline", redacted: true }
          : null,
      privateKeyPath: profile.app.privateKeyPath,
      tokenRefreshBufferSeconds: profile.app.tokenRefreshBufferSeconds,
    },
    capabilities: profile.capabilities,
  };
}

function normalizeGitHubAppProfileConfig(
  rawProfile: RawGitHubAppCredentialProfile,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
): CredentialProfileGitHubAppConfig {
  const appId = normalizeOptionalConfigString(resolveConfigString(rawProfile.app_id ?? "$GITHUB_APP_ID", env));
  const clientId = normalizeOptionalConfigString(resolveConfigString(rawProfile.client_id ?? "$GITHUB_APP_CLIENT_ID", env));
  const installationId = normalizeOptionalConfigString(
    resolveConfigString(rawProfile.installation_id ?? "$GITHUB_APP_INSTALLATION_ID", env),
  );
  const privateKey = normalizeGitHubAppPrivateKey(rawProfile.private_key, env);
  const privateKeyPath = normalizeGitHubAppPrivateKeyPath(rawProfile.private_key_path, workflowDir, env);

  return {
    appId,
    clientId,
    installationId,
    privateKey: privateKey.value,
    privateKeyEnvVar: privateKey.envVar,
    privateKeyPath,
    tokenRefreshBufferSeconds:
      rawProfile.token_refresh_buffer_seconds ?? DEFAULT_GITHUB_APP_TOKEN_REFRESH_BUFFER_SECONDS,
  };
}

interface NormalizedGitHubAppPrivateKey {
  value: string | null;
  envVar: string | null;
}

function normalizeGitHubAppPrivateKey(value: string | undefined, env: NodeJS.ProcessEnv): NormalizedGitHubAppPrivateKey {
  if (value !== undefined) {
    const envReference = ENV_REFERENCE_PATTERN.exec(value.trim());
    if (envReference?.[1]) {
      return { value: null, envVar: envReference[1] };
    }
    return { value: normalizeOptionalConfigString(value), envVar: null };
  }
  return normalizeOptionalConfigString(env.GITHUB_APP_PRIVATE_KEY) === null
    ? { value: null, envVar: null }
    : { value: null, envVar: "GITHUB_APP_PRIVATE_KEY" };
}

function normalizeGitHubAppPrivateKeyPath(
  value: string | undefined,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const rawPath = value ?? "$GITHUB_APP_PRIVATE_KEY_PATH";
  const resolvedPath = normalizeOptionalConfigString(resolveConfigString(rawPath, env));
  if (resolvedPath === null) return null;
  return resolvePathValue(resolvedPath, workflowDir, env);
}

function resolveConfigString(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (value === undefined) return undefined;
  const varMatch = ENV_REFERENCE_PATTERN.exec(value);
  if (varMatch) return env[varMatch[1] ?? ""] ?? "";
  return value;
}

function resolvePathValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const resolvedVariable = resolveConfigString(value, env) ?? "";
  const homeExpanded =
    resolvedVariable === "~" || resolvedVariable.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), resolvedVariable.slice(2))
      : resolvedVariable;
  return path.resolve(baseDir, homeExpanded);
}

function normalizeOptionalConfigString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}
