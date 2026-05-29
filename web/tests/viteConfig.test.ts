import { describe, expect, it } from "vitest";
import { resolveApiProxyTarget } from "../src/config/apiProxyConfig";

describe("Vite API proxy configuration", () => {
  it("defaults /api proxying to the Symphony status server", () => {
    expect(resolveApiProxyTarget({})).toBe("http://127.0.0.1:7331");
  });

  it("uses the explicit server-side proxy target before Vite-exposed values", () => {
    expect(
      resolveApiProxyTarget({
        SYMPHONY_WEB_API_PROXY_TARGET: " http://127.0.0.1:7444/ ",
        VITE_SYMPHONY_API_BASE_URL: "https://wrong.example",
      }),
    ).toBe("http://127.0.0.1:7444");
  });

  it("can reuse an absolute API base URL as the proxy target for dev", () => {
    expect(resolveApiProxyTarget({ VITE_SYMPHONY_API_BASE_URL: "https://symphony.test///" })).toBe("https://symphony.test");
  });

  it("ignores same-origin or invalid client base URLs for the proxy target", () => {
    expect(resolveApiProxyTarget({ VITE_SYMPHONY_API_BASE_URL: "/" })).toBe("http://127.0.0.1:7331");
    expect(resolveApiProxyTarget({ VITE_SYMPHONY_API_PROXY_TARGET: "not a url" })).toBe("http://127.0.0.1:7331");
  });
});
