import { describe, expect, it, vi } from "vitest";
import { loadSchemaCapabilities } from "@/lib/server/schema-capabilities";

describe("Web schema capability preflight", () => {
  it("loads and validates the database contract", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: "2026-08-08.1",
        capabilities: {
          coreLearningV2: true,
          learningDesignV3: true,
          cardPackReadingV5: true,
          originalPdfStorage: true,
          learnerProgress: true,
          sponsorEscrow: true,
          parallelWorkerDispatch: true,
        },
        missing: [],
      },
      error: null,
    });
    await expect(loadSchemaCapabilities({ rpc } as never)).resolves.toMatchObject({
      schemaVersion: "2026-08-08.1",
    });
  });

  it("maps an absent capability RPC to the deployment error contract", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "function is missing from the schema cache" },
    });
    await expect(loadSchemaCapabilities({ rpc } as never)).rejects.toMatchObject({
      code: "deployment_schema_outdated",
    });
  });
});
