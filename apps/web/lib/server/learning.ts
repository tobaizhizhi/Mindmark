import {
  type CompleteSessionResponse,
  type JourneyDetailResponse,
  type SubmitReviewRequest,
  type SubmitReviewResponse,
} from "@mindmark/shared";
import {
  Bytes32Schema,
  CardProvenanceSchema,
  ChunkProgressSchema,
  CommittedKnowledgeCardSchema,
  CompleteSessionResponseSchema,
  JourneyDetailResponseSchema,
  JourneyStatusSchema,
  ReviewPlanSchema,
  SessionSummarySchema,
  SubmitReviewResponseSchema,
} from "@mindmark/shared/schemas";
import type { Hex } from "viem";
import { z } from "zod";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import {
  buildAdaptivePlan,
  buildStudyQueue,
  dueForecast,
  parseFsrsStateMap,
  scheduleReview,
} from "./study";

const JourneyRowSchema = z.object({
  journey_id: Bytes32Schema,
  status: JourneyStatusSchema,
  source_hash: Bytes32Schema,
  chunk_manifest_root: Bytes32Schema,
  create_tx_hash: Bytes32Schema.nullable(),
  finalize_tx_hash: Bytes32Schema.nullable(),
  deck_root: Bytes32Schema.nullable(),
  plan_hash: Bytes32Schema.nullable(),
  plan_version: z.number().int().positive(),
  deck: z.unknown().nullable(),
  card_provenance: z.unknown().nullable(),
  plan: z.unknown().nullable(),
  fsrs_states: z.unknown(),
});

const ChunkRowSchema = z.object({
  chunk_id: z.number().int(),
  page_start: z.number().int(),
  page_end: z.number().int(),
  title: z.string(),
  source_chunk_hash: Bytes32Schema,
  cards_root: Bytes32Schema.nullable(),
  worker_address: z.string().nullable(),
  status: z.string(),
  card_count: z.number().int().nullable(),
  commit_tx_hash: z.string().nullable(),
  confirmed_block: z.union([z.string(), z.number()]).nullable(),
  gas_used: z.union([z.string(), z.number()]).nullable(),
  generation_ms: z.number().int().nullable(),
  confirmation_ms: z.number().int().nullable(),
});

const ReviewRowSchema = z.object({
  card_id: Bytes32Schema,
  rating: z.enum(["again", "hard", "good", "easy"]),
  response_ms: z.number().int().nonnegative(),
  reviewed_at: z.string(),
});

export type LearningJourneyRow = z.infer<typeof JourneyRowSchema>;
type ChunkRow = z.infer<typeof ChunkRowSchema>;
type ReviewRow = z.infer<typeof ReviewRowSchema>;

export interface LearningStore {
  findOwnedJourney(journeyId: Hex, owner: `0x${string}`): Promise<LearningJourneyRow | null>;
  findChunks(journeyId: Hex): Promise<ChunkRow[]>;
  submitReview(input: {
    journeyId: Hex;
    owner: `0x${string}`;
    review: SubmitReviewRequest;
    expectedState: unknown;
    nextState: unknown;
  }): Promise<unknown>;
  findSessionReviews(journeyId: Hex, sessionId: string): Promise<ReviewRow[]>;
  findRecentWeakTags(journeyId: Hex): Promise<string[][]>;
  countSessions(journeyId: Hex): Promise<number>;
  completeSession(input: {
    journeyId: Hex;
    owner: `0x${string}`;
    sessionId: string;
    summary: Record<string, unknown>;
    plan: unknown | null;
    expectedPlanVersion: number;
  }): Promise<unknown>;
}

export class SupabaseLearningStore implements LearningStore {
  async findOwnedJourney(
    journeyId: Hex,
    owner: `0x${string}`,
  ): Promise<LearningJourneyRow | null> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_journeys")
      .select(
        "journey_id,status,source_hash,chunk_manifest_root,create_tx_hash,finalize_tx_hash,deck_root,plan_hash,plan_version,deck,card_provenance,plan,fsrs_states",
      )
      .eq("journey_id", journeyId)
      .eq("learner_address", owner)
      .maybeSingle();
    if (error) throw new Error(`Could not read learning project: ${error.message}`);
    return data ? JourneyRowSchema.parse(data) : null;
  }

  async findChunks(journeyId: Hex): Promise<ChunkRow[]> {
    const { data, error } = await getSupabaseAdmin()
      .from("source_chunks")
      .select(
        "chunk_id,page_start,page_end,title,source_chunk_hash,cards_root,worker_address,status,card_count,commit_tx_hash,confirmed_block,gas_used,generation_ms,confirmation_ms",
      )
      .eq("journey_id", journeyId)
      .order("chunk_id");
    if (error) throw new Error(`Could not read chunk progress: ${error.message}`);
    return ChunkRowSchema.array().parse(data ?? []);
  }

  async submitReview(input: {
    journeyId: Hex;
    owner: `0x${string}`;
    review: SubmitReviewRequest;
    expectedState: unknown;
    nextState: unknown;
  }): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("submit_learning_review", {
      p_journey_id: input.journeyId,
      p_owner: input.owner,
      p_session_id: input.review.sessionId,
      p_card_id: input.review.cardId,
      p_rating: input.review.rating,
      p_response_ms: input.review.responseMs,
      p_reviewed_at: input.review.reviewedAt,
      p_expected_state: input.expectedState,
      p_next_state: input.nextState,
    });
    if (error) throw new Error(error.message);
    return data;
  }

  async findSessionReviews(journeyId: Hex, sessionId: string): Promise<ReviewRow[]> {
    const { data, error } = await getSupabaseAdmin()
      .from("review_logs")
      .select("card_id,rating,response_ms,reviewed_at")
      .eq("journey_id", journeyId)
      .eq("session_id", sessionId)
      .order("reviewed_at");
    if (error) throw new Error(`Could not read Session reviews: ${error.message}`);
    return ReviewRowSchema.array().parse(data ?? []);
  }

  async findRecentWeakTags(journeyId: Hex): Promise<string[][]> {
    const { data, error } = await getSupabaseAdmin()
      .from("session_summaries")
      .select("weak_tags")
      .eq("journey_id", journeyId)
      .order("reviewed_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`Could not read recent Session summaries: ${error.message}`);
    return (data ?? []).map((row) => z.array(z.string()).parse(row.weak_tags));
  }

  async countSessions(journeyId: Hex): Promise<number> {
    const { count, error } = await getSupabaseAdmin()
      .from("session_summaries")
      .select("session_id", { count: "exact", head: true })
      .eq("journey_id", journeyId);
    if (error) throw new Error(`Could not count Session summaries: ${error.message}`);
    return count ?? 0;
  }

  async completeSession(input: {
    journeyId: Hex;
    owner: `0x${string}`;
    sessionId: string;
    summary: Record<string, unknown>;
    plan: unknown | null;
    expectedPlanVersion: number;
  }): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("complete_learning_session", {
      p_journey_id: input.journeyId,
      p_owner: input.owner,
      p_session_id: input.sessionId,
      p_summary: input.summary,
      p_plan: input.plan,
      p_expected_plan_version: input.expectedPlanVersion,
    });
    if (error) throw new Error(error.message);
    return data;
  }
}

function parseDeck(row: LearningJourneyRow) {
  return row.deck === null ? null : CommittedKnowledgeCardSchema.array().parse(row.deck);
}

export async function getJourneyDetailForOwner(
  journeyId: Hex,
  owner: `0x${string}`,
  store: LearningStore = new SupabaseLearningStore(),
  now = new Date(),
): Promise<JourneyDetailResponse> {
  const [row, chunkRows] = await Promise.all([
    store.findOwnedJourney(journeyId, owner),
    store.findChunks(journeyId),
  ]);
  if (!row) throw new ApiError(404, "journey_not_found", "Learning project not found");
  const deck = parseDeck(row);
  const plan = row.plan === null ? null : ReviewPlanSchema.parse(row.plan);
  const provenance =
    row.card_provenance === null
      ? null
      : z.record(Bytes32Schema, CardProvenanceSchema).parse(row.card_provenance);
  const chunks = chunkRows.map((chunk) =>
    ChunkProgressSchema.parse({
      chunkId: chunk.chunk_id,
      pageStart: chunk.page_start,
      pageEnd: chunk.page_end,
      title: chunk.title,
      sourceChunkHash: chunk.source_chunk_hash,
      cardsRoot: chunk.cards_root,
      workerAddress: chunk.worker_address,
      status: chunk.status,
      cardCount: chunk.card_count,
      commitTxHash: chunk.commit_tx_hash,
      confirmedBlock: chunk.confirmed_block === null ? null : String(chunk.confirmed_block),
      gasUsed: chunk.gas_used === null ? null : String(chunk.gas_used),
      generationMs: chunk.generation_ms,
      confirmationMs: chunk.confirmation_ms,
    }),
  );
  const fsrsStates = parseFsrsStateMap(row.fsrs_states);
  return JourneyDetailResponseSchema.parse({
    journeyId,
    status: row.status,
    sourceHash: row.source_hash,
    chunkManifestRoot: row.chunk_manifest_root,
    createTxHash: row.create_tx_hash,
    finalizeTxHash: row.finalize_tx_hash,
    deckRoot: row.deck_root,
    planHash: row.plan_hash,
    planVersion: row.plan_version,
    deck,
    provenance,
    plan,
    chunks,
    studyQueue:
      row.status === "READY" && deck
        ? buildStudyQueue({ deck, fsrsStates, plan, now })
        : null,
  });
}

export async function submitReviewForOwner(
  journeyId: Hex,
  owner: `0x${string}`,
  review: SubmitReviewRequest,
  store: LearningStore = new SupabaseLearningStore(),
): Promise<SubmitReviewResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await store.findOwnedJourney(journeyId, owner);
    if (!row) throw new ApiError(404, "journey_not_found", "Learning project not found");
    if (row.status !== "READY") {
      throw new ApiError(409, "journey_not_ready", "Learning project is not ready for review");
    }
    const deck = parseDeck(row) ?? [];
    if (!deck.some((card) => card.id === review.cardId)) {
      throw new ApiError(404, "card_not_found", "Knowledge card not found");
    }
    const states = parseFsrsStateMap(row.fsrs_states);
    const currentState = states[review.cardId] ?? null;
    const nextState = scheduleReview({
      currentState,
      rating: review.rating,
      reviewedAt: review.reviewedAt,
    });
    try {
      return SubmitReviewResponseSchema.parse(
        await store.submitReview({
          journeyId,
          owner,
          review,
          expectedState: currentState,
          nextState,
        }),
      );
    } catch (error) {
      if (attempt === 0 && error instanceof Error && /fsrs state conflict/iu.test(error.message)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Review state conflict could not be resolved");
}

export async function completeSessionForOwner(
  journeyId: Hex,
  owner: `0x${string}`,
  sessionId: string,
  store: LearningStore = new SupabaseLearningStore(),
  now = new Date(),
): Promise<CompleteSessionResponse> {
  const [row, reviews, recentWeakTags, sessionCount] = await Promise.all([
    store.findOwnedJourney(journeyId, owner),
    store.findSessionReviews(journeyId, sessionId),
    store.findRecentWeakTags(journeyId),
    store.countSessions(journeyId),
  ]);
  if (!row) throw new ApiError(404, "journey_not_found", "Learning project not found");
  if (row.status !== "READY") {
    throw new ApiError(409, "journey_not_ready", "Learning project is not ready");
  }
  if (reviews.length === 0 || reviews.length > 15) {
    throw new ApiError(400, "invalid_session", "Session must contain 1 to 15 reviews");
  }
  const deck = parseDeck(row) ?? [];
  const cardsById = new Map(deck.map((card) => [card.id, card]));
  const forgotten = reviews.filter((review) => review.rating === "again");
  const weakTags = [...new Set(forgotten.flatMap((review) => cardsById.get(review.card_id)?.tags ?? []))];
  const states = parseFsrsStateMap(row.fsrs_states);
  const forecast = dueForecast(states, now);
  const triggerReasons: string[] = [];
  if (forgotten.length / reviews.length >= 0.4) triggerReasons.push("forget_rate");
  if (forgotten.some((review) => cardsById.get(review.card_id)?.importance === 5)) {
    triggerReasons.push("important_card_forgotten");
  }
  if (weakTags.some((tag) => recentWeakTags[0]?.includes(tag))) {
    triggerReasons.push("repeated_weak_tag");
  }
  if (forecast.some((count) => count > 15)) triggerReasons.push("due_overload");
  if ((sessionCount + 1) % 3 === 0) triggerReasons.push("periodic_review");

  const reviewedAt = reviews.at(-1)!.reviewed_at;
  const summary = SessionSummarySchema.parse({
    sessionId,
    journeyId,
    reviewedAt,
    reviewedCount: reviews.length,
    forgottenCount: forgotten.length,
    averageResponseMs: Math.round(
      reviews.reduce((total, review) => total + review.response_ms, 0) / reviews.length,
    ),
    dueForecast: forecast,
  });
  const nextPlan =
    triggerReasons.length > 0
      ? buildAdaptivePlan({ deck, fsrsStates: states, version: row.plan_version + 1, now })
      : null;
  return CompleteSessionResponseSchema.parse(
    await store.completeSession({
      journeyId,
      owner,
      sessionId,
      summary: { ...summary, weakTags, triggerReasons },
      plan: nextPlan,
      expectedPlanVersion: row.plan_version,
    }),
  );
}
