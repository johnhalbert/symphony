import { describe, expect, it } from "vitest";
import { sanitizeTranscriptPreview } from "../src/webview/transcriptSanitizer";

describe("webview transcript sanitizer", () => {
  it("redacts token-like labels and token prefixes while preserving safe token telemetry", () => {
    const sanitized = sanitizeTranscriptPreview(
      [
        "SECRET_WEBVIEW",
        "token=plain-token",
        "access_token=access-token",
        "refreshToken: refresh-token",
        "github_token=github-token",
        "client_secret: client-secret",
        "private_key=private-key",
        "Bearer bearer-token",
        "ghp_ABCDEFGH1",
        "sk-ABCDEFGH1",
        "inputTokens: 7",
        "totalTokens: 9",
        "tokenConfigured: true",
      ].join(" "),
    );

    expect(sanitized).not.toContain("SECRET_WEBVIEW");
    expect(sanitized).not.toContain("plain-token");
    expect(sanitized).not.toContain("access-token");
    expect(sanitized).not.toContain("refresh-token");
    expect(sanitized).not.toContain("github-token");
    expect(sanitized).not.toContain("client-secret");
    expect(sanitized).not.toContain("private-key");
    expect(sanitized).not.toContain("bearer-token");
    expect(sanitized).not.toContain("ghp_ABCDEFGH1");
    expect(sanitized).not.toContain("sk-ABCDEFGH1");
    expect(sanitized).toContain("inputTokens: 7");
    expect(sanitized).toContain("totalTokens: 9");
    expect(sanitized).toContain("tokenConfigured: true");
    expect(sanitized).toContain("[redacted]");
  });
});
