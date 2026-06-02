import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { SYMPHONY_HERMES_AGENT_MAX_TURNS } from "../hermes/src/HermesMcpConfig.js";
import { HermesProfileManager } from "../hermes/src/HermesProfileManager.js";
import { parseServiceConfig } from "../src/core/config/Config.js";

describe("Hermes role template policy", () => {
  it("disables subagent delegation only for reviewer profiles", async () => {
    const templatesDir = path.resolve("hermes", "templates");

    const reviewer = await readTemplateConfig(path.join(templatesDir, "reviewer", "config.yaml"));
    expect(disabledToolsets(reviewer)).toEqual(expect.arrayContaining(["tts", "delegation"]));

    const worker = await readTemplateConfig(path.join(templatesDir, "worker", "config.yaml"));
    const planner = await readTemplateConfig(path.join(templatesDir, "planner", "config.yaml"));
    expect(disabledToolsets(worker)).not.toContain("delegation");
    expect(disabledToolsets(planner)).not.toContain("delegation");
  });

  it("gives all Symphony role profiles the extended tool-call budget", async () => {
    const templatesDir = path.resolve("hermes", "templates");

    const worker = await readTemplateConfig(path.join(templatesDir, "worker", "config.yaml"));
    const reviewer = await readTemplateConfig(path.join(templatesDir, "reviewer", "config.yaml"));
    const planner = await readTemplateConfig(path.join(templatesDir, "planner", "config.yaml"));

    expect(agentMaxTurns(worker)).toBe(SYMPHONY_HERMES_AGENT_MAX_TURNS);
    expect(agentMaxTurns(reviewer)).toBe(SYMPHONY_HERMES_AGENT_MAX_TURNS);
    expect(agentMaxTurns(planner)).toBe(SYMPHONY_HERMES_AGENT_MAX_TURNS);
  });

  it("gives delegating Symphony profiles the extended child-agent budget", async () => {
    const templatesDir = path.resolve("hermes", "templates");

    const worker = await readTemplateConfig(path.join(templatesDir, "worker", "config.yaml"));
    const planner = await readTemplateConfig(path.join(templatesDir, "planner", "config.yaml"));
    const reviewer = await readTemplateConfig(path.join(templatesDir, "reviewer", "config.yaml"));

    expect(disabledToolsets(worker)).not.toContain("delegation");
    expect(disabledToolsets(planner)).not.toContain("delegation");
    expect(delegationMaxIterations(worker)).toBe(SYMPHONY_HERMES_AGENT_MAX_TURNS);
    expect(delegationMaxIterations(planner)).toBe(SYMPHONY_HERMES_AGENT_MAX_TURNS);
    expect(disabledToolsets(reviewer)).toContain("delegation");
  });

  it("delays compression for all Symphony role profiles", async () => {
    const templatesDir = path.resolve("hermes", "templates");

    const worker = await readTemplateConfig(path.join(templatesDir, "worker", "config.yaml"));
    const reviewer = await readTemplateConfig(path.join(templatesDir, "reviewer", "config.yaml"));
    const planner = await readTemplateConfig(path.join(templatesDir, "planner", "config.yaml"));

    expect(compressionThreshold(worker)).toBe(0.75);
    expect(compressionThreshold(reviewer)).toBe(0.75);
    expect(compressionThreshold(planner)).toBe(0.75);
  });

  it("seeds and requires the Symphony worker implementation skill", async () => {
    const workerTemplateDir = path.resolve("hermes", "templates", "worker");
    const soul = await readFile(path.join(workerTemplateDir, "SOUL.md"), "utf8");
    const skill = await readFile(
      path.join(workerTemplateDir, "skills", "orchestration", "symphony-worker-implementation", "SKILL.md"),
      "utf8",
    );

    expect(soul).toContain("skill_view");
    expect(soul).toContain("symphony-worker-implementation");
    expect(skill).toContain("name: symphony-worker-implementation");
    expect(skill).toContain("delegate_task");
    expect(skill).toContain("bounded read-only research");
    expect(skill).toContain("child research must be leaf-only");
    expect(skill).toContain("capped `terminal` reducer commands");
    expect(skill).toContain("150 lines or 20 KB");
    expect(skill).toContain("rg --files");
    expect(skill).toContain("Do not dump large recursive search results");
    expect(skill).toContain("stop and return current findings");
    expect(skill).toContain("Do not perform service-owned publication actions");
  });

  it("keeps ENG-243 command-policy enforcement rooted outside vendored Hermes source", () => {
    const workflowDir = path.resolve(".");
    const config = parseServiceConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "TEST",
        },
        workspace: {
          root: path.join(workflowDir, "symphony_workspaces"),
        },
      },
      path.join(workflowDir, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-test-key" },
    );
    const vendoredHermesRoot = path.resolve(workflowDir, "hermes", "upstream-src");
    const manager = new HermesProfileManager({
      templatesDir: config.hermes.templatesDir,
      stateDir: config.hermes.stateDir,
    });
    const roleTemplatePaths = Object.entries(config.hermes.roleTemplates).map(([role, template]) => ({
      label: `generated ${role} profile template`,
      targetPath: manager.resolveTemplateDir(template),
    }));
    const generatedProfileDirs = [
      manager.resolveProfileDir({
        workspaceKey: "eng-243",
        role: "worker",
        phase: "implementation",
        profileKey: "command-policy-hook",
      }),
      manager.resolveProfileDir({
        workspaceKey: "eng-243",
        role: "reviewer",
        phase: "review",
        profileKey: "command-policy-hook",
      }),
      manager.resolveProfileDir({
        workspaceKey: "eng-243",
        role: "worker",
        phase: "merge_conflict_resolution",
        profileKey: "command-policy-hook",
      }),
    ];
    const generatedProfilePaths = generatedProfileDirs.flatMap((profileDir) => [
      { label: `generated profile ${profileDir}`, targetPath: profileDir },
      { label: `generated profile config ${profileDir}`, targetPath: path.join(profileDir, "config.yaml") },
    ]);
    const symphonyOwnedPolicyPaths = [
      { label: "policy fixture builders", targetPath: path.resolve("tests", "agent-command-policy-fixtures.ts") },
      { label: "shared policy classifier", targetPath: path.resolve("src", "core", "harness", "AgentCommandPolicy.ts") },
      {
        label: "policy hook runner",
        targetPath: path.resolve("src", "core", "harness", "AgentCommandPolicyHookRunner.ts"),
      },
      {
        label: "ACP policy resolver",
        targetPath: path.resolve("src", "core", "harness", "AgentCommandPolicyAcpResolver.ts"),
      },
      { label: "HarnessFactory injection", targetPath: path.resolve("src", "core", "harness", "HarnessFactory.ts") },
      { label: "agent-command-policy-hook CLI", targetPath: path.resolve("src", "cli.ts") },
      { label: "Hermes ACP harness integration", targetPath: path.resolve("hermes", "src", "HermesAcpHarness.ts") },
      { label: "Hermes gateway harness integration", targetPath: path.resolve("hermes", "src", "HermesHarness.ts") },
      { label: "Hermes MCP/profile config writer", targetPath: path.resolve("hermes", "src", "HermesMcpConfig.ts") },
      { label: "Hermes role templates root", targetPath: config.hermes.templatesDir },
      { label: "worker role config", targetPath: path.resolve("hermes", "templates", "worker", "config.yaml") },
      { label: "reviewer role config", targetPath: path.resolve("hermes", "templates", "reviewer", "config.yaml") },
      { label: "planner role config", targetPath: path.resolve("hermes", "templates", "planner", "config.yaml") },
      { label: "worker policy guidance", targetPath: path.resolve("hermes", "templates", "worker", "SOUL.md") },
      {
        label: "worker implementation skill guidance",
        targetPath: path.resolve(
          "hermes",
          "templates",
          "worker",
          "skills",
          "orchestration",
          "symphony-worker-implementation",
          "SKILL.md",
        ),
      },
      ...roleTemplatePaths,
      ...generatedProfilePaths,
    ];

    expect(config.hermes.upstreamRoot).toBe(vendoredHermesRoot);
    expect(config.hermes.templatesDir).toBe(path.resolve(workflowDir, "hermes", "templates"));
    expect(isPathRootedUnder(path.join(vendoredHermesRoot, "hermes_cli", "auth.py"), vendoredHermesRoot)).toBe(true);
    expect(isPathRootedUnder(path.resolve("hermes", "upstream-src-fake", "hook.ts"), vendoredHermesRoot)).toBe(false);
    expect(isPathRootedUnder(path.resolve("hermes", "src", "HermesHarness.ts"), vendoredHermesRoot)).toBe(false);
    expect(isPathRootedUnder("/repo/hermes/upstream-src/hermes_cli/auth.py", "/repo/hermes/upstream-src", path.posix)).toBe(
      true,
    );
    expect(isPathRootedUnder("/repo/hermes/upstream-src-fake/hook.ts", "/repo/hermes/upstream-src", path.posix)).toBe(
      false,
    );
    expect(
      isPathRootedUnder("C:\\repo\\hermes\\upstream-src\\hermes_cli\\auth.py", "C:\\repo\\hermes\\upstream-src", path.win32),
    ).toBe(true);
    expect(
      isPathRootedUnder("C:\\repo\\hermes\\upstream-src-fake\\hook.ts", "C:\\repo\\hermes\\upstream-src", path.win32),
    ).toBe(false);

    expect(symphonyOwnedPolicyPaths.filter(({ targetPath }) => isPathRootedUnder(targetPath, vendoredHermesRoot))).toEqual([]);
  });
});

async function readTemplateConfig(filePath: string): Promise<Record<string, unknown>> {
  const parsed = YAML.parse(await readFile(filePath, "utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function disabledToolsets(config: Record<string, unknown>): string[] {
  const agent = config.agent;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return [];
  const disabled = (agent as Record<string, unknown>).disabled_toolsets;
  return Array.isArray(disabled) ? disabled.filter((value): value is string => typeof value === "string") : [];
}

function agentMaxTurns(config: Record<string, unknown>): number | null {
  const agent = config.agent;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return null;
  const maxTurns = (agent as Record<string, unknown>).max_turns;
  return typeof maxTurns === "number" ? maxTurns : null;
}

function compressionThreshold(config: Record<string, unknown>): number | null {
  const compression = config.compression;
  if (typeof compression !== "object" || compression === null || Array.isArray(compression)) return null;
  const threshold = (compression as Record<string, unknown>).threshold;
  return typeof threshold === "number" ? threshold : null;
}

function delegationMaxIterations(config: Record<string, unknown>): number | null {
  const delegation = config.delegation;
  if (typeof delegation !== "object" || delegation === null || Array.isArray(delegation)) return null;
  const maxIterations = (delegation as Record<string, unknown>).max_iterations;
  return typeof maxIterations === "number" ? maxIterations : null;
}

type PathOperations = Pick<typeof path, "isAbsolute" | "relative" | "resolve">;

function isPathRootedUnder(targetPath: string, rootPath: string, pathOps: PathOperations = path): boolean {
  const root = pathOps.resolve(rootPath);
  const target = pathOps.resolve(targetPath);
  const relative = pathOps.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !pathOps.isAbsolute(relative));
}
