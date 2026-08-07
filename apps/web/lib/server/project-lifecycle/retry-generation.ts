import type { Hex } from "viem";
import { ApiError } from "../http";
import { getSupabaseAdmin } from "../supabase";

export interface ProjectGenerationRetryStore {
  retry(projectId: Hex, owner: `0x${string}`): Promise<{
    jobCount: number | null;
    error: { message: string } | null;
  }>;
}

class SupabaseProjectGenerationRetryStore implements ProjectGenerationRetryStore {
  async retry(projectId: Hex, owner: `0x${string}`) {
    const { data, error } = await getSupabaseAdmin().rpc(
      "retry_failed_project_generation_v2",
      { p_project_id: projectId, p_owner: owner },
    );
    return { jobCount: data === null ? null : Number(data), error };
  }
}

export async function retryProjectGenerationForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectGenerationRetryStore = new SupabaseProjectGenerationRetryStore(),
): Promise<{ queuedJobs: number }> {
  const result = await store.retry(projectId, owner);
  if (result.error) {
    if (/not found/iu.test(result.error.message)) {
      throw new ApiError(404, "project_not_found", "Learning Project was not found");
    }
    if (/already has active work/iu.test(result.error.message)) {
      throw new ApiError(409, "generation_retry_in_progress", "知识卡生成已经在继续处理");
    }
    if (/not in retryable|no failed generation work/iu.test(result.error.message)) {
      throw new ApiError(409, "generation_not_retryable", "当前项目没有可恢复的生成任务");
    }
    throw new Error(`Could not retry Learning Project generation: ${result.error.message}`);
  }
  const queuedJobs = result.jobCount ?? 0;
  if (queuedJobs < 1) {
    throw new ApiError(409, "generation_not_retryable", "当前项目没有可恢复的生成任务");
  }
  return { queuedJobs };
}
