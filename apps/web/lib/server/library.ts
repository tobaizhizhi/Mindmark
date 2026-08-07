import {
  DocumentLibraryResponseSchema,
  FolderMutationResponseSchema,
  type CreateFolderRequest,
  type DocumentLibraryResponse,
  type FolderMutationResponse,
} from "@mindmark/shared";
import { z } from "zod";
import type { Hex } from "viem";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

export interface DocumentLibraryStore {
  load(owner: `0x${string}`, folderId: string | null, now: string): Promise<unknown>;
  createFolder(owner: `0x${string}`, name: string, parentFolderId: string | null): Promise<string>;
  renameFolder(owner: `0x${string}`, folderId: string, name: string): Promise<void>;
  moveProject(owner: `0x${string}`, projectId: Hex, folderId: string | null): Promise<void>;
  deleteFolder(owner: `0x${string}`, folderId: string): Promise<void>;
}

function storageError(action: string, message: string): never {
  if (/not found/iu.test(message)) throw new ApiError(404, "library_item_not_found", message);
  if (/not empty|duplicate|unique/iu.test(message)) throw new ApiError(409, "library_conflict", message);
  throw new Error(`${action}: ${message}`);
}

class SupabaseDocumentLibraryStore implements DocumentLibraryStore {
  async load(owner: `0x${string}`, folderId: string | null, now: string): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("get_document_library_v2", {
      p_owner: owner,
      p_folder_id: folderId,
      p_now: now,
    });
    if (error) storageError("Could not load document library", error.message);
    return data;
  }

  async createFolder(owner: `0x${string}`, name: string, parentFolderId: string | null): Promise<string> {
    const { data, error } = await getSupabaseAdmin().rpc("create_project_folder_v2", {
      p_owner: owner,
      p_name: name,
      p_parent_folder_id: parentFolderId,
    });
    if (error) storageError("Could not create folder", error.message);
    return z.string().uuid().parse(data);
  }

  async renameFolder(owner: `0x${string}`, folderId: string, name: string): Promise<void> {
    const { error } = await getSupabaseAdmin().rpc("rename_project_folder_v2", {
      p_owner: owner,
      p_folder_id: folderId,
      p_name: name,
    });
    if (error) storageError("Could not rename folder", error.message);
  }

  async moveProject(owner: `0x${string}`, projectId: Hex, folderId: string | null): Promise<void> {
    const { error } = await getSupabaseAdmin().rpc("move_learning_project_to_folder_v2", {
      p_owner: owner,
      p_project_id: projectId,
      p_folder_id: folderId,
    });
    if (error) storageError("Could not move Learning Project", error.message);
  }

  async deleteFolder(owner: `0x${string}`, folderId: string): Promise<void> {
    const { error } = await getSupabaseAdmin().rpc("delete_project_folder_v2", {
      p_owner: owner,
      p_folder_id: folderId,
    });
    if (error) storageError("Could not delete folder", error.message);
  }
}

export async function getDocumentLibraryForOwner(
  owner: `0x${string}`,
  folderId: string | null,
  store: DocumentLibraryStore = new SupabaseDocumentLibraryStore(),
  now = new Date(),
): Promise<DocumentLibraryResponse> {
  const data = await store.load(owner, folderId, now.toISOString());
  return DocumentLibraryResponseSchema.parse({
    ...(data as Record<string, unknown>),
    currentFolderId: folderId,
  });
}

export async function createFolderForOwner(
  owner: `0x${string}`,
  request: CreateFolderRequest,
  store: DocumentLibraryStore = new SupabaseDocumentLibraryStore(),
): Promise<FolderMutationResponse> {
  const name = request.name.trim();
  const parentFolderId = request.parentFolderId ?? null;
  const folderId = await store.createFolder(owner, name, parentFolderId);
  return FolderMutationResponseSchema.parse({ folderId, name, parentFolderId });
}

export async function renameFolderForOwner(
  owner: `0x${string}`,
  folderId: string,
  name: string,
  store: DocumentLibraryStore = new SupabaseDocumentLibraryStore(),
): Promise<void> {
  await store.renameFolder(owner, folderId, name.trim());
}

export async function moveProjectForOwner(
  owner: `0x${string}`,
  projectId: Hex,
  folderId: string | null,
  store: DocumentLibraryStore = new SupabaseDocumentLibraryStore(),
): Promise<void> {
  await store.moveProject(owner, projectId, folderId);
}

export async function deleteFolderForOwner(
  owner: `0x${string}`,
  folderId: string,
  store: DocumentLibraryStore = new SupabaseDocumentLibraryStore(),
): Promise<void> {
  await store.deleteFolder(owner, folderId);
}
