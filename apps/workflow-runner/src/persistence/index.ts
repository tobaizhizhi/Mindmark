import { createClient } from "@supabase/supabase-js";
import { SupabaseCommitmentRepositoryV2 } from "./commitment-repository.js";
import { SupabaseDesignRepositoryV3 } from "./design-repository.js";
import { SupabaseGenerationRepositoryV2 } from "./generation-repository.js";
import { SupabaseRewardRepositoryV2 } from "./reward-repository.js";
import { SupabaseWorkflowRepositoryV2 } from "./workflow-repository.js";
import { assertRunnerSchemaCapabilities } from "./schema-capabilities.js";

export function connectRunnerPersistence(
  url: string,
  serviceRoleKey: string,
) {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    assertSchemaCapabilities: () => assertRunnerSchemaCapabilities(client),
    workflow: new SupabaseWorkflowRepositoryV2(client),
    design: new SupabaseDesignRepositoryV3(client),
    generation: new SupabaseGenerationRepositoryV2(client),
    commitment: new SupabaseCommitmentRepositoryV2(client),
    reward: new SupabaseRewardRepositoryV2(client),
  };
}
