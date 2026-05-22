import { describe, expect, it, vi } from "vitest";
import {
  classifyToolListResult,
  MCP_TOOL_EXPOSURE_SPECS,
  normalizeMcpToolName,
  redactSensitiveText,
} from "../src/core/harness/McpToolExposureProbe.js";

describe("MCP tool exposure probe helpers", () => {
  it("normalizes only bare and known server-prefixed Symphony MCP tool names", () => {
    expect(normalizeMcpToolName("submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("symphony.submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("mcp_symphony_submit_completion_report")).toBe("submit_completion_report");
    expect(normalizeMcpToolName("review-verdict-mcp:submit_review_verdict")).toBe("submit_review_verdict");
    expect(normalizeMcpToolName("mcp_symphony_review_feedback_submit_pull_request_review_feedback")).toBe(
      "submit_pull_request_review_feedback",
    );
    expect(normalizeMcpToolName("evil_symphony_submit_completion_report")).toBeNull();
    expect(normalizeMcpToolName("mcp_unknown_submit_completion_report")).toBeNull();
    expect(normalizeMcpToolName("symphony.submit_completion_report_extra")).toBeNull();
  });

  it("classifies subprocess empty and mismatch results separately from success", () => {
    const workerSpec = MCP_TOOL_EXPOSURE_SPECS[0];
    expect(workerSpec).toBeDefined();
    if (!workerSpec) throw new Error("missing worker spec");

    expect(classifyToolListResult("subprocess", workerSpec, [], ["LINEAR_API_KEY"])).toMatchObject({
      status: "failure",
      failureCode: "subprocess_missing_empty_name_mismatch",
      envKeyNames: ["LINEAR_API_KEY"],
    });
    expect(classifyToolListResult("subprocess", workerSpec, ["unexpected"], ["B_KEY", "A_KEY"])).toMatchObject({
      status: "failure",
      failureCode: "subprocess_missing_empty_name_mismatch",
      rawToolNames: ["unexpected"],
      envKeyNames: ["A_KEY", "B_KEY"],
    });
    expect(classifyToolListResult("sdk", workerSpec, ["mcp_symphony_submit_completion_report"])).toMatchObject({
      status: "success",
      failureCode: null,
      normalizedToolNames: ["submit_completion_report"],
    });
  });

  it("redacts common token forms and configured secret values", () => {
    vi.stubEnv("CURSOR_API_KEY", "cursor_secret_from_env");
    expect(
      redactSensitiveText(
        "Authorization: Bearer cursor_secret_from_env GITHUB_TOKEN=ghp_1234567890abcdef token: \"github_pat_1234567890abcdef\"",
      ),
    ).toBe('Authorization: Bearer [REDACTED] GITHUB_TOKEN=[REDACTED] token: "[REDACTED]"');
    expect(redactSensitiveText("failed with value custom-secret", ["custom-secret"])).toBe("failed with value [REDACTED]");
    vi.unstubAllEnvs();
  });
});
