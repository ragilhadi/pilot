import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pilotrun/agent-runtime": fileURLToPath(
        new URL("./packages/agent-runtime/src/index.ts", import.meta.url),
      ),
      "@pilotrun/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@pilotrun/testkit": fileURLToPath(
        new URL("./packages/testkit/src/index.ts", import.meta.url),
      ),
      "@pilotrun/tools-builtin": fileURLToPath(
        new URL("./packages/tools-builtin/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["evals/**/*.eval.ts"],
    testTimeout: 30_000,
  },
});
