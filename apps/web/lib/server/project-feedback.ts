import {
  KnowledgeCardFeedbackListResponseSchema,
  KnowledgeCardFeedbackSchema,
  type KnowledgeCardFeedback,
  type SubmitKnowledgeCardFeedbackRequest,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

type FeedbackRow = {
  feedback_id: string;
  project_id: Hex;
  chapter_id: number;
  card_id: Hex;
  rating: string;
  reason: string | null;
  corrected_content: unknown;
  created_at: string;
};

export interface KnowledgeCardFeedbackStore {
  ownsProject(projectId: Hex, owner: `0x${string}`): Promise<boolean>;
  ownsCard(input: { projectId: Hex; chapterId: number; cardId: Hex; owner: `0x${string}` }): Promise<boolean>;
  create(input: {
    projectId: Hex;
    chapterId: number;
    cardId: Hex;
    owner: `0x${string}`;
    rating: SubmitKnowledgeCardFeedbackRequest["rating"];
    reason: string | null;
    correctedContent: SubmitKnowledgeCardFeedbackRequest["correctedContent"] | null;
  }): Promise<FeedbackRow>;
  list(input: { projectId: Hex; owner: `0x${string}`; chapterId?: number; cardId?: Hex }): Promise<FeedbackRow[]>;
}

function feedbackFromRow(row: FeedbackRow): KnowledgeCardFeedback {
  return KnowledgeCardFeedbackSchema.parse({
    feedbackId: row.feedback_id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    cardId: row.card_id,
    rating: row.rating,
    reason: row.reason,
    correctedContent: row.corrected_content,
    createdAt: row.created_at,
  });
}

export class SupabaseKnowledgeCardFeedbackStore implements KnowledgeCardFeedbackStore {
  async ownsProject(projectId: Hex, owner: `0x${string}`): Promise<boolean> {
    const { data, error } = await getSupabaseAdmin().from("learning_projects")
      .select("project_id").eq("project_id", projectId).eq("owner_address", owner).maybeSingle();
    if (error) throw new Error(`Could not read Project owner: ${error.message}`);
    return Boolean(data);
  }

  async ownsCard(input: { projectId: Hex; chapterId: number; cardId: Hex; owner: `0x${string}` }): Promise<boolean> {
    if (!(await this.ownsProject(input.projectId, input.owner))) return false;
    const { data, error } = await getSupabaseAdmin().from("knowledge_cards")
      .select("card_id")
      .eq("project_id", input.projectId).eq("chapter_id", input.chapterId).eq("card_id", input.cardId)
      .maybeSingle();
    if (error) throw new Error(`Could not read Project card: ${error.message}`);
    return Boolean(data);
  }

  async create(input: {
    projectId: Hex;
    chapterId: number;
    cardId: Hex;
    owner: `0x${string}`;
    rating: SubmitKnowledgeCardFeedbackRequest["rating"];
    reason: string | null;
    correctedContent: SubmitKnowledgeCardFeedbackRequest["correctedContent"] | null;
  }): Promise<FeedbackRow> {
    const { data, error } = await getSupabaseAdmin().from("knowledge_card_feedback").insert({
      owner_address: input.owner,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      card_id: input.cardId,
      rating: input.rating,
      reason: input.reason,
      corrected_content: input.correctedContent,
    }).select("feedback_id,project_id,chapter_id,card_id,rating,reason,corrected_content,created_at").single();
    if (error) throw new Error(`Could not save card feedback: ${error.message}`);
    return data as FeedbackRow;
  }

  async list(input: { projectId: Hex; owner: `0x${string}`; chapterId?: number; cardId?: Hex }): Promise<FeedbackRow[]> {
    let query = getSupabaseAdmin().from("knowledge_card_feedback")
      .select("feedback_id,project_id,chapter_id,card_id,rating,reason,corrected_content,created_at")
      .eq("project_id", input.projectId).eq("owner_address", input.owner)
      .order("created_at", { ascending: false }).limit(100);
    if (input.chapterId !== undefined) query = query.eq("chapter_id", input.chapterId);
    if (input.cardId !== undefined) query = query.eq("card_id", input.cardId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not read card feedback: ${error.message}`);
    return (data ?? []) as FeedbackRow[];
  }
}

export async function submitKnowledgeCardFeedbackForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  feedback: SubmitKnowledgeCardFeedbackRequest,
  store: KnowledgeCardFeedbackStore = new SupabaseKnowledgeCardFeedbackStore(),
): Promise<KnowledgeCardFeedback> {
  if (!(await store.ownsCard({ projectId, owner, chapterId: feedback.chapterId, cardId: feedback.cardId }))) {
    throw new ApiError(404, "card_not_found", "Card is not part of this Learning Project");
  }
  return feedbackFromRow(await store.create({
    projectId,
    owner,
    chapterId: feedback.chapterId,
    cardId: feedback.cardId,
    rating: feedback.rating,
    reason: feedback.reason ?? null,
    correctedContent: feedback.correctedContent ?? null,
  }));
}

export async function listKnowledgeCardFeedbackForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  filters: { chapterId?: number; cardId?: Hex },
  store: KnowledgeCardFeedbackStore = new SupabaseKnowledgeCardFeedbackStore(),
) {
  if (!(await store.ownsProject(projectId, owner))) {
    throw new ApiError(404, "project_not_found", "Learning Project was not found");
  }
  return KnowledgeCardFeedbackListResponseSchema.parse({
    feedback: (await store.list({ projectId, owner, ...filters })).map(feedbackFromRow),
  });
}
