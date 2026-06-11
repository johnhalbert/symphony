export type ProjectContextId = string;

export const LEGACY_DEFAULT_PROJECT_CONTEXT_ID = "default";
export const LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL = "Default";
export const LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE = "legacy_default";

const REDACTED = "[redacted]";
const REPOSITORY_URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const REPOSITORY_SCP_STYLE_PATTERN = /^([^/\\]+)@([^:]+):(.+)$/;
const URL_HOST_QUERY_OR_FRAGMENT_BEFORE_AT_PATTERN =
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:localhost|(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+|(?:\d{1,3}\.){3}\d{1,3}|\[[^\]]+\])(?::\d+)?[?#][^/\s]*@/i;
const PATHLESS_SINGLE_LABEL_QUERY_OR_FRAGMENT_BEFORE_AT_PATTERN =
  /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([A-Za-z0-9-]+)([?#])([^/\s@]+)@([A-Za-z0-9-]+)(:\d+)?$/i;
const URL_USERINFO_WITH_RAW_QUERY_OR_FRAGMENT_PATTERN =
  /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s]*[?#][^/\s]*)@([^/\s]+(?:\/.*)?)$/i;
const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s?#]*)@/i;
const MAX_PRESERVED_PATHLESS_SINGLE_LABEL_QUERY_OR_FRAGMENT_SEGMENT_LENGTH = 3;
const MIN_PRESERVED_PATHLESS_SINGLE_LABEL_HOST_LENGTH =
  MAX_PRESERVED_PATHLESS_SINGLE_LABEL_QUERY_OR_FRAGMENT_SEGMENT_LENGTH * 2;
const CREDENTIAL_LIKE_PATHLESS_SINGLE_LABEL_HOST_PATTERN =
  /^(?:user(?:name)?|token|secret|pass(?:word)?|pwd|auth|login|admin|root|cred(?:ential)?s?|oauth|api(?:key)?)(?:[-_0-9].*)?$/i;
const CREDENTIAL_LIKE_PATHLESS_SINGLE_LABEL_QUERY_OR_FRAGMENT_PATTERN =
  /^(?:pw|pwd|pass|auth|token|secret|key|name)$/i;

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
  tracker: TTracker;
  workspace: TWorkspace;
  github: TGitHub;
  reviewLoop: TReviewLoop;
  issueBreakdown: TIssueBreakdown;
  agent: TAgent;
  credentialProfiles?: TCredentialProfiles;
  publicMetadata: ProjectContextPublicMetadata;
}

export interface ProjectContextRegistry<TContext extends { id: ProjectContextId; enabled: boolean }> {
  contexts: TContext[];
  enabledContexts: TContext[];
  defaultContextId: ProjectContextId;
  defaultContext: TContext;
  byId: ReadonlyMap<ProjectContextId, TContext>;
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
  const rawProjectContextId = normalizeOptionalNonEmptyString(value?.projectContextId);
  const projectContextId =
    rawProjectContextId === null ? LEGACY_DEFAULT_PROJECT_CONTEXT_ID : normalizeProjectContextId(rawProjectContextId);
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

export function projectContextResolutionFromIssue(issue: unknown): ProjectContextResolution | null {
  if (typeof issue !== "object" || issue === null) return null;
  const value = issue as ProjectContextIssueLike;
  if (value.projectContext) {
    return normalizeProjectContextResolution(value.projectContext);
  }

  const projectContextId = normalizeOptionalNonEmptyString(value.projectContextId);
  const projectContextLabel = normalizeOptionalNonEmptyString(value.projectContextLabel);
  const linearProjectSlug =
    normalizeOptionalNonEmptyString(value.linearProjectSlug) ??
    normalizeOptionalNonEmptyString(value.linearProjectIdentity?.slug);
  const routingSource = normalizeOptionalNonEmptyString(value.routingSource);

  if (projectContextId === null && projectContextLabel === null && linearProjectSlug === null && routingSource === null) {
    return null;
  }

  return normalizeProjectContextResolution({
    ...(projectContextId === null ? {} : { projectContextId }),
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
    repository: sanitizePublicRepositoryValue(input.workspace?.source?.repository),
    path: normalizeOptionalNonEmptyString(input.workspace?.source?.path),
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

function normalizeOptionalNonEmptyString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function sanitizePathlessSingleLabelQueryOrFragmentBeforeAtUrl(repository: string): string | null {
  const match = repository.match(PATHLESS_SINGLE_LABEL_QUERY_OR_FRAGMENT_BEFORE_AT_PATTERN);
  if (!match) return null;
  const scheme = match[1];
  const hostCandidate = match[2];
  const suffixPayload = match[4];
  const trailingHost = match[5];
  const trailingPort = match[6] ?? "";
  if (!scheme || !hostCandidate || !suffixPayload || !trailingHost) return null;
  if (
    trailingPort ||
    suffixPayload.length > MAX_PRESERVED_PATHLESS_SINGLE_LABEL_QUERY_OR_FRAGMENT_SEGMENT_LENGTH ||
    hostCandidate.length < MIN_PRESERVED_PATHLESS_SINGLE_LABEL_HOST_LENGTH ||
    CREDENTIAL_LIKE_PATHLESS_SINGLE_LABEL_HOST_PATTERN.test(hostCandidate) ||
    CREDENTIAL_LIKE_PATHLESS_SINGLE_LABEL_QUERY_OR_FRAGMENT_PATTERN.test(suffixPayload)
  ) {
    return `${scheme}${REDACTED}@${trailingHost}${trailingPort}`;
  }
  return `${scheme}${hostCandidate}`;
}

function sanitizePublicRepositoryValue(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalNonEmptyString(value);
  if (normalized === null) return null;
  const scpStyleMatch = REPOSITORY_SCP_STYLE_PATTERN.exec(normalized);
  if (scpStyleMatch) {
    const [, _username, host, repositoryPath] = scpStyleMatch;
    return `${REDACTED}@${host}:${repositoryPath}`.replace(/[?#].*$/, "");
  }
  if (!REPOSITORY_URL_PATTERN.test(normalized)) return normalized;
  if (URL_HOST_QUERY_OR_FRAGMENT_BEFORE_AT_PATTERN.test(normalized)) {
    return normalized.replace(/[?#].*$/, "");
  }
  const pathlessSingleLabelQueryOrFragmentBeforeAtUrl =
    sanitizePathlessSingleLabelQueryOrFragmentBeforeAtUrl(normalized);
  if (pathlessSingleLabelQueryOrFragmentBeforeAtUrl) return pathlessSingleLabelQueryOrFragmentBeforeAtUrl;
  return normalized
    .replace(URL_USERINFO_WITH_RAW_QUERY_OR_FRAGMENT_PATTERN, `$1${REDACTED}@$3`)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`)
    .replace(/[?#].*$/, "");
}
