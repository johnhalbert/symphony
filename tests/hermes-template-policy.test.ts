import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

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
