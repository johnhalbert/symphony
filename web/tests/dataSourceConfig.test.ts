import { describe, expect, it } from "vitest";
import { resolveDataSourceConfig } from "../src/data/dataSourceConfig";

describe("web data-source configuration", () => {
  it("keeps mock mode as the default for local design review", () => {
    expect(resolveDataSourceConfig({})).toEqual({ mode: "mock", apiBaseUrl: "" });
  });

  it("preserves existing API activation when an absolute API base URL is configured", () => {
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_API_BASE_URL: " https://symphony.test " })).toEqual({
      mode: "api",
      apiBaseUrl: "https://symphony.test",
    });
  });

  it("activates API mode with same-origin requests when Vite proxy mode is selected", () => {
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_DATA_SOURCE: " api " })).toEqual({ mode: "api", apiBaseUrl: "" });
  });

  it("lets an explicit mock mode override an API base URL", () => {
    expect(
      resolveDataSourceConfig({
        VITE_SYMPHONY_DATA_SOURCE: "mock",
        VITE_SYMPHONY_API_BASE_URL: "https://symphony.test",
      }),
    ).toEqual({ mode: "mock", apiBaseUrl: "https://symphony.test" });
  });

  it("treats invalid mode values as unset instead of disabling the base-URL fallback", () => {
    expect(
      resolveDataSourceConfig({
        VITE_SYMPHONY_DATA_SOURCE: "not-a-mode",
        VITE_SYMPHONY_API_BASE_URL: "https://symphony.test",
      }),
    ).toEqual({ mode: "api", apiBaseUrl: "https://symphony.test" });
  });
});
