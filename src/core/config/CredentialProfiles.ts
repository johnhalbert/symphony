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

export const rawCredentialProfilesSchema = z
  .object({
    profiles: z
      .record(
        z.string(),
        z
          .object({
            value: z.string(),
            capabilities: z.array(credentialCapabilitySchema).min(1),
          })
          .passthrough(),
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

export interface CredentialProfileDefinition {
  name: string;
  envVar: string;
  capabilities: CredentialCapability[];
}

export interface ResolvedCredential {
  role: CredentialRole;
  capability: CredentialCapability;
  value: string;
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
      const value = this.#env[profile.envVar] ?? "";
      if (value.length === 0) {
        throw new SymphonyError(
          "config_validation_error",
          `Credential profile "${profile.name}" for ${role} ${capability} references unset or empty environment variable ${profile.envVar}`,
        );
      }
      return { role, capability, value, source: "profile", profileName: profile.name };
    }

    const fallbackValue = this.#legacyFallback(capability);
    if (fallbackValue === null || fallbackValue.length === 0) return null;
    return { role, capability, value: fallbackValue, source: "legacy", profileName: null };
  }

  hasAssignment(role: CredentialRole, capability: CredentialCapability): boolean {
    return this.#assignmentFor(role, capability) !== null;
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
    profiles: Record<string, { source: { kind: "env"; name: string }; capabilities: CredentialCapability[] }>;
    roles: Record<CredentialRole, Partial<Record<CredentialCapability, string>>>;
  } {
    return {
      profiles: Object.fromEntries(
        Array.from(this.#profiles.entries()).map(([name, profile]) => [
          name,
          { source: { kind: "env", name: profile.envVar }, capabilities: profile.capabilities },
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
  fallbacks: CredentialLegacyFallbacks;
}): CredentialProfileRegistry {
  const profiles = parseProfiles(input.raw?.profiles);
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
): Map<string, CredentialProfileDefinition> {
  const profiles = new Map<string, CredentialProfileDefinition>();
  for (const [name, rawProfile] of Object.entries(rawProfiles ?? {})) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new SymphonyError("config_validation_error", "Credential profile names must not be empty");
    }
    const envVar = parseEnvReference(rawProfile.value, `credential_profiles.profiles.${trimmedName}.value`);
    profiles.set(trimmedName, {
      name: trimmedName,
      envVar,
      capabilities: [...new Set(rawProfile.capabilities)],
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
