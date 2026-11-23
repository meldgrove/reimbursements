import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/server/drizzle/**",
      "apps/server/native/build/**",
      "**/coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["apps/server/**/*.{ts,tsx,mjs}", "packages/**/*.ts", "**/*.config.{ts,mjs}", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // The browser checks report their progress on the console.
    files: ["tests/browser/**/*.{mjs,cjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-console": "off", "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Runs in the browser before the app (apps/web/index.html).
    files: ["apps/web/public/**/*.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
);
