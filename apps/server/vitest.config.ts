import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: ["src/**/*.int.test.ts", "src/**/*.int.test.tsx"],
          setupFiles: ["src/test/env.ts", "src/test/setup-unit.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts", "src/**/*.int.test.tsx"],
          globalSetup: ["src/test/global-setup.ts"],
          setupFiles: ["src/test/env.ts", "src/test/setup-unit.ts"],
          // One database: test files run one after another.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
