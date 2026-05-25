export interface SymphonySettings {
  baseUrl: string;
  token: string;
}

export function readSymphonySettings(): SymphonySettings {
  // Load vscode lazily so pure helpers remain unit-testable outside the extension host.
  const vscode = require("vscode") as typeof import("vscode");
  const config = vscode.workspace.getConfiguration("symphony");
  return {
    baseUrl: config.get<string>("baseUrl") ?? "",
    token: config.get<string>("token") ?? "",
  };
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Configure symphony.baseUrl before connecting.");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Symphony base URL must start with http:// or https://.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname && url.pathname !== "/") {
    throw new Error("Symphony base URL should not include an API path.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}
