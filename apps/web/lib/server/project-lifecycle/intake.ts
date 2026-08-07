import { randomBytes } from "node:crypto";
import {
  ProjectSourceRegistrationResponseSchema,
  hashGoal,
  intakeSource,
  type ProjectIntakeRequest,
  type ProjectSourceRegistrationResponse,
} from "@mindmark/shared/learning-project";
import type { Hex } from "viem";
import { SupabaseProjectSourceStore } from "./supabase-adapter";
import type { ProjectSourceStore } from "./types";

function randomProjectId(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

export async function intakeProjectForOwner(
  request: ProjectIntakeRequest,
  owner: `0x${string}`,
  store: ProjectSourceStore = new SupabaseProjectSourceStore(),
  projectId: Hex = randomProjectId(),
): Promise<ProjectSourceRegistrationResponse> {
  const source = intakeSource(request.pages);
  const registeredProjectId = await store.registerSource(
    {
      project_id: projectId,
      owner_address: owner,
      client_request_id: request.clientRequestId,
      title: request.title.trim(),
      goal: request.goal?.trim() || null,
      source_hash: source.sourceHash,
      goal_hash: hashGoal(request.goal ?? ""),
      source_filename: request.sourceFilename ?? null,
      source_mime_type: request.sourceMimeType ?? null,
      folder_id: request.folderId ?? null,
      source_page_count: request.pages.length,
      source_character_count: source.blocks.reduce((sum, block) => sum + block.text.length, 0),
    },
    source.blocks.map((block) => ({
      block_index: block.blockIndex,
      page_number: block.pageNumber,
      kind: block.kind,
      text: block.text,
      block_hash: block.blockHash,
      heading_level: block.headingLevel,
    })),
  );
  return ProjectSourceRegistrationResponseSchema.parse({
    projectId: registeredProjectId,
    status: "UPLOADED",
    sourceHash: source.sourceHash,
    sourcePageCount: request.pages.length,
    sourceCharacterCount: source.blocks.reduce((sum, block) => sum + block.text.length, 0),
  });
}
