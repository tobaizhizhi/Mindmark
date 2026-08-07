import {
  CardPackCatalogResponseSchema,
  InstallCardPackResponseSchema,
  PublishedCardPackSchema,
  type CardPackCatalogResponse,
  type InstallCardPackRequest,
  type InstallCardPackResponse,
  type PublishedCardPack,
} from "@mindmark/shared";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

export interface CardPackStore {
  listPublished(owner: `0x${string}` | null): Promise<unknown>;
  getPublished(packVersionId: string, owner: `0x${string}` | null): Promise<unknown | null>;
  install(owner: `0x${string}`, packVersionId: string, folderId: string | null): Promise<unknown>;
  deleteInstallation(owner: `0x${string}`, installationId: string): Promise<void>;
}

function packStorageError(action: string, message: string): never {
  if (/not available/iu.test(message)) {
    throw new ApiError(404, "pack_not_found", "Card Pack Version was not found or is no longer available");
  }
  if (/destination folder/iu.test(message)) {
    throw new ApiError(404, "folder_not_found", "Destination folder was not found");
  }
  throw new Error(`${action}: ${message}`);
}

class SupabaseCardPackStore implements CardPackStore {
  async listPublished(owner: `0x${string}` | null): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("list_published_card_packs_v1", {
      p_owner: owner,
    });
    if (error) packStorageError("Could not list Card Packs", error.message);
    return data;
  }

  async getPublished(packVersionId: string, owner: `0x${string}` | null): Promise<unknown | null> {
    const { data, error } = await getSupabaseAdmin().rpc("get_published_card_pack_v1", {
      p_pack_version_id: packVersionId,
      p_owner: owner,
    });
    if (error) packStorageError("Could not load Card Pack", error.message);
    return data;
  }

  async install(owner: `0x${string}`, packVersionId: string, folderId: string | null): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("install_card_pack_v1", {
      p_owner: owner,
      p_pack_version_id: packVersionId,
      p_folder_id: folderId,
    });
    if (error) packStorageError("Could not install Card Pack", error.message);
    return data;
  }

  async deleteInstallation(owner: `0x${string}`, installationId: string): Promise<void> {
    const { error } = await getSupabaseAdmin().rpc("delete_card_pack_installation_v1", {
      p_owner: owner,
      p_installation_id: installationId,
    });
    if (error) packStorageError("Could not delete Card Pack installation", error.message);
  }
}

export async function listInstalledCardPacks(
  owner: `0x${string}`,
  store: CardPackStore = new SupabaseCardPackStore(),
): Promise<CardPackCatalogResponse> {
  const catalog = await listPublishedCardPacks(owner, store);
  return { packs: catalog.packs.filter((pack) => pack.installedProjectId !== null) };
}

export async function listPublishedCardPacks(
  owner: `0x${string}` | null,
  store: CardPackStore = new SupabaseCardPackStore(),
): Promise<CardPackCatalogResponse> {
  return CardPackCatalogResponseSchema.parse(await store.listPublished(owner));
}

export async function getPublishedCardPack(
  packVersionId: string,
  owner: `0x${string}` | null,
  store: CardPackStore = new SupabaseCardPackStore(),
): Promise<PublishedCardPack> {
  const data = await store.getPublished(packVersionId, owner);
  if (!data) throw new ApiError(404, "pack_not_found", "Card Pack Version was not found");
  return PublishedCardPackSchema.parse(data);
}

export async function installCardPackForOwner(
  owner: `0x${string}`,
  packVersionId: string,
  request: InstallCardPackRequest,
  store: CardPackStore = new SupabaseCardPackStore(),
): Promise<InstallCardPackResponse> {
  return InstallCardPackResponseSchema.parse(
    await store.install(owner, packVersionId, request.folderId ?? null),
  );
}

export async function deleteCardPackInstallationForOwner(
  owner: `0x${string}`,
  installationId: string,
  store: CardPackStore = new SupabaseCardPackStore(),
): Promise<void> {
  await store.deleteInstallation(owner, installationId);
}
