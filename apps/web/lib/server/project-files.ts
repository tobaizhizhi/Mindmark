import { createHash } from "node:crypto";
import {
  Bytes32Schema,
  DeploymentSchemaOutdatedError,
  ProjectSourceFileResponseSchema,
  isDeploymentSchemaError,
  type ProjectSourceFileResponse,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

const SOURCE_FILE_BUCKET = "learning-source-files";
const MAX_SOURCE_FILE_BYTES = 15 * 1024 * 1024;

type UploadFile = {
  size: number;
  type: string;
  name?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type ProjectFileRow = {
  project_id: Hex;
  project_kind: "UPLOAD" | "PACK";
  source_filename: string | null;
  source_storage_bucket: string | null;
  source_storage_path: string | null;
  source_file_sha256: string | null;
  source_file_size: number | null;
  source_file_status: "MISSING" | "UPLOADING" | "READY" | "FAILED";
};

const PROJECT_FILE_CACHE_TTL_MS = 5 * 60_000;
const PROJECT_FILE_CACHE_LIMIT = 128;
type ProjectFileCacheEntry = { expiresAt: number; project: ProjectFileRow };
type SignedFileCacheEntry = { expiresAt: number; response: ProjectSourceFileResponse };
const projectFileCache = new Map<string, ProjectFileCacheEntry>();
const signedFileCache = new Map<string, SignedFileCacheEntry>();

function projectFileCacheKey(projectId: Hex, owner: `0x${string}`): string {
  return `${owner}:${projectId}`;
}

function trimProjectFileCaches(): void {
  if (projectFileCache.size >= PROJECT_FILE_CACHE_LIMIT) {
    projectFileCache.delete(projectFileCache.keys().next().value as string);
  }
  if (signedFileCache.size >= PROJECT_FILE_CACHE_LIMIT) {
    signedFileCache.delete(signedFileCache.keys().next().value as string);
  }
}

export function primeProjectFileCache(
  owner: `0x${string}`,
  project: ProjectFileRow,
): void {
  trimProjectFileCaches();
  projectFileCache.set(projectFileCacheKey(project.project_id, owner), {
    expiresAt: Date.now() + PROJECT_FILE_CACHE_TTL_MS,
    project,
  });
}

export function invalidateProjectFileCacheForOwner(
  projectId: Hex,
  owner: `0x${string}`,
): void {
  const key = projectFileCacheKey(projectId, owner);
  projectFileCache.delete(key);
  signedFileCache.delete(key);
}

function assertPdfFile(file: UploadFile): void {
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_SOURCE_FILE_BYTES) {
    throw new ApiError(400, "invalid_source_file", "PDF 不能超过 15 MB");
  }
  if (file.type && file.type !== "application/pdf") {
    throw new ApiError(400, "invalid_source_file", "只支持 application/pdf 文件");
  }
}

async function loadProjectFile(projectId: Hex, owner: `0x${string}`): Promise<ProjectFileRow> {
  const key = projectFileCacheKey(projectId, owner);
  const cached = projectFileCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.project;
  if (cached) projectFileCache.delete(key);
  const { data, error } = await getSupabaseAdmin().from("learning_projects")
    .select("project_id,project_kind,source_filename,source_storage_bucket,source_storage_path,source_file_sha256,source_file_size,source_file_status")
    .eq("project_id", projectId)
    .eq("owner_address", owner)
    .maybeSingle();
  if (error && isDeploymentSchemaError(error)) throw new DeploymentSchemaOutdatedError(["originalPdfStorage"]);
  if (error) throw new Error(`Could not load Project source file: ${error.message}`);
  if (!data) throw new ApiError(404, "project_not_found", "Learning Project was not found");
  const project = data as ProjectFileRow;
  primeProjectFileCache(owner, project);
  return project;
}

function fileResponse(
  project: ProjectFileRow,
  input: Partial<Pick<ProjectSourceFileResponse, "url" | "expiresAt">> = {},
): ProjectSourceFileResponse {
  return ProjectSourceFileResponseSchema.parse({
    projectId: Bytes32Schema.parse(project.project_id),
    available: project.source_file_status === "READY" && Boolean(project.source_storage_path),
    status: project.source_file_status,
    url: input.url ?? null,
    filename: project.source_filename,
    fileSize: project.source_file_size === null ? null : Number(project.source_file_size),
    expiresAt: input.expiresAt ?? null,
  });
}

export async function uploadProjectSourceFileForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  file: UploadFile,
): Promise<ProjectSourceFileResponse> {
  assertPdfFile(file);
  const project = await loadProjectFile(projectId, owner);
  if (project.project_kind !== "UPLOAD") {
    throw new ApiError(400, "source_file_not_supported", "预置卡包不接受 PDF 文件");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = String.fromCharCode(...bytes.subarray(0, 5));
  if (signature !== "%PDF-") {
    throw new ApiError(400, "invalid_source_file", "所选文件不是有效的 PDF");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = `${owner.toLowerCase()}/${projectId.toLowerCase()}/source.pdf`;
  const client = getSupabaseAdmin();
  invalidateProjectFileCacheForOwner(projectId, owner);

  const pending = await client.from("learning_projects").update({
    source_file_status: "UPLOADING",
    source_storage_bucket: SOURCE_FILE_BUCKET,
    source_storage_path: path,
  }).eq("project_id", projectId).eq("owner_address", owner);
  if (pending.error) throw new Error(`Could not mark source file uploading: ${pending.error.message}`);

  const uploaded = await client.storage.from(SOURCE_FILE_BUCKET).upload(path, bytes, {
    contentType: "application/pdf",
    cacheControl: "3600",
    upsert: true,
  });
  if (uploaded.error) {
    await client.from("learning_projects").update({ source_file_status: "FAILED" })
      .eq("project_id", projectId).eq("owner_address", owner);
    invalidateProjectFileCacheForOwner(projectId, owner);
    throw new Error(`Could not upload source PDF: ${uploaded.error.message}`);
  }

  const updated = await client.from("learning_projects").update({
    source_file_sha256: sha256,
    source_file_size: bytes.byteLength,
    source_file_status: "READY",
    source_storage_bucket: SOURCE_FILE_BUCKET,
    source_storage_path: path,
  }).eq("project_id", projectId).eq("owner_address", owner)
    .select("project_id,project_kind,source_filename,source_storage_bucket,source_storage_path,source_file_sha256,source_file_size,source_file_status")
    .single();
  if (updated.error || !updated.data) {
    await client.storage.from(SOURCE_FILE_BUCKET).remove([path]);
    throw new Error(`Could not save source PDF metadata: ${updated.error?.message ?? "project disappeared"}`);
  }
  primeProjectFileCache(owner, updated.data as ProjectFileRow);
  return getProjectSourceFileForOwner(projectId, owner);
}

export async function getProjectSourceFileForOwner(
  projectId: Hex,
  owner: `0x${string}`,
): Promise<ProjectSourceFileResponse> {
  const key = projectFileCacheKey(projectId, owner);
  const signed = signedFileCache.get(key);
  if (signed && signed.expiresAt > Date.now() + 30_000) return signed.response;
  if (signed) signedFileCache.delete(key);
  const project = await loadProjectFile(projectId, owner);
  if (project.source_file_status !== "READY" || !project.source_storage_path) {
    return fileResponse(project);
  }
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data, error } = await getSupabaseAdmin().storage
    .from(project.source_storage_bucket ?? SOURCE_FILE_BUCKET)
    .createSignedUrl(project.source_storage_path, 10 * 60);
  if (error || !data?.signedUrl) {
    return fileResponse({ ...project, source_file_status: "FAILED" });
  }
  const response = fileResponse(project, { url: data.signedUrl, expiresAt });
  trimProjectFileCaches();
  signedFileCache.set(key, { expiresAt: Date.parse(expiresAt), response });
  return response;
}
