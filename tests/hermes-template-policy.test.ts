import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { SYMPHONY_HERMES_AGENT_MAX_TURNS } from "../hermes/src/HermesMcpConfig.js";

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
