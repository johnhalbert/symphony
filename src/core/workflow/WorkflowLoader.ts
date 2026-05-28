import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import YAML from "yaml";
import { type RawWorkflowConfig, type ServiceConfig, parseServiceConfig } from "../config/Config.js";
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

export class WorkflowLoader {
  readonly workflowPath: string;
  private lastGood: LoadedWorkflow | null = null;
  private watcher: FSWatcher | null = null;

  constructor(workflowPath = path.resolve(process.cwd(), "WORKFLOW.md")) {
    this.workflowPath = path.resolve(workflowPath);
  }

  async load(): Promise<LoadedWorkflow> {
    const contents = await readWorkflowFile(this.workflowPath);
    const definition = parseWorkflowFile(contents, this.workflowPath);
    const serviceConfig = parseServiceConfig(definition.config, this.workflowPath, await loadWorkflowEnvironment(this.workflowPath));
    const loaded = { definition, serviceConfig };
    this.lastGood = loaded;
    return loaded;
  }

  getLastGood(): LoadedWorkflow | null {
    return this.lastGood;
  }

  watch(onReload: (event: WorkflowReloadEvent) => void): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.workflowPath, { ignoreInitial: true });
    this.watcher.on("change", () => {
      void this.load()
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
