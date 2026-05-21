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
    const serviceConfig = parseServiceConfig(definition.config, this.workflowPath);
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
