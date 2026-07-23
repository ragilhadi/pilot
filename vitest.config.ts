import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@pilot/agent-runtime": fileURLToPath(
        new URL("./packages/agent-runtime/src/index.ts", import.meta.url),
      ),
      "@pilot/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@pilot/provider-openai-compatible": fileURLToPath(
        new URL("./packages/provider-openai-compatible/src/index.ts", import.meta.url),
      ),
      "@pilot/persistence-sqlite": fileURLToPath(
        new URL("./packages/persistence-sqlite/src/index.ts", import.meta.url),
      ),
      "@pilot/testkit": fileURLToPath(new URL("./packages/testkit/src/index.ts", import.meta.url)),
      "@pilot/tools-builtin": fileURLToPath(
        new URL("./packages/tools-builtin/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      enabled: false,
      provider: "v8",
    },
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
