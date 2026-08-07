import type {
  OutlinePlanningOperation,
} from "@mindmark/shared/learning-project";
import type { SourceExclusionRange } from "@mindmark/shared/chapter";
import type { Hex } from "viem";

export type ProjectSummaryRow = {
  project_id: Hex;
  title: string;
  goal: string | null;
  status: string;
  project_kind?: "UPLOAD" | "PACK";
  pack_version_id?: string | null;
  registry_version: number;
  chapter_count: number | string;
  ready_chapter_count: number | string;
  card_count: number | string;
  due_count: number | string;
  updated_at: string;
};

export type ChapterSummaryRow = {
  project_id: Hex;
  chapter_id: number;
  position: number;
  title: string;
  summary: string;
  page_start: number | null;
  page_end: number | null;
  importance: number;
  status: string;
  card_count: number | string;
  studied_count: number | string;
  due_count: number | string;
  new_count: number | string;
  mastered_count: number | string;
  last_reviewed_at: string | null;
  progress_percent: number | string;
};

export type ProjectSourceRow = {
  project_id: Hex;
  owner_address: `0x${string}`;
  title: string;
  goal: string | null;
  source_hash: Hex;
  goal_hash: Hex;
  outline_version: number;
  outline_hash: Hex | null;
  status: string;
};

export type OutlineDraftInput = {
  projectId: Hex;
  owner: `0x${string}`;
  expectedHeadVersion: number | null;
  outlineHash: Hex;
  plannerVersion: string;
  chapters: Record<string, unknown>[];
  exclusions: Record<string, unknown>[];
};

export type DraftChapterRow = {
  chapter_id: number;
  position: number;
  title: string;
  summary: string;
  start_block: number;
  end_block: number;
  page_start: number;
  page_end: number;
  source_hash: Hex;
  importance: number;
  min_card_count: number;
  target_card_count: number;
  max_card_count: number;
};

export type ProjectSourceBlockRow = {
  block_index: number;
  page_number: number;
  kind: string;
  text: string;
  block_hash: Hex;
  heading_level: number | null;
};

export interface ProjectSourceStore {
  registerSource(project: Record<string, unknown>, sourceBlocks: Record<string, unknown>[]): Promise<Hex>;
}

export interface ProjectOutlineOperationStore {
  enqueue(projectId: Hex, owner: `0x${string}`): Promise<string>;
  get(projectId: Hex, owner: `0x${string}`, operationId?: string): Promise<OutlinePlanningOperation | null>;
}

export interface ProjectSummaryStore {
  listOwned(owner: `0x${string}`, now: string): Promise<ProjectSummaryRow[]>;
}

export interface ChapterSummaryStore {
  listOwned(owner: `0x${string}`, projectId: Hex, now: string): Promise<ChapterSummaryRow[]>;
}

export interface ProjectConfirmationStore {
  loadDraft(projectId: Hex, owner: `0x${string}`): Promise<{
    project: ProjectSourceRow;
    chapters: DraftChapterRow[];
    sourceBlocks: ProjectSourceBlockRow[];
    exclusions: SourceExclusionRange[];
  } | null>;
  saveDraft(input: OutlineDraftInput): Promise<number>;
  confirmOutlineDesign(input: {
    projectId: Hex;
    owner: `0x${string}`;
    outlineVersion: number;
    outlineHash: Hex;
    chapters: Record<string, unknown>[];
  }): Promise<void>;
}
