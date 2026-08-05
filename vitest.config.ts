import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    /* Every suite that spawns git needs the inherited repository-scoped GIT_* stripped, so the seam
       is the runner's preload rather than each fixture — the per-suite variant recurs. */
    setupFiles: ["tests/setup/git-environment.ts"],
  },
});
