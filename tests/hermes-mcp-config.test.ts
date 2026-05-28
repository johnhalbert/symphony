import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toHermesMcpServers, writeHermesMcpConfig } from "../hermes/src/HermesMcpConfig.js";

let root: string;

describe("Hermes MCP config", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-mcp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("translates Symphony subprocess servers into Hermes mcp_servers", () => {
    expect(
      toHermesMcpServers(
        {
          symphony: {
            type: "stdio",
            command: "node",
            args: ["dist/cli.js", "completion-report-mcp"],
            cwd: root,
            env: { LINEAR_API_KEY: "secret" },
          },
        },
        { timeoutSeconds: 30, connectTimeoutSeconds: 5 },
      ),
    ).toEqual({
      symphony: {
        command: "node",
        args: ["dist/cli.js", "completion-report-mcp"],
        env: { LINEAR_API_KEY: "secret" },
        timeout: 30,
        connect_timeout: 5,
      },
    });
  });

  it("merges mcp_servers into an existing Hermes config file", async () => {
    const profileDir = path.join(root, "profile");
    await writeHermesMcpConfig({
      profileDir,
      servers: {
        symphony_review: {
          type: "stdio",
          command: "node",
          args: ["cli.js", "review-verdict-mcp"],
          cwd: root,
          env: {},
        },
      },
    });

    const parsed = YAML.parse(await readFile(path.join(profileDir, "config.yaml"), "utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      mcp_servers: {
        symphony_review: {
          command: "node",
          args: ["cli.js", "review-verdict-mcp"],
          timeout: 120,
          connect_timeout: 60,
        },
      },
    });
  });
});
