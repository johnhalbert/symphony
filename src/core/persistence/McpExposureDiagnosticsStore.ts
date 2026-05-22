import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpToolExposureReport } from "../harness/McpToolExposureProbe.js";

export class FileMcpExposureDiagnosticsStore {
  constructor(private readonly stateDir: string) {}

  async writeLatest(report: McpToolExposureReport): Promise<void> {
    await fs.mkdir(this.diagnosticsDir(), { recursive: true });
    await fs.writeFile(this.latestPath(), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  async latest(): Promise<McpToolExposureReport | null> {
    try {
      return JSON.parse(await fs.readFile(this.latestPath(), "utf8")) as McpToolExposureReport;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private diagnosticsDir(): string {
    return path.join(this.stateDir, "diagnostics", "mcp-tool-exposure");
  }

  private latestPath(): string {
    return path.join(this.diagnosticsDir(), "latest.json");
  }
}
