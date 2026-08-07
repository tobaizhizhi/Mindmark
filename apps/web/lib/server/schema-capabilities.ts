import {
  DeploymentSchemaOutdatedError,
  assertRequiredSchemaCapabilities,
  isDeploymentSchemaError,
  type SchemaCapabilities,
} from "@mindmark/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase";

let cachedCapabilities: SchemaCapabilities | null = null;

export async function loadSchemaCapabilities(
  client: Pick<SupabaseClient, "rpc">,
): Promise<SchemaCapabilities> {
  const { data, error } = await client.rpc("get_schema_capabilities_v1");
  if (error) {
    if (isDeploymentSchemaError(error)) throw new DeploymentSchemaOutdatedError();
    throw new Error(`Could not inspect database schema capabilities: ${error.message}`);
  }
  return assertRequiredSchemaCapabilities(data);
}

export async function assertWebSchemaCapabilities(): Promise<SchemaCapabilities> {
  if (cachedCapabilities) return cachedCapabilities;
  const capabilities = await loadSchemaCapabilities(getSupabaseAdmin());
  cachedCapabilities = capabilities;
  return capabilities;
}
