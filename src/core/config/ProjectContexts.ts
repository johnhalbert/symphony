export type ProjectContextId = string;

export const LEGACY_DEFAULT_PROJECT_CONTEXT_ID = "default";
export const LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL = "Default";
export const LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE = "legacy_default";

export type ProjectContextSource = "explicit" | "legacy_default";

export interface ProjectContextResolution {
  projectContextId: ProjectContextId;
  projectContextLabel: string;
  linearProjectSlug: string | null;
  routingSource: string;
}

export interface ProjectContextIssueLike {
  projectContext?: Partial<ProjectContextResolution> | null;
  projectContextId?: string | null;
  projectContextLabel?: string | null;
  linearProjectSlug?: string | null;
  routingSource?: string | null;
  linearProjectIdentity?: {
    slug?: string | null;
  } | null;
}

export interface ProjectContextPublicMetadata {
  id: ProjectContextId;
  label: string;
  enabled: boolean;
  linearProjectSlug: string | null;
  workspaceRoot: string | null;
  workspaceSourceKind: string | null;
  repository: string | null;
  path: string | null;
}

export interface ProjectContextPublicWorkspaceSourceSummary {
  kind: string | null;
  pathConfigured: boolean;
  repositoryConfigured: boolean;
  refConfigured: boolean;
  baseRefConfigured: boolean;
  branchTemplateConfigured: boolean;
  cachePathConfigured: boolean;
  cleanup: string | null;
}

export interface ProjectContextPublicSummary {
  id: ProjectContextId;
  label: string;
  enabled: boolean;
  publicMetadata: ProjectContextPublicMetadata;
  tracker: {
    projectSlug: string | null;
    apiKeyPresent: boolean;
  };
  workspace: {
    source: ProjectContextPublicWorkspaceSourceSummary;
  };
  github: {
    tokenPresent: boolean;
  };
}

export interface ProjectContextConfig<
  TTracker = unknown,
  TWorkspace = unknown,
  TGitHub = unknown,
  TReviewLoop = unknown,
  TIssueBreakdown = unknown,
  TAgent = unknown,
  TCredentialProfiles = unknown,
> {
  id: string;
  label?: string;
  enabled?: boolean;
  tracker?: TTracker;
  workspace?: TWorkspace;
  github?: TGitHub;
  review_loop?: TReviewLoop;
  issue_breakdown?: TIssueBreakdown;
  agent?: TAgent;
  credential_profiles?: TCredentialProfiles;
}

export interface NormalizedProjectContext<
  TTracker = unknown,
  TWorkspace = unknown,
  TGitHub = unknown,
  TReviewLoop = unknown,
  TIssueBreakdown = unknown,
  TAgent = unknown,
  TCredentialProfiles = unknown,
> {
  id: ProjectContextId;
  label: string;
  enabled: boolean;
  source: ProjectContextSource;
  tracker: TTracker;
  workspace: TWorkspace;
  github: TGitHub;
  reviewLoop: TReviewLoop;
  issueBreakdown: TIssueBreakdown;
  agent: TAgent;
  credentialProfiles?: TCredentialProfiles;
  publicMetadata: ProjectContextPublicMetadata;
  publicSummary: ProjectContextPublicSummary;
}

export interface ProjectContextRegistry<TContext extends { id: ProjectContextId; enabled: boolean }> {
  contexts: TContext[];
  enabledContexts: TContext[];
  defaultContextId: ProjectContextId;
  defaultContext: TContext;
  byId: ReadonlyMap<ProjectContextId, TContext>;
}

export type ProjectContextRoutingProblemReason =
  | "missing_context"
  | "ambiguous_context"
  | "disabled_context"
  | "credential_unavailable"
  | "codebase_unavailable"
  | "stale_context";

export interface ProjectContextRoutingProblem {
  reason: ProjectContextRoutingProblemReason;
  issueId: string | null;
  issueIdentifier: string | null;
  candidateContextIds: ProjectContextId[];
  safeMessage: string;
}

export type ProjectContextRoutingResult =
  | { kind: "resolved"; projectContext: ProjectContextResolution }
  | { kind: "problem"; problem: ProjectContextRoutingProblem };

export interface ResolveProjectContextForIssueOptions {
  persistedContext?: Partial<ProjectContextResolution> | null;
}

function resolvedProjectContextRoutingResult(projectContext: ProjectContextResolution): ProjectContextRoutingResult {
  return {
    kind: "resolved",
    projectContext,
  };
}

function projectContextRoutingProblemResult(
  reason: ProjectContextRoutingProblemReason,
  issue: unknown,
  candidateContextIds: ProjectContextId[],
  safeMessage: string,
): ProjectContextRoutingResult {
  return {
    kind: "problem",
    problem: createProjectContextRoutingProblem(reason, issue, candidateContextIds, safeMessage),
  };
}

export interface LegacyProjectContextDefaults<
  TTracker = unknown,
  TWorkspace = unknown,
  TGitHub = unknown,
  TReviewLoop = unknown,
  TIssueBreakdown = unknown,
  TAgent = unknown,
  TCredentialProfiles = unknown,
> {
  tracker?: TTracker;
  workspace?: TWorkspace;
  github?: TGitHub;
  review_loop?: TReviewLoop;
  issue_breakdown?: TIssueBreakdown;
  agent?: TAgent;
  credential_profiles?: TCredentialProfiles;
}

export function normalizeProjectContextId(raw: string): ProjectContextId {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new Error("Project context id must contain at least one letter or number after normalization");
  }
  return normalized;
}

export function defaultProjectContextLabel(id: string): string {
  if (id === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) return LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL;
  return id
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeLegacyDefaultProjectContext<
  TTracker = unknown,
  TWorkspace = unknown,
  TGitHub = unknown,
  TReviewLoop = unknown,
  TIssueBreakdown = unknown,
  TAgent = unknown,
  TCredentialProfiles = unknown,
>(
  input: LegacyProjectContextDefaults<
    TTracker,
    TWorkspace,
    TGitHub,
    TReviewLoop,
    TIssueBreakdown,
    TAgent,
    TCredentialProfiles
  >,
): ProjectContextConfig<
  TTracker,
  TWorkspace,
  TGitHub,
  TReviewLoop,
  TIssueBreakdown,
  TAgent,
  TCredentialProfiles
> {
  return {
    id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
    label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
    enabled: true,
    ...(input.tracker === undefined ? {} : { tracker: input.tracker }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.github === undefined ? {} : { github: input.github }),
    ...(input.review_loop === undefined ? {} : { review_loop: input.review_loop }),
    ...(input.issue_breakdown === undefined ? {} : { issue_breakdown: input.issue_breakdown }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.credential_profiles === undefined ? {} : { credential_profiles: input.credential_profiles }),
  };
}

export function normalizeProjectContextResolution(
  value: Partial<ProjectContextResolution> | null | undefined,
): ProjectContextResolution {
  const explicitProjectContextId = readExplicitProjectContextId(value);
  const projectContextId =
    explicitProjectContextId === undefined
      ? LEGACY_DEFAULT_PROJECT_CONTEXT_ID
      : normalizeProjectContextId(explicitProjectContextId);
  return {
    projectContextId,
    projectContextLabel:
      normalizeOptionalNonEmptyString(value?.projectContextLabel) ??
      (projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
        ? LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL
        : defaultProjectContextLabel(projectContextId)),
    linearProjectSlug: normalizeOptionalNonEmptyString(value?.linearProjectSlug),
    routingSource:
      normalizeOptionalNonEmptyString(value?.routingSource) ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
  };
}

export function sameProjectContextIdentity(
  left: Partial<ProjectContextResolution> | null | undefined,
  right: Partial<ProjectContextResolution> | null | undefined,
): boolean {
  const normalizedLeft = normalizeProjectContextResolution(left);
  const normalizedRight = normalizeProjectContextResolution(right);
  if (normalizedLeft.projectContextId !== normalizedRight.projectContextId) return false;
  if (normalizedLeft.projectContextId !== LEGACY_DEFAULT_PROJECT_CONTEXT_ID) return true;
  if (readExplicitProjectContextId(left) !== undefined || readExplicitProjectContextId(right) !== undefined) return true;
  if (sameProjectSlug(normalizedLeft.linearProjectSlug, normalizedRight.linearProjectSlug)) return true;
  return normalizedLeft.linearProjectSlug === null && normalizedRight.linearProjectSlug === null;
}

export function projectContextResolutionFromIssue(issue: unknown): ProjectContextResolution | null {
  if (typeof issue !== "object" || issue === null) return null;

  const value = issue as ProjectContextIssueLike;
  if (value.projectContext) {
    return normalizeProjectContextResolution(value.projectContext);
  }

  const explicitProjectContextId = readExplicitProjectContextId(value);
  const projectContextLabel = normalizeOptionalNonEmptyString(value.projectContextLabel);
  const linearProjectSlug =
    normalizeOptionalNonEmptyString(value.linearProjectSlug) ??
    normalizeOptionalNonEmptyString(value.linearProjectIdentity?.slug);
  const routingSource = normalizeOptionalNonEmptyString(value.routingSource);

  if (
    explicitProjectContextId === undefined &&
    projectContextLabel === null &&
    linearProjectSlug === null &&
    routingSource === null
  ) {
    return null;
  }

  return normalizeProjectContextResolution({
    ...(explicitProjectContextId === undefined ? {} : { projectContextId: explicitProjectContextId }),
    ...(projectContextLabel === null ? {} : { projectContextLabel }),
    ...(linearProjectSlug === null ? {} : { linearProjectSlug }),
    ...(routingSource === null ? {} : { routingSource }),
  });
}

export function projectContextMetadataForPublicRead(input: {
  id: ProjectContextId;
  label: string;
  enabled: boolean;
  tracker?: { projectSlug?: string | null } | null;
  workspace?: {
    root?: string | null;
    source?: {
      kind?: string | null;
      repository?: string | null;
      path?: string | null;
    } | null;
  } | null;
}): ProjectContextPublicMetadata {
  return {
    id: input.id,
    label: input.label,
    enabled: input.enabled,
    linearProjectSlug: normalizeOptionalNonEmptyString(input.tracker?.projectSlug),
    workspaceRoot: normalizeOptionalNonEmptyString(input.workspace?.root),
    workspaceSourceKind: normalizeOptionalNonEmptyString(input.workspace?.source?.kind),
    repository: publicRepositorySummary(input.workspace?.source?.repository),
    path: normalizeOptionalNonEmptyString(input.workspace?.source?.path),
  };
}

export function projectContextSummaryForPublicRead(input: {
  id: ProjectContextId;
  label: string;
  enabled: boolean;
  tracker?: { projectSlug?: string | null; apiKey?: string | null } | null;
  workspace?: {
    root?: string | null;
    source?: {
      kind?: string | null;
      repository?: string | null;
      path?: string | null;
      ref?: string | null;
      baseRef?: string | null;
      branchTemplate?: string | null;
      cachePath?: string | null;
      cleanup?: string | null;
    } | null;
  } | null;
  github?: { token?: string | null } | null;
}): ProjectContextPublicSummary {
  const publicMetadata = projectContextMetadataForPublicRead({
    id: input.id,
    label: input.label,
    enabled: input.enabled,
    tracker: { projectSlug: input.tracker?.projectSlug ?? null },
    workspace: {
      root: input.workspace?.root ?? null,
      source: {
        kind: input.workspace?.source?.kind ?? null,
        repository: input.workspace?.source?.repository ?? null,
        path: input.workspace?.source?.path ?? null,
      },
    },
  });

  return {
    id: input.id,
    label: input.label,
    enabled: input.enabled,
    publicMetadata,
    tracker: {
      projectSlug: publicMetadata.linearProjectSlug,
      apiKeyPresent: normalizeOptionalNonEmptyString(input.tracker?.apiKey) !== null,
    },
    workspace: {
      source: {
        kind: publicMetadata.workspaceSourceKind,
        pathConfigured: normalizeOptionalNonEmptyString(input.workspace?.source?.path) !== null,
        repositoryConfigured: normalizeOptionalNonEmptyString(input.workspace?.source?.repository) !== null,
        refConfigured: normalizeOptionalNonEmptyString(input.workspace?.source?.ref) !== null,
        baseRefConfigured: normalizeOptionalNonEmptyString(input.workspace?.source?.baseRef) !== null,
        branchTemplateConfigured: normalizeOptionalNonEmptyString(input.workspace?.source?.branchTemplate) !== null,
        cachePathConfigured: normalizeOptionalNonEmptyString(input.workspace?.source?.cachePath) !== null,
        cleanup: normalizeOptionalNonEmptyString(input.workspace?.source?.cleanup),
      },
    },
    github: {
      tokenPresent: normalizeOptionalNonEmptyString(input.github?.token) !== null,
    },
  };
}

export function buildProjectContextRegistry<TContext extends { id: ProjectContextId; enabled: boolean }>(
  contexts: readonly TContext[],
): ProjectContextRegistry<TContext> {
  if (contexts.length === 0) {
    throw new Error("At least one project context is required");
  }

  const byId = new Map<ProjectContextId, TContext>();
  for (const context of contexts) {
    if (byId.has(context.id)) {
      throw new Error(`Duplicate project context id: ${context.id}`);
    }
    byId.set(context.id, context);
  }

  const enabledContexts = contexts.filter((context) => context.enabled);
  const defaultContext =
    enabledContexts.find((context) => context.id === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) ??
    enabledContexts[0] ??
    null;
  if (defaultContext === null) {
    throw new Error("At least one enabled project context is required");
  }

  return {
    contexts: [...contexts],
    enabledContexts,
    defaultContextId: defaultContext.id,
    defaultContext,
    byId,
  };
}

export function resolveProjectContextForIssue<
  TContext extends {
    id: ProjectContextId;
    label: string;
    enabled: boolean;
    tracker?: { projectSlug?: string | null } | null;
  },
>(
  issue: unknown,
  registry: ProjectContextRegistry<TContext>,
  options: ResolveProjectContextForIssueOptions = {},
): ProjectContextRoutingResult {
  if (options.persistedContext !== null && options.persistedContext !== undefined) {
    return validatePersistedContextForResolution(issue, options.persistedContext);
  }

  const issueRouting = readIssueRoutingFields(issue);
  if (issueRouting === null) {
    if (registry.enabledContexts.length === 1) {
      return resolvedProjectContextRoutingResult(projectContextResolutionFromConfiguredContext(registry.defaultContext, null));
    }

    return projectContextRoutingProblemResult(
      "ambiguous_context",
      issue,
      registry.enabledContexts.map((context) => context.id),
      `Issue ${describeIssueForRouting(issue)} does not identify a single enabled project context`,
    );
  }

  const routingSource = issueRouting.routingSource ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE;
  const replayLikeSource = isReplayLikeRoutingSource(routingSource);
  if (issueRouting.projectContextId !== undefined) {
    const normalizedProjectContextId = normalizeProjectContextId(issueRouting.projectContextId);
    const configuredContext = registry.byId.get(normalizedProjectContextId);
    if (configuredContext?.enabled) {
      if (explicitRoutingMismatchesConfiguredSlug(configuredContext, issueRouting.linearProjectSlug)) {
        return {
          kind: "problem",
          problem: createProjectContextRoutingProblem(
            "stale_context",
            issue,
            [configuredContext.id],
            `Issue ${describeIssueForRouting(issue)} declared project context ${configuredContext.id} with a mismatched Linear project slug`,
          ),
        };
      }

      return {
        kind: "resolved",
        projectContext: projectContextResolutionFromConfiguredContext(configuredContext, issueRouting),
      };
    }
    if (configuredContext) {
      if (replayLikeSource) {
        return {
          kind: "problem",
          problem: createProjectContextRoutingProblem(
            "disabled_context",
            issue,
            [configuredContext.id],
            `Resolved project context "${configuredContext.id}" is disabled`,
          ),
        };
      }

      return {
        kind: "problem",
        problem: createProjectContextRoutingProblem(
          "disabled_context",
          issue,
          [configuredContext.id],
          `Issue ${describeIssueForRouting(issue)} matched disabled project context ${configuredContext.id}`,
        ),
      };
    }

    if (replayLikeSource) {
      return {
        kind: "problem",
        problem: createProjectContextRoutingProblem(
          "missing_context",
          issue,
          [normalizedProjectContextId],
          `Resolved project context "${normalizedProjectContextId}" is not configured`,
        ),
      };
    }

    return {
      kind: "problem",
      problem: createProjectContextRoutingProblem(
        "missing_context",
        issue,
        [],
        `Issue ${describeIssueForRouting(issue)} did not match any configured project context`,
      ),
    };
  }

  const matchingEnabledContexts = registry.enabledContexts.filter((context) =>
    sameProjectSlug(context.tracker?.projectSlug, issueRouting.linearProjectSlug),
  );
  if (matchingEnabledContexts.length === 1) {
    const matchedContext = matchingEnabledContexts[0]!;
    return {
      kind: "resolved",
      projectContext: projectContextResolutionFromConfiguredContext(matchedContext, issueRouting),
    };
  }
  if (matchingEnabledContexts.length > 1) {
    return {
      kind: "problem",
      problem: createProjectContextRoutingProblem(
        "ambiguous_context",
        issue,
        matchingEnabledContexts.map((context) => context.id),
        `Issue ${describeIssueForRouting(issue)} matched multiple enabled project contexts: ${matchingEnabledContexts
          .map((context) => context.id)
          .join(", ")}`,
      ),
    };
  }

  const matchingDisabledContexts = registry.contexts.filter(
    (context) => !context.enabled && sameProjectSlug(context.tracker?.projectSlug, issueRouting.linearProjectSlug),
  );
  if (matchingDisabledContexts.length > 0) {
    return {
      kind: "problem",
      problem: createProjectContextRoutingProblem(
        "disabled_context",
        issue,
        matchingDisabledContexts.map((context) => context.id),
        `Issue ${describeIssueForRouting(issue)} matched only disabled project contexts: ${matchingDisabledContexts
          .map((context) => context.id)
          .join(", ")}`,
      ),
    };
  }

  return {
    kind: "problem",
    problem: createProjectContextRoutingProblem(
      "missing_context",
      issue,
      [],
      `Issue ${describeIssueForRouting(issue)} did not match any enabled project context`,
    ),
  };
}

function readExplicitProjectContextId(
  value: { projectContextId?: string | null } | null | undefined,
): string | undefined {
  if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, "projectContextId")) {
    return undefined;
  }
  return typeof value.projectContextId === "string" ? value.projectContextId : undefined;
}

function normalizeOptionalNonEmptyString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

export function publicRepositorySummary(
  value: string | null | undefined,
  options: { allowLocalPath?: boolean } = {},
): string | null {
  const normalized = normalizeOptionalNonEmptyString(value);
  if (normalized === null) return null;

  if (looksLikeUrlRepositoryValue(normalized)) {
    return sanitizedUrlRepositorySummary(normalized);
  }

  const sanitizedScp = sanitizedScpLikeRepositorySummary(normalized);
  if (sanitizedScp !== null) return sanitizedScp;

  const sanitizedAtSign = sanitizedAtSignRepositorySummary(normalized);
  if (sanitizedAtSign !== null) return sanitizedAtSign;

  const strippedSuffix = stripRepositoryQueryAndFragment(normalized);
  if (strippedSuffix !== normalized) return publicRepositorySummary(strippedSuffix, options);

  if (looksLikeLocalRepositoryPath(normalized)) return options.allowLocalPath === false ? null : normalized;
  return sanitizedHostIdentifierRepositorySummary(normalized);
}

function looksLikeUrlRepositoryValue(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value);
}

function sanitizedUrlRepositorySummary(value: string): string | null {
  if (!looksLikeUrlRepositoryValue(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const pathname = parsed.pathname.length === 0 ? "/" : parsed.pathname;
  if (parsed.host.length === 0) return `${parsed.protocol}//${pathname}`;
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function sanitizedScpLikeRepositorySummary(value: string): string | null {
  const match = /^([^@\s/:]+)@([^:\s/]+):(.+)$/u.exec(value);
  if (!match) return null;

  const host = normalizeOptionalNonEmptyString(match[2]);
  const repositoryPath = normalizeOptionalNonEmptyString(stripRepositoryQueryAndFragment(match[3] ?? ""));
  if (host === null) return null;
  if (repositoryPath === null) return host;
  return `${host}:${repositoryPath}`;
}

function sanitizedAtSignRepositorySummary(value: string): string | null {
  const slashMatch = /^([^@\s/]+)@([^/\s?#]+)\/(.+)$/u.exec(value);
  if (slashMatch) {
    const host = normalizeOptionalNonEmptyString(slashMatch[2]);
    const repositoryPath = normalizeOptionalNonEmptyString(stripRepositoryQueryAndFragment(slashMatch[3] ?? ""));
    if (host === null) return null;
    if (repositoryPath === null) return host;
    return `${host}/${repositoryPath}`;
  }

  const hostOnlyMatch = /^([^@\s]+)@([^/\s?#:]+(?:\.[^/\s?#:]+)*)$/u.exec(value);
  if (!hostOnlyMatch) return null;
  return normalizeOptionalNonEmptyString(hostOnlyMatch[2]);
}

function stripRepositoryQueryAndFragment(value: string): string {
  return value.replace(/[?#].*$/u, "");
}

function looksLikeLocalRepositoryPath(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /[\\/]/u.test(value)
  );
}

function sanitizedHostIdentifierRepositorySummary(value: string): string | null {
  if (/[\s@/]/u.test(value)) return null;

  const match = /^(?<host>\[[0-9A-Fa-f:.]+\]|localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+)(?::(?<port>\d+))?$/u.exec(
    value,
  );
  const host = normalizeOptionalNonEmptyString(match?.groups?.host);
  const port = normalizeOptionalNonEmptyString(match?.groups?.port);
  if (host === null || !isSafePublicRepositoryHost(host)) return null;
  return port === null ? host : `${host}:${port}`;
}

function isSafePublicRepositoryHost(host: string): boolean {
  if (host === "localhost") return true;
  if (/^\[[0-9A-Fa-f:.]+\]$/u.test(host)) return true;
  if (isValidIpv4Host(host)) return true;

  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => /^[A-Za-z0-9-]+$/u.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}

function isValidIpv4Host(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) >= 0 && Number(octet) <= 255);
}

function readIssueRoutingFields(issue: unknown): {
  projectContextId?: string;
  projectContextLabel: string | null;
  linearProjectSlug: string | null;
  routingSource: string | null;
} | null {
  if (typeof issue !== "object" || issue === null) return null;

  const value = issue as ProjectContextIssueLike;
  if (value.projectContext && typeof value.projectContext === "object") {
    const explicitProjectContextId = readExplicitProjectContextId(value.projectContext);
    const projectContextLabel = normalizeOptionalNonEmptyString(value.projectContext.projectContextLabel);
    const linearProjectSlug = normalizeOptionalNonEmptyString(value.projectContext.linearProjectSlug);
    const routingSource = normalizeOptionalNonEmptyString(value.projectContext.routingSource);
    if (
      explicitProjectContextId === undefined &&
      projectContextLabel === null &&
      linearProjectSlug === null &&
      routingSource === null
    ) {
      return null;
    }

    return {
      ...(explicitProjectContextId === undefined ? {} : { projectContextId: explicitProjectContextId }),
      projectContextLabel,
      linearProjectSlug,
      routingSource,
    };
  }

  const explicitProjectContextId = readExplicitProjectContextId(value);
  const projectContextLabel = normalizeOptionalNonEmptyString(value.projectContextLabel);
  const linearProjectSlug =
    normalizeOptionalNonEmptyString(value.linearProjectSlug) ??
    normalizeOptionalNonEmptyString(value.linearProjectIdentity?.slug);
  const routingSource = normalizeOptionalNonEmptyString(value.routingSource);
  if (
    explicitProjectContextId === undefined &&
    projectContextLabel === null &&
    linearProjectSlug === null &&
    routingSource === null
  ) {
    return null;
  }

  return {
    ...(explicitProjectContextId === undefined ? {} : { projectContextId: explicitProjectContextId }),
    projectContextLabel,
    linearProjectSlug,
    routingSource,
  };
}

function validatePersistedContextForResolution(
  issue: unknown,
  persistedContext: Partial<ProjectContextResolution>,
): ProjectContextRoutingResult {
  if (readExplicitProjectContextId(persistedContext) === undefined) {
    return projectContextRoutingProblemResult(
      "stale_context",
      issue,
      [],
      `Issue ${describeIssueForRouting(issue)} has persisted project context metadata without an explicit project context id`,
    );
  }

  return resolvedProjectContextRoutingResult(normalizeProjectContextResolution(persistedContext));
}

function explicitRoutingMismatchesConfiguredSlug<
  TContext extends {
    id: ProjectContextId;
    tracker?: { projectSlug?: string | null } | null;
  },
>(context: TContext, routedProjectSlug: string | null): boolean {
  const configuredProjectSlug = normalizeOptionalNonEmptyString(context.tracker?.projectSlug);
  if (configuredProjectSlug === null || routedProjectSlug === null) {
    return false;
  }
  return !sameProjectSlug(configuredProjectSlug, routedProjectSlug);
}

function projectContextResolutionFromConfiguredContext<
  TContext extends {
    id: ProjectContextId;
    label: string;
    tracker?: { projectSlug?: string | null } | null;
  },
>(
  context: TContext,
  issueRouting: {
    projectContextLabel: string | null;
    linearProjectSlug: string | null;
    routingSource: string | null;
  } | null,
): ProjectContextResolution {
  return normalizeProjectContextResolution({
    projectContextId: context.id,
    projectContextLabel: issueRouting?.projectContextLabel ?? context.label,
    linearProjectSlug: issueRouting?.linearProjectSlug ?? normalizeOptionalNonEmptyString(context.tracker?.projectSlug),
    routingSource: issueRouting?.routingSource ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
  });
}

function projectContextResolutionFromIssueRouting(issueRouting: {
  projectContextId?: string;
  projectContextLabel: string | null;
  linearProjectSlug: string | null;
  routingSource: string | null;
}): ProjectContextResolution {
  return normalizeProjectContextResolution({
    ...(issueRouting.projectContextId === undefined ? {} : { projectContextId: issueRouting.projectContextId }),
    ...(issueRouting.projectContextLabel === null ? {} : { projectContextLabel: issueRouting.projectContextLabel }),
    ...(issueRouting.linearProjectSlug === null ? {} : { linearProjectSlug: issueRouting.linearProjectSlug }),
    ...(issueRouting.routingSource === null ? {} : { routingSource: issueRouting.routingSource }),
  });
}

function sameProjectSlug(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeProjectSlug(left);
  const normalizedRight = normalizeProjectSlug(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function normalizeProjectSlug(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalNonEmptyString(value);
  return normalized === null ? null : normalized.toUpperCase();
}

function isReplayLikeRoutingSource(routingSource: string): boolean {
  return routingSource === "replay" || routingSource === "state_refresh";
}

function createProjectContextRoutingProblem(
  reason: ProjectContextRoutingProblemReason,
  issue: unknown,
  candidateContextIds: ProjectContextId[],
  safeMessage: string,
): ProjectContextRoutingProblem {
  return {
    reason,
    issueId: readIssueIdentityField(issue, "id"),
    issueIdentifier: readIssueIdentityField(issue, "identifier"),
    candidateContextIds: [...candidateContextIds],
    safeMessage,
  };
}

function describeIssueForRouting(issue: unknown): string {
  return readIssueIdentityField(issue, "identifier") ?? readIssueIdentityField(issue, "id") ?? "unknown issue";
}

function readIssueIdentityField(issue: unknown, key: "id" | "identifier"): string | null {
  if (typeof issue !== "object" || issue === null || !Object.prototype.hasOwnProperty.call(issue, key)) {
    return null;
  }

  const value = issue as { id?: unknown; identifier?: unknown };
  return normalizeOptionalNonEmptyString(key === "id" ? asNullableString(value.id) : asNullableString(value.identifier));
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
