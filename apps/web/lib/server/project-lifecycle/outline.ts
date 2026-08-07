import {
  ChapterProposalListSchema,
  SourceBlockSchema,
  filterExcludedSourceBlocks,
  materializeChapterOutline,
  planChapterCardPolicy,
  type ChapterOutlineItem,
  type ChapterProposal,
  type SourceBlock,
  type SourceExclusionRange,
} from "@mindmark/shared/chapter";
import {
  ProjectDesignAcceptedResponseSchema,
  type OutlinePlanningOperation,
} from "@mindmark/shared/learning-project";
import type { Hex } from "viem";
import { ApiError } from "../http";
import {
  SupabaseProjectConfirmationStore,
  SupabaseProjectOutlineOperationStore,
} from "./supabase-adapter";
import type {
  ProjectConfirmationStore,
  ProjectOutlineOperationStore,
  ProjectSourceBlockRow,
} from "./types";

function sourceBlocksFromRows(rows: ProjectSourceBlockRow[]) {
  return SourceBlockSchema.array().parse(rows.map((block) => ({
    blockIndex: block.block_index,
    pageNumber: block.page_number,
    kind: block.kind,
    text: block.text,
    blockHash: block.block_hash,
    headingLevel: block.heading_level,
  })));
}

function outlineChapterRows(
  chapters: ChapterOutlineItem[],
  sourceBlocks: SourceBlock[],
  exclusions: SourceExclusionRange[] = [],
) {
  return chapters.map((chapter) => {
    const policy = planChapterCardPolicy(
      chapter,
      filterExcludedSourceBlocks(sourceBlocks.slice(chapter.startBlock, chapter.endBlock + 1), exclusions),
    );
    return {
      item_id: `chapter-${chapter.chapterId}`,
      chapter_id: chapter.chapterId,
      position: chapter.position,
      title: chapter.title,
      summary: chapter.summary,
      start_block: chapter.startBlock,
      end_block: chapter.endBlock,
      page_start: chapter.pageStart,
      page_end: chapter.pageEnd,
      source_hash: chapter.sourceHash,
      importance: chapter.importance,
      min_card_count: policy.minCardCount,
      target_card_count: policy.targetCardCount,
      max_card_count: policy.maxCardCount,
      card_policy_version: policy.policyVersion,
    };
  });
}

export async function requestProjectOutlinePlanningForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectOutlineOperationStore = new SupabaseProjectOutlineOperationStore(),
): Promise<OutlinePlanningOperation> {
  const operationId = await store.enqueue(projectId, owner);
  const operation = await store.get(projectId, owner, operationId);
  if (!operation) throw new ApiError(404, "project_source_not_found", "Editable Learning Project source was not found");
  return operation;
}

export async function getProjectOutlinePlanningOperationForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  operationId?: string,
  store: ProjectOutlineOperationStore = new SupabaseProjectOutlineOperationStore(),
): Promise<OutlinePlanningOperation> {
  const operation = await store.get(projectId, owner, operationId);
  if (!operation) throw new ApiError(404, "outline_operation_not_found", "Project Outline planning operation was not found");
  return operation;
}

export async function confirmProjectOutlineForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  rawProposals: ChapterProposal[],
  store: ProjectConfirmationStore = new SupabaseProjectConfirmationStore(),
) {
  const proposals = ChapterProposalListSchema.parse(rawProposals);
  const draft = await store.loadDraft(projectId, owner);
  if (!draft || draft.project.status !== "OUTLINE_READY") {
    throw new ApiError(404, "outline_not_found", "Editable Project outline was not found");
  }
  const sourceBlocks = sourceBlocksFromRows(draft.sourceBlocks);
  let outline;
  try {
    outline = materializeChapterOutline(
      projectId,
      sourceBlocks,
      proposals,
      draft.project.outline_version,
      draft.exclusions,
    );
    if (outline.outlineHash !== draft.project.outline_hash) {
      outline = materializeChapterOutline(
        projectId,
        sourceBlocks,
        proposals,
        draft.project.outline_version + 1,
        draft.exclusions,
      );
      const savedVersion = await store.saveDraft({
        projectId,
        owner,
        expectedHeadVersion: draft.project.outline_version,
        outlineHash: outline.outlineHash,
        plannerVersion: "learner-edited-v1",
        chapters: outlineChapterRows(outline.chapters, sourceBlocks, draft.exclusions),
        exclusions: draft.exclusions.map((range) => ({
          start_block: range.startBlock,
          end_block: range.endBlock,
          category: range.category,
          reason: range.reason,
        })),
      });
      if (savedVersion !== outline.outlineVersion) {
        throw new Error("Saved Outline Draft version does not match the edited outline");
      }
    }
  } catch (error) {
    throw new ApiError(400, "invalid_outline", error instanceof Error ? error.message : "Chapter outline is invalid");
  }
  await store.confirmOutlineDesign({
    projectId,
    owner,
    outlineVersion: outline.outlineVersion,
    outlineHash: outline.outlineHash,
    chapters: outlineChapterRows(outline.chapters, sourceBlocks, draft.exclusions),
  });
  return ProjectDesignAcceptedResponseSchema.parse({
    projectId,
    status: "DESIGNING_CARDS",
    outlineVersion: outline.outlineVersion,
    outlineHash: outline.outlineHash,
    chapterCount: outline.chapters.length,
  });
}
