import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "@mindmark/shared/schemas": fileURLToPath(
        new URL("../../packages/shared/src/schemas.ts", import.meta.url),
      ),
      "@mindmark/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
});
