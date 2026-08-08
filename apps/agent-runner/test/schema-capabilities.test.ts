import { describe, expect, it, vi } from "vitest";
import { assertRunnerSchemaCapabilities } from "../src/persistence/schema-capabilities.js";

describe("Runner schema capability preflight", () => {
  it("fails before workflow polling when the deployed schema is incomplete", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: "2026-08-08.1",
        capabilities: {
          coreLearningV2: true,
          learningDesignV3: false,
          cardPackReadingV5: true,
          originalPdfStorage: true,
          learnerProgress: true,
          sponsorEscrow: true,
          parallelWorkerDispatch: true,
        },
        missing: ["learning_design_v3"],
      },
      error: null,
    });
    await expect(assertRunnerSchemaCapabilities({ rpc } as never)).rejects.toMatchObject({
      code: "deployment_schema_outdated",
      missing: ["learning_design_v3"],
    });
  });
});
