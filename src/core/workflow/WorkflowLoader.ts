import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import YAML from "yaml";
import { type RawWorkflowConfig, type ServiceConfig, parseServiceConfig } from "../config/Config.js";
import { defaultProjectContextLabel, normalizeProjectContextId } from "../config/ProjectContexts.js";
import { SymphonyError, errorMessage } from "../errors.js";

export interface WorkflowDefinition {
  workflowPath: string;
  config: RawWorkflowConfig;
  promptTemplate: string;
}

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  serviceConfig: ServiceConfig;
}

export interface WorkflowReloadEvent {
  loaded: LoadedWorkflow | null;
  error: SymphonyError | null;
}

export interface WorkflowReloadProjectContextDetails {
  contextPath: string;
  rawId: string | null;
  projectContextId: string | null;
  projectContextLabel: string | null;
  enabled: boolean | null;
}

export interface WorkflowReloadErrorDetails {
  reason: "invalid_project_context_configuration" | "duplicate_project_context_id";
  projectContexts: WorkflowReloadProjectContextDetails[];
  projectContextFieldPaths?: string[];
  duplicateProjectContextId?: string;
}

export class WorkflowLoader {
  readonly workflowPath: string;
  private lastGood: LoadedWorkflow | null = null;
  private watcher: FSWatcher | null = null;

  constructor(workflowPath = path.resolve(process.cwd(), "WORKFLOW.md")) {
    this.workflowPath = path.resolve(workflowPath);
  }

  async load(): Promise<LoadedWorkflow> {
    return this.loadInternal({ sanitizeReloadErrors: false });
  }

  getLastGood(): LoadedWorkflow | null {
    return this.lastGood;
  }

  watch(onReload: (event: WorkflowReloadEvent) => void): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.workflowPath, { ignoreInitial: true });
    this.watcher.on("change", () => {
      void this.loadInternal({ sanitizeReloadErrors: true })
        .then((loaded) => onReload({ loaded, error: null }))
        .catch((error: unknown) =>
          onReload({
            loaded: null,
            error:
              error instanceof SymphonyError
                ? error
                : new SymphonyError("workflow_parse_error", errorMessage(error), error),
          }),
        );
    });
  }

  async close(): Promise<void> {
    if (!this.watcher) return;
    const watcher = this.watcher;
    this.watcher = null;
    await watcher.close();
  }

  private async loadInternal(options: { sanitizeReloadErrors: boolean }): Promise<LoadedWorkflow> {
    let definition: WorkflowDefinition | null = null;
    try {
      const contents = await readWorkflowFile(this.workflowPath);
      definition = parseWorkflowFile(contents, this.workflowPath);
      const serviceConfig = parseServiceConfig(definition.config, this.workflowPath, await loadWorkflowEnvironment(this.workflowPath));
      const loaded = { definition, serviceConfig };
      this.lastGood = loaded;
      return loaded;
    } catch (error) {
      if (!options.sanitizeReloadErrors) throw error;
      throw sanitizeWorkflowReloadError(error, definition?.config ?? null);
    }
  }
}

export async function readWorkflowFile(workflowPath: string): Promise<string> {
  try {
    return await fs.readFile(workflowPath, "utf8");
  } catch (error) {
    throw new SymphonyError("missing_workflow_file", `Unable to read workflow file: ${workflowPath}`, error);
  }
}

export async function loadWorkflowEnvironment(
  workflowPath: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const envPath = path.join(path.dirname(path.resolve(workflowPath)), ".env");
  let fileEnv: Record<string, string>;
  try {
    fileEnv = parseDotEnvFile(await fs.readFile(envPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) fileEnv = {};
    else throw new SymphonyError("config_validation_error", `Unable to read env file: ${envPath}`, error);
  }
  return { ...fileEnv, ...parentEnv };
}

export function parseDotEnvFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const unprefixed = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const separator = unprefixed.indexOf("=");
    if (separator < 0) continue;
    const key = unprefixed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = parseDotEnvValue(unprefixed.slice(separator + 1).trim());
  }
  return env;
}

export function parseWorkflowFile(contents: string, workflowPath: string): WorkflowDefinition {
  const normalized = contents.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return {
      workflowPath: path.resolve(workflowPath),
      config: {},
      promptTemplate: normalized.trim(),
    };
  }

  const lines = normalized.split(/\r?\n/);
  let closingLine = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closingLine = index;
      break;
    }
  }

  if (closingLine < 0) {
    throw new SymphonyError("workflow_parse_error", "Workflow front matter is missing a closing delimiter");
  }

  const yamlText = lines.slice(1, closingLine).join("\n");
  const body = lines.slice(closingLine + 1).join("\n").trim();
  let parsed: unknown;
  try {
    parsed = yamlText.trim().length === 0 ? {} : YAML.parse(yamlText);
  } catch (error) {
    throw new SymphonyError("workflow_parse_error", "Workflow front matter YAML is invalid", error);
  }

  if (parsed === null) parsed = {};
  if (!isPlainObject(parsed)) {
    throw new SymphonyError("workflow_front_matter_not_a_map", "Workflow front matter must be a YAML map");
  }

  return {
    workflowPath: path.resolve(workflowPath),
    config: parsed as RawWorkflowConfig,
    promptTemplate: body,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDotEnvValue(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== `"` && quote !== "'") || value[value.length - 1] !== quote) return value;
  const unquoted = value.slice(1, -1);
  if (quote === "'") return unquoted;
  return unquoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, `"`).replace(/\\\\/g, "\\");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

const PROJECT_CONTEXT_ERROR_PATH_PATTERN = /(project_contexts\[("(?:\\.|[^"])*")\])/;
const PROJECT_CONTEXT_PATH_PATTERN = /^project_contexts\[("(?:\\.|[^"])*")\]$/;
const PROJECT_CONTEXT_INDEX_PATH_PATTERN = /^project_contexts\[(\d+)\]$/;
const DUPLICATE_PROJECT_CONTEXT_ID_PATTERN = /^Duplicate project context id: (.+)$/;

function sanitizeWorkflowReloadError(error: unknown, config: RawWorkflowConfig | null): SymphonyError {
  const symphonyError =
    error instanceof SymphonyError ? error : new SymphonyError("workflow_parse_error", errorMessage(error), error);
  const details = config === null ? null : workflowReloadErrorDetails(config, symphonyError);
  if (details === null) return symphonyError;
  return new SymphonyError(symphonyError.code, workflowReloadErrorMessage(details), details);
}

function workflowReloadErrorDetails(config: RawWorkflowConfig, error: SymphonyError): WorkflowReloadErrorDetails | null {
  const signal = workflowReloadErrorSignal(error, config);
  if (signal === null || signal.projectContextPaths.length === 0) return null;
  return {
    reason: signal.duplicateProjectContextId === null ? "invalid_project_context_configuration" : "duplicate_project_context_id",
    projectContexts: signal.projectContextPaths.map((contextPath) => workflowReloadProjectContextDetails(config, contextPath)),
    ...(signal.projectContextFieldPaths.length === 0
      ? {}
      : { projectContextFieldPaths: signal.projectContextFieldPaths }),
    ...(signal.duplicateProjectContextId === null
      ? {}
      : { duplicateProjectContextId: signal.duplicateProjectContextId }),
  };
}

function workflowReloadErrorMessage(details: WorkflowReloadErrorDetails): string {
  const contextSummary = details.projectContexts.map((context) => context.contextPath).join(", ");
  if (details.reason === "duplicate_project_context_id") {
    return `Workflow reload validation failed for ${contextSummary}: duplicate normalized project context id`;
  }
  const fieldSummary = workflowReloadFieldSummary(details.projectContextFieldPaths ?? []);
  if (fieldSummary !== null) {
    return `Workflow reload validation failed for ${contextSummary}: invalid ${fieldSummary}`;
  }
  return `Workflow reload validation failed for ${contextSummary}: invalid project context configuration`;
}

function workflowReloadFieldSummary(fieldPaths: readonly string[]): string | null {
  const uniqueFieldPaths = uniqueStrings(fieldPaths);
  return uniqueFieldPaths.length === 0 ? null : uniqueFieldPaths.join(", ");
}

interface WorkflowReloadErrorSignal {
  projectContextPaths: string[];
  projectContextFieldPaths: string[];
  duplicateProjectContextId: string | null;
}

function workflowReloadErrorSignal(error: SymphonyError, config: RawWorkflowConfig): WorkflowReloadErrorSignal | null {
  const signaled = readWorkflowReloadErrorSignal(error.details);
  if (signaled.projectContextPaths.length > 0) return signaled;

  const pathMatch = PROJECT_CONTEXT_ERROR_PATH_PATTERN.exec(error.message);
  if (pathMatch?.[1]) {
    return {
      projectContextPaths: [pathMatch[1]],
      projectContextFieldPaths: extractProjectContextFieldPaths(error.message, pathMatch[1]),
      duplicateProjectContextId: null,
    };
  }

  const duplicateMatch = DUPLICATE_PROJECT_CONTEXT_ID_PATTERN.exec(error.message);
  const duplicateProjectContextId = normalizeNonEmptyString(duplicateMatch?.[1]);
  if (duplicateProjectContextId === null) return null;

  const projectContextPaths = workflowReloadProjectContextPathsForDuplicateId(config, duplicateProjectContextId);
  if (projectContextPaths.length === 0) return null;
  return {
    projectContextPaths,
    projectContextFieldPaths: [],
    duplicateProjectContextId,
  };
}

function readWorkflowReloadErrorSignal(details: unknown): WorkflowReloadErrorSignal {
  if (!isPlainObject(details)) {
    return {
      projectContextPaths: [],
      projectContextFieldPaths: [],
      duplicateProjectContextId: null,
    };
  }
  return {
    projectContextPaths: uniqueStrings(readStringArray(details.projectContextPaths)),
    projectContextFieldPaths: uniqueStrings(readStringArray(details.projectContextFieldPaths)),
    duplicateProjectContextId: normalizeNonEmptyString(details.duplicateProjectContextId),
  };
}

function workflowReloadProjectContextPathsForDuplicateId(config: RawWorkflowConfig, duplicateProjectContextId: string): string[] {
  return uniqueStrings(
    readRawProjectContexts(config).flatMap((rawContext, index) => {
      const rawId = readRawProjectContextId(rawContext);
      if (rawId === null || normalizeWorkflowReloadProjectContextId(rawId) !== duplicateProjectContextId) return [];
      return [workflowReloadContextPath(rawId, index)];
    }),
  );
}

function workflowReloadProjectContextDetails(
  config: RawWorkflowConfig,
  contextPath: string,
): WorkflowReloadProjectContextDetails {
  const rawContextMatch = PROJECT_CONTEXT_PATH_PATTERN.exec(contextPath);
  const rawIdFromPath = rawContextMatch?.[1] ? parseWorkflowReloadContextRawId(rawContextMatch[1]) : null;
  const contextIndex = parseWorkflowReloadContextIndex(contextPath);
  const rawContexts = readRawProjectContexts(config);
  const rawContext =
    contextIndex !== null
      ? (rawContexts[contextIndex] ?? null)
      : rawIdFromPath === null
        ? null
        : rawContexts.find((candidate) => readRawProjectContextId(candidate) === rawIdFromPath) ?? null;
  const rawId = readRawProjectContextId(rawContext) ?? rawIdFromPath;
  const projectContextId = rawId === null ? null : normalizeWorkflowReloadProjectContextId(rawId);
  return {
    contextPath,
    rawId,
    projectContextId,
    projectContextLabel: workflowReloadProjectContextLabel(readRawProjectContextLabel(rawContext), rawId, projectContextId),
    enabled: readRawProjectContextEnabled(rawContext),
  };
}

function parseWorkflowReloadContextIndex(value: string): number | null {
  const match = PROJECT_CONTEXT_INDEX_PATH_PATTERN.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseWorkflowReloadContextRawId(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function readRawProjectContexts(config: RawWorkflowConfig): unknown[] {
  return Array.isArray(config.project_contexts) ? (config.project_contexts as unknown[]) : [];
}

function readRawProjectContextId(value: unknown): string | null {
  return isPlainObject(value) && typeof value.id === "string" ? value.id : null;
}

function readRawProjectContextLabel(value: unknown): string | null {
  return isPlainObject(value) && typeof value.label === "string" ? value.label : null;
}

function readRawProjectContextEnabled(value: unknown): boolean | null {
  if (!isPlainObject(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "enabled") || value.enabled === undefined) return true;
  return typeof value.enabled === "boolean" ? value.enabled : null;
}

function normalizeWorkflowReloadProjectContextId(value: string): string | null {
  try {
    return normalizeProjectContextId(value);
  } catch {
    return null;
  }
}

function workflowReloadProjectContextLabel(
  value: string | null,
  rawId: string | null,
  projectContextId: string | null,
): string | null {
  const normalizedLabel = value?.trim();
  if (normalizedLabel && normalizedLabel.length > 0) return normalizedLabel;
  if (projectContextId) return defaultProjectContextLabel(projectContextId);
  const normalizedRawId = rawId?.trim();
  return normalizedRawId && normalizedRawId.length > 0 ? normalizedRawId : rawId;
}

function workflowReloadContextPath(rawId: string | null, index: number): string {
  return rawId === null ? `project_contexts[${index}]` : `project_contexts[${JSON.stringify(rawId)}]`;
}

function extractProjectContextFieldPaths(message: string, contextPath: string): string[] {
  const prefix = `${contextPath}.`;
  if (message.startsWith(prefix)) {
    const remainder = message.slice(prefix.length);
    const scopedMatch = /^([a-z_]+(?:\.[a-z_]+|\[\d+\])*)/.exec(remainder);
    if (scopedMatch?.[1]) return [scopedMatch[1]];
  }
  return uniqueStrings(message.match(/[a-z_]+(?:\.[a-z_]+|\[\d+\])+/g) ?? []);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}
