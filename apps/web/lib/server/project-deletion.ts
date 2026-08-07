import {
  DeploymentSchemaOutdatedError,
  isDeploymentSchemaError,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { ApiError } from "./http";
import { invalidateProjectFileCacheForOwner } from "./project-files";
import { getSupabaseAdmin } from "./supabase";

export type DeletableProject = {
  projectId: Hex;
  projectKind: "UPLOAD" | "PACK";
  sourceStorageBucket: string | null;
  sourceStoragePath: string | null;
};

export interface ProjectDeletionStore {
  loadOwned(projectId: Hex, owner: `0x${string}`): Promise<DeletableProject | null>;
  removeSourceFile(bucket: string, path: string): Promise<void>;
  deleteOwned(projectId: Hex, owner: `0x${string}`): Promise<boolean>;
}

function projectNotFound(): ApiError {
  return new ApiError(404, "project_not_found", "Learning Project was not found");
}

function createSupabaseProjectDeletionStore(): ProjectDeletionStore {
  const client = getSupabaseAdmin();
  return {
    async loadOwned(projectId, owner) {
      const { data, error } = await client.from("learning_projects")
        .select("project_id,project_kind,source_storage_bucket,source_storage_path")
        .eq("project_id", projectId)
        .eq("owner_address", owner)
        .maybeSingle();
      if (error && isDeploymentSchemaError(error)) {
        throw new DeploymentSchemaOutdatedError(["originalPdfStorage"]);
      }
      if (error) throw new Error(`Could not load Project for deletion: ${error.message}`);
      if (!data) return null;
      return {
        projectId: data.project_id as Hex,
        projectKind: data.project_kind as "UPLOAD" | "PACK",
        sourceStorageBucket: data.source_storage_bucket as string | null,
        sourceStoragePath: data.source_storage_path as string | null,
      };
    },

    async removeSourceFile(bucket, path) {
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error) throw new Error(`Could not delete source PDF: ${error.message}`);
    },

    async deleteOwned(projectId, owner) {
      const { data, error } = await client.from("learning_projects")
        .delete()
        .eq("project_id", projectId)
        .eq("owner_address", owner)
        .select("project_id")
        .maybeSingle();
      if (error) throw new Error(`Could not delete Learning Project: ${error.message}`);
      return Boolean(data);
    },
  };
}

export async function deleteProjectForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectDeletionStore = createSupabaseProjectDeletionStore(),
): Promise<void> {
  const project = await store.loadOwned(projectId, owner);
  if (!project) throw projectNotFound();

  if (
    project.projectKind === "UPLOAD"
    && project.sourceStorageBucket
    && project.sourceStoragePath
  ) {
    await store.removeSourceFile(project.sourceStorageBucket, project.sourceStoragePath);
  }

  if (!await store.deleteOwned(projectId, owner)) throw projectNotFound();
  invalidateProjectFileCacheForOwner(projectId, owner);
}
