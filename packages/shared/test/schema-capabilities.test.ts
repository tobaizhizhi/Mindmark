import { describe, expect, it } from "vitest";
import {
  DeploymentSchemaOutdatedError,
  REQUIRED_SCHEMA_VERSION,
  assertRequiredSchemaCapabilities,
  isDeploymentSchemaError,
} from "../src/schema-capabilities.js";

const allCapabilities = {
  coreLearningV2: true,
  learningDesignV3: true,
  cardPackReadingV5: true,
  originalPdfStorage: true,
  learnerProgress: true,
  sponsorEscrow: true,
};

describe("deployment schema capabilities", () => {
  it("accepts the current complete schema contract", () => {
    expect(assertRequiredSchemaCapabilities({
      schemaVersion: REQUIRED_SCHEMA_VERSION,
      capabilities: allCapabilities,
      missing: [],
    }).capabilities).toEqual(allCapabilities);
  });

  it("reports incomplete deployments with a stable error", () => {
    expect(() => assertRequiredSchemaCapabilities({
      schemaVersion: REQUIRED_SCHEMA_VERSION,
      capabilities: { ...allCapabilities, originalPdfStorage: false },
      missing: ["learning_projects.source_storage_bucket"],
    })).toThrow(DeploymentSchemaOutdatedError);
  });

  it("recognizes Postgres and PostgREST schema mismatch errors", () => {
    expect(isDeploymentSchemaError({
      code: "PGRST202",
      message: "Could not find the function public.save_project_outline_draft_v2 in the schema cache",
    })).toBe(true);
    expect(isDeploymentSchemaError({
      code: "42703",
      message: "column learning_projects.source_storage_bucket does not exist",
    })).toBe(true);
    expect(isDeploymentSchemaError(new Error("AI request timed out"))).toBe(false);
  });
});
