import {
  Bytes32Schema,
  ChapterStatusSchema,
  ChapterStudyResponseSchema,
  CompleteProjectSessionResponseSchema,
  KnowledgeCardContentSchema,
  ProjectStatusSchema,
  ProjectStudyResponseSchema,
  SubmitReviewResponseSchema,
  type ChapterStudyResponse,
  type CompleteProjectSessionResponse,
  type ProjectStudyResponse,
  type SubmitReviewRequest,
  type SubmitReviewResponse,
} from "@mindmark/shared";
import { z } from "zod";
import type { Hex } from "viem";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import { parseFsrsStateMap, scheduleReview, type SerializedFsrsCard } from "./fsrs";

const ChapterRowSchema = z.object({
  project_id: Bytes32Schema,
  chapter_id: z.number().int(),
  status: ChapterStatusSchema,
});

const CardRowSchema = z.object({
  card_id: Bytes32Schema,
  position: z.number().int(),
  content: z.unknown(),
});

const ProjectRowSchema = z.object({
  project_id: Bytes32Schema,
  status: ProjectStatusSchema,
});

const ProjectChapterRowSchema = ChapterRowSchema.extend({
  position: z.number().int(),
  title: z.string().min(1),
});

const ProjectCardRowSchema = CardRowSchema.extend({
  chapter_id: z.number().int(),
});

const StateRowSchema = z.object({
  card_id: Bytes32Schema,
  fsrs_state: z.unknown(),
  due_at: z.string().nullable(),
  reps: z.number().int(),
  lapses: z.number().int(),
});

type ChapterRow = z.infer<typeof ChapterRowSchema>;
type CardRow = z.infer<typeof CardRowSchema>;
type StateRow = z.infer<typeof StateRowSchema>;

export interface ProjectQueueStore {
  loadOwnedProject(
    projectId: Hex,
    owner: `0x${string}`,
  ): Promise<{
    project: z.infer<typeof ProjectRowSchema>;
    chapters: z.infer<typeof ProjectChapterRowSchema>[];
    cards: z.infer<typeof ProjectCardRowSchema>[];
    states: StateRow[];
  } | null>;
}

export interface ProjectStudyStore {
  loadOwnedChapter(
    projectId: Hex,
    chapterId: number,
    owner: `0x${string}`,
  ): Promise<{ chapter: ChapterRow; cards: CardRow[]; states: StateRow[] } | null>;
  submitReview(input: {
    projectId: Hex;
    chapterId: number;
    owner: `0x${string}`;
    review: SubmitReviewRequest;
    expectedState: SerializedFsrsCard | null;
    nextState: SerializedFsrsCard;
  }): Promise<unknown>;
  completeSession(owner: `0x${string}`, sessionId: string): Promise<unknown>;
}

export class SupabaseProjectStudyStore implements ProjectStudyStore, ProjectQueueStore {
  async loadOwnedChapter(projectId: Hex, chapterId: number, owner: `0x${string}`) {
    const client = getSupabaseAdmin();
    const projectResult = await client.from("learning_projects")
      .select("project_id").eq("project_id", projectId).eq("owner_address", owner).maybeSingle();
    if (projectResult.error) throw new Error(`Could not read Project owner: ${projectResult.error.message}`);
    if (!projectResult.data) return null;
    const [chapterResult, cardsResult, statesResult] = await Promise.all([
      client.from("chapters").select("project_id,chapter_id,status")
        .eq("project_id", projectId).eq("chapter_id", chapterId).maybeSingle(),
      client.from("knowledge_cards").select("card_id,position,content")
        .eq("project_id", projectId).eq("chapter_id", chapterId).order("position"),
      client.from("card_learning_states").select("card_id,fsrs_state,due_at,reps,lapses")
        .eq("owner_address", owner).eq("project_id", projectId).eq("chapter_id", chapterId),
    ]);
    const error = chapterResult.error ?? cardsResult.error ?? statesResult.error;
    if (error) throw new Error(`Could not read Chapter study data: ${error.message}`);
    if (!chapterResult.data) return null;
    return {
      chapter: ChapterRowSchema.parse(chapterResult.data),
      cards: CardRowSchema.array().parse(cardsResult.data ?? []),
      states: StateRowSchema.array().parse(statesResult.data ?? []),
    };
  }

  async submitReview(input: {
    projectId: Hex;
    chapterId: number;
    owner: `0x${string}`;
    review: SubmitReviewRequest;
    expectedState: SerializedFsrsCard | null;
    nextState: SerializedFsrsCard;
  }): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("submit_scoped_project_review_v2", {
      p_project_id: input.projectId,
      p_chapter_id: input.chapterId,
      p_owner: input.owner,
      p_session_id: input.review.sessionId,
      p_card_id: input.review.cardId,
      p_rating: input.review.rating,
      p_response_ms: input.review.responseMs,
      p_reviewed_at: input.review.reviewedAt,
      p_expected_state: input.expectedState,
      p_next_state: input.nextState,
      p_scope_type: input.review.scope ?? "CHAPTER",
    });
    if (error) throw new Error(error.message);
    return data;
  }

  async completeSession(owner: `0x${string}`, sessionId: string): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("complete_project_review_session_v2", {
      p_owner: owner,
      p_session_id: sessionId,
    });
    if (error) throw new Error(error.message);
    return data;
  }

  async loadOwnedProject(projectId: Hex, owner: `0x${string}`) {
    const client = getSupabaseAdmin();
    const [projectResult, chaptersResult, cardsResult, statesResult] = await Promise.all([
      client.from("learning_projects").select("project_id,status")
        .eq("project_id", projectId).eq("owner_address", owner).maybeSingle(),
      client.from("chapters").select("project_id,chapter_id,position,title,status")
        .eq("project_id", projectId).eq("status", "READY").order("position"),
      client.from("knowledge_cards").select("card_id,chapter_id,position,content")
        .eq("project_id", projectId).order("position"),
      client.from("card_learning_states").select("card_id,fsrs_state,due_at,reps,lapses")
        .eq("owner_address", owner).eq("project_id", projectId),
    ]);
    const error = projectResult.error ?? chaptersResult.error ?? cardsResult.error ?? statesResult.error;
    if (error) throw new Error(`Could not read Project study data: ${error.message}`);
    if (!projectResult.data) return null;
    return {
      project: ProjectRowSchema.parse(projectResult.data),
      chapters: ProjectChapterRowSchema.array().parse(chaptersResult.data ?? []),
      cards: ProjectCardRowSchema.array().parse(cardsResult.data ?? []),
      states: StateRowSchema.array().parse(statesResult.data ?? []),
    };
  }
}

function stateMap(rows: StateRow[]): Map<Hex, { state: SerializedFsrsCard; dueAt: string | null; reps: number; lapses: number }> {
  return new Map(rows.map((row) => {
    const parsed = parseFsrsStateMap({ [row.card_id]: row.fsrs_state })[row.card_id]!;
    return [row.card_id, { state: parsed, dueAt: row.due_at, reps: row.reps, lapses: row.lapses }];
  }));
}

function studyCard(row: CardRow, states: ReturnType<typeof stateMap>, now: Date) {
  const learning = states.get(row.card_id);
  const due = learning?.dueAt ? Date.parse(learning.dueAt) <= now.getTime() : false;
  return {
    ...KnowledgeCardContentSchema.parse(row.content),
    id: row.card_id,
    position: row.position,
    state: !learning || learning.reps === 0 ? "NEW" as const
      : due ? "DUE" as const
        : learning.reps < 3 ? "LEARNING" as const : "SCHEDULED" as const,
    dueAt: learning?.dueAt ?? null,
    reps: learning?.reps ?? 0,
    lapses: learning?.lapses ?? 0,
  };
}

export async function getChapterStudyForOwner(
  projectId: Hex,
  chapterId: number,
  owner: `0x${string}`,
  store: ProjectStudyStore = new SupabaseProjectStudyStore(),
  now = new Date(),
): Promise<ChapterStudyResponse> {
  const loaded = await store.loadOwnedChapter(projectId, chapterId, owner);
  if (!loaded) throw new ApiError(404, "chapter_not_found", "Chapter was not found");
  const states = stateMap(loaded.states);
  const cards = loaded.cards.map((row) => studyCard(row, states, now));
  const due = cards.filter((card) => card.state === "DUE")
    .sort((left, right) => Date.parse(left.dueAt!) - Date.parse(right.dueAt!) || right.importance - left.importance);
  const fresh = cards.filter((card) => card.state === "NEW")
    .sort((left, right) => right.importance - left.importance || left.position - right.position);
  const remainingCapacity = Math.max(0, 15 - due.length);
  const queue = [...due, ...fresh.slice(0, Math.min(8, remainingCapacity))].slice(0, 15);
  return ChapterStudyResponseSchema.parse({
    projectId,
    chapterId,
    status: loaded.chapter.status,
    cards,
    queue: loaded.chapter.status === "READY" ? queue.map((card) => card.id) : [],
    dueCount: due.length,
    newCount: fresh.length,
  });
}

export async function getProjectStudyForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectQueueStore = new SupabaseProjectStudyStore(),
  now = new Date(),
): Promise<ProjectStudyResponse> {
  const loaded = await store.loadOwnedProject(projectId, owner);
  if (!loaded) throw new ApiError(404, "project_not_found", "Project was not found");
  const states = stateMap(loaded.states);
  const chapterById = new Map(loaded.chapters.map((chapter) => [chapter.chapter_id, chapter]));
  const cards = loaded.cards.flatMap((row) => {
    const chapter = chapterById.get(row.chapter_id);
    if (!chapter) return [];
    return [{
      ...studyCard(row, states, now),
      chapterId: chapter.chapter_id,
      chapterPosition: chapter.position,
      chapterTitle: chapter.title,
    }];
  });
  const due = cards.filter((card) => card.state === "DUE")
    .sort((left, right) =>
      Date.parse(left.dueAt!) - Date.parse(right.dueAt!)
      || right.importance - left.importance
      || left.chapterPosition - right.chapterPosition
      || left.position - right.position);
  const freshByChapter = loaded.chapters.map((chapter) => cards
    .filter((card) => card.chapterId === chapter.chapter_id && card.state === "NEW")
    .sort((left, right) => right.importance - left.importance || left.position - right.position));
  const fresh: typeof cards = [];
  for (let offset = 0; fresh.length < 8; offset += 1) {
    let added = false;
    for (const chapterCards of freshByChapter) {
      const card = chapterCards[offset];
      if (!card) continue;
      fresh.push(card);
      added = true;
      if (fresh.length === 8) break;
    }
    if (!added) break;
  }
  const remainingCapacity = Math.max(0, 15 - due.length);
  const queue = [...due, ...fresh.slice(0, remainingCapacity)].slice(0, 15);
  return ProjectStudyResponseSchema.parse({
    projectId,
    status: loaded.project.status,
    readyChapterCount: loaded.chapters.length,
    queue,
    dueCount: due.length,
    newCount: cards.filter((card) => card.state === "NEW").length,
  });
}

export async function submitChapterReviewForOwner(
  projectId: Hex,
  chapterId: number,
  owner: `0x${string}`,
  review: SubmitReviewRequest,
  store: ProjectStudyStore = new SupabaseProjectStudyStore(),
): Promise<SubmitReviewResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = await store.loadOwnedChapter(projectId, chapterId, owner);
    if (!loaded) throw new ApiError(404, "chapter_not_found", "Chapter was not found");
    if (loaded.chapter.status !== "READY") {
      throw new ApiError(409, "chapter_not_ready", "Chapter is not ready for review");
    }
    if (!loaded.cards.some((card) => card.card_id === review.cardId)) {
      throw new ApiError(404, "card_not_found", "Card is not part of this Chapter");
    }
    const row = loaded.states.find((state) => state.card_id === review.cardId);
    const current = row ? parseFsrsStateMap({ [review.cardId]: row.fsrs_state })[review.cardId]! : null;
    const next = scheduleReview({ currentState: current, rating: review.rating, reviewedAt: review.reviewedAt });
    try {
      return SubmitReviewResponseSchema.parse(await store.submitReview({
        projectId, chapterId, owner, review, expectedState: current, nextState: next,
      }));
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message.includes("changed concurrently")) continue;
      throw error;
    }
  }
  throw new ApiError(409, "review_conflict", "Card state changed while reviewing");
}

export async function completeChapterSessionForOwner(
  owner: `0x${string}`,
  sessionId: string,
  store: ProjectStudyStore = new SupabaseProjectStudyStore(),
): Promise<CompleteProjectSessionResponse> {
  return CompleteProjectSessionResponseSchema.parse(await store.completeSession(owner, sessionId));
}
