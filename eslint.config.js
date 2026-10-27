// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".artifacts/**",
      ".codegraph/**",
      ".handoff/**",
      ".remote-execute-state/**",
      ".remote-runner-state/**",
    ],
  },
  {
    // recommendedTypeChecked's require-await/unsafe-* rules mostly fired on this
    // repo's intentional async-interface-stub pattern, not real bugs; only the
    // type-aware rules that catch actual async mistakes are added back explicitly.
    files: [
      "src/**/*.ts",
      "tests/**/*.ts",
      "packages/runner-router/src/**/*.ts",
      "packages/backup-trigger/src/**/*.ts",
      "packages/runner-router/tests/**/*.ts",
      "packages/backup-trigger/tests/**/*.ts",
    ],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // repo convention: leading underscore marks a param/binding intentionally unused
      // (interface-required signature, destructured-but-ignored field)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
);
