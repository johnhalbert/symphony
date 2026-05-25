import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "../src/settings";

describe("settings", () => {
  it("normalizes base URLs", () => {
    expect(normalizeBaseUrl(" http://127.0.0.1:7331/ ")).toBe("http://127.0.0.1:7331");
  });

  it("rejects empty, non-http, and path-bearing URLs", () => {
    expect(() => normalizeBaseUrl("")).toThrow("Configure symphony.baseUrl");
    expect(() => normalizeBaseUrl("file:///tmp/symphony")).toThrow("http:// or https://");
    expect(() => normalizeBaseUrl("http://127.0.0.1:7331/api/v1/state")).toThrow("should not include an API path");
  });
});
