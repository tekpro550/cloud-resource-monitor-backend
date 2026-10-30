import { defineConfig } from "vitest/config";

/** Real S3-compatible storage tests; require STORAGE_IT_* variables (see docs/TESTING.md). */
export default defineConfig({
  test: {
    include: ["tests/storage/**/*.test.ts"],
    globalSetup: ["tests/helpers/globalSetup.ts"],
    setupFiles: ["tests/helpers/env.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
