import {
  DeploymentSchemaOutdatedError,
  assertRequiredSchemaCapabilities,
  isDeploymentSchemaError,
  type SchemaCapabilities,
} from "@mindmark/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function assertRunnerSchemaCapabilities(
  client: Pick<SupabaseClient, "rpc">,
): Promise<SchemaCapabilities> {
  const { data, error } = await client.rpc("get_schema_capabilities_v1");
  if (error) {
    if (isDeploymentSchemaError(error)) throw new DeploymentSchemaOutdatedError();
    throw new Error(`Could not inspect database schema capabilities: ${error.message}`);
  }
  return assertRequiredSchemaCapabilities(data);
}
