import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mindmark/ai-gateway": fileURLToPath(
        new URL("../../packages/ai-gateway/src/index.ts", import.meta.url),
      ),
      "@mindmark/shared/learning-project": fileURLToPath(
        new URL("../../packages/shared/src/learning-project/index.ts", import.meta.url),
      ),
      "@mindmark/shared/chapter": fileURLToPath(
        new URL("../../packages/shared/src/chapter/index.ts", import.meta.url),
      ),
      "@mindmark/shared/knowledge-card": fileURLToPath(
        new URL("../../packages/shared/src/knowledge-card/index.ts", import.meta.url),
      ),
      "@mindmark/shared/study": fileURLToPath(
        new URL("../../packages/shared/src/study/index.ts", import.meta.url),
      ),
      "@mindmark/shared/commitments": fileURLToPath(
        new URL("../../packages/shared/src/commitments/index.ts", import.meta.url),
      ),
      "@mindmark/shared/schemas": fileURLToPath(
        new URL("../../packages/shared/src/schemas.ts", import.meta.url),
      ),
      "@mindmark/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
});
