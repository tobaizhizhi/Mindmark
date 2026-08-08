import { z } from "zod";

export const REQUIRED_SCHEMA_MIGRATION = "20260808000100_parallel_worker_dispatch.sql";
export const REQUIRED_SCHEMA_VERSION = "2026-08-08.1";

export const SchemaCapabilitySetSchema = z.object({
  coreLearningV2: z.boolean(),
  learningDesignV3: z.boolean(),
  cardPackReadingV5: z.boolean(),
  originalPdfStorage: z.boolean(),
  learnerProgress: z.boolean(),
  sponsorEscrow: z.boolean(),
  parallelWorkerDispatch: z.boolean(),
}).strict();

export const SchemaCapabilitiesSchema = z.object({
  schemaVersion: z.string().min(1),
  capabilities: SchemaCapabilitySetSchema,
  missing: z.array(z.string().min(1)),
}).strict();

export type SchemaCapabilitySet = z.infer<typeof SchemaCapabilitySetSchema>;
export type SchemaCapabilities = z.infer<typeof SchemaCapabilitiesSchema>;

const SCHEMA_ERROR_PATTERNS = [
  /schema cache/iu,
  /could not find the function/iu,
  /column .+ does not exist/iu,
  /relation .+ does not exist/iu,
  /function .+ does not exist/iu,
];

function errorDetails(error: unknown): { code: string; text: string } {
  if (error instanceof Error) {
    const cause = error.cause ? errorDetails(error.cause) : { code: "", text: "" };
    return { code: cause.code, text: `${error.message} ${cause.text}`.trim() };
  }
  if (!error || typeof error !== "object") return { code: "", text: String(error ?? "") };
  const candidate = error as Record<string, unknown>;
  return {
    code: typeof candidate.code === "string" ? candidate.code : "",
    text: [candidate.message, candidate.details, candidate.hint]
      .filter((value): value is string => typeof value === "string")
      .join(" "),
  };
}

export function isDeploymentSchemaError(error: unknown): boolean {
  const details = errorDetails(error);
  return ["42703", "42P01", "42883", "PGRST200", "PGRST202", "PGRST204"]
    .includes(details.code)
    || SCHEMA_ERROR_PATTERNS.some((pattern) => pattern.test(details.text));
}

export function deploymentSchemaOutdatedMessage(missing: string[] = []): string {
  const detail = missing.length > 0 ? `（缺少：${missing.join("、")}）` : "";
  return `数据库版本与应用不匹配${detail}，请执行 ${REQUIRED_SCHEMA_MIGRATION} 后刷新 Supabase Schema Cache`;
}

export class DeploymentSchemaOutdatedError extends Error {
  readonly code = "deployment_schema_outdated";

  constructor(public readonly missing: string[] = []) {
    super(deploymentSchemaOutdatedMessage(missing));
    this.name = "DeploymentSchemaOutdatedError";
  }
}

export function assertRequiredSchemaCapabilities(value: unknown): SchemaCapabilities {
  const parsed = SchemaCapabilitiesSchema.parse(value);
  const unavailable = Object.entries(parsed.capabilities)
    .filter(([, available]) => !available)
    .map(([capability]) => capability);
  const missing = [...new Set(parsed.missing.length > 0 ? parsed.missing : unavailable)];
  if (parsed.schemaVersion !== REQUIRED_SCHEMA_VERSION || missing.length > 0) {
    throw new DeploymentSchemaOutdatedError(missing);
  }
  return parsed;
}
