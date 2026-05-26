import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("extension boundary", () => {
  it("does not import orchestration internals or Cursor SDK harness code", async () => {
    const files = await sourceFiles(path.resolve("src"));
    const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    expect(combined).not.toMatch(/@cursor\/sdk/);
    expect(combined).not.toMatch(/(?:\.\.\/)+cursor\//);
    expect(combined).not.toMatch(/(?:\.\.\/)+src\/core\//);
  });

  it("keeps webview messages in the shared contract module", async () => {
    const provider = await readFile(path.resolve("src/webviewProvider.ts"), "utf8");
    const webview = await readFile(path.resolve("src/webview/main.ts"), "utf8");

    expect(provider).not.toMatch(/type ExtensionMessage =/);
    expect(webview).not.toMatch(/type ExtensionMessage =/);
    expect(provider).toContain("./webviewMessages");
    expect(webview).toContain("../webviewMessages");
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      return entry.isFile() && fullPath.endsWith(".ts") ? [fullPath] : [];
    }),
  );
  return nested.flat();
}
