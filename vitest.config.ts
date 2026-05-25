import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    // Orchestration tests mutate process-wide fetch/env and run local servers.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
