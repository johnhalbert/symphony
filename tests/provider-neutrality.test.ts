import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("provider-neutral boundaries", () => {
  it("keeps app HTTP and core orchestration free of Cursor provider imports", async () => {
    const files = [
      path.resolve("src/app/http.ts"),
      path.resolve("src/core/orchestrator/Orchestrator.ts"),
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*cursor\/src\//);
      expect(source, file).not.toMatch(/from\s+["'][^"']*CursorHarness\.js["']/);
    }
  });
});
