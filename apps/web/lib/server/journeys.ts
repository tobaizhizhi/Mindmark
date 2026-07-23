import { randomBytes } from "node:crypto";
import {
  PrepareJourneyResponseSchema,
  prepareJourney,
  type PrepareJourneyRequest,
  type PrepareJourneyResponse,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { getSupabaseAdmin } from "./supabase";

export type StoredJourney = {
  journey_id: Hex;
  learner_address: `0x${string}`;
  source_hash: Hex;
  goal_hash: Hex;
  chunk_manifest_root: Hex;
  chunk_count: number;
  status: string;
  create_tx_hash: Hex | null;
};

export type JourneyListItem = {
  journeyId: Hex;
  goal: string | null;
  status: string;
  cardCount: number;
  studiedCardCount: number;
  dueCount: number;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
};

type JourneyListRow = {
  journey_id: Hex;
  goal: string | null;
  status: string;
  deck: unknown;
  fsrs_states: unknown;
  plan_version: number;
  created_at: string;
  updated_at: string;
};

export interface JourneyStore {
  savePrepared(journey: Record<string, unknown>, chunks: Record<string, unknown>[]): Promise<void>;
  findOwned(journeyId: Hex, owner: `0x${string}`): Promise<StoredJourney | null>;
  recordCreateTransaction(journeyId: Hex, owner: `0x${string}`, txHash: Hex): Promise<void>;
  markCreated(journeyId: Hex, owner: `0x${string}`, txHash: Hex): Promise<void>;
}

export interface JourneyListStore {
  listOwned(owner: `0x${string}`): Promise<JourneyListRow[]>;
}

export class SupabaseJourneyStore implements JourneyStore {
  async savePrepared(
    journey: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<void> {
    const { error } = await getSupabaseAdmin().rpc("prepare_learning_journey", {
      p_journey: journey,
      p_chunks: chunks,
    });
    if (error) throw new Error(`Could not persist prepared journey: ${error.message}`);
  }

  async findOwned(journeyId: Hex, owner: `0x${string}`): Promise<StoredJourney | null> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_journeys")
      .select(
        "journey_id, learner_address, source_hash, goal_hash, chunk_manifest_root, chunk_count, status, create_tx_hash",
      )
      .eq("journey_id", journeyId)
      .eq("learner_address", owner)
      .maybeSingle();
    if (error) throw new Error(`Could not read journey: ${error.message}`);
    return data as StoredJourney | null;
  }

  async markCreated(journeyId: Hex, owner: `0x${string}`, txHash: Hex): Promise<void> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_journeys")
      .update({ status: "CREATED", create_tx_hash: txHash })
      .eq("journey_id", journeyId)
      .eq("learner_address", owner)
      .in("status", ["AWAITING_CREATE_TX", "CREATED"])
      .select("journey_id");
    if (error) throw new Error(`Could not confirm journey: ${error.message}`);
    if (!data || data.length !== 1) throw new Error("Journey state changed before confirmation");
  }

  async recordCreateTransaction(
    journeyId: Hex,
    owner: `0x${string}`,
    txHash: Hex,
  ): Promise<void> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_journeys")
      .update({ create_tx_hash: txHash })
      .eq("journey_id", journeyId)
      .eq("learner_address", owner)
      .eq("status", "AWAITING_CREATE_TX")
      .or(`create_tx_hash.is.null,create_tx_hash.eq.${txHash}`)
      .select("journey_id");
    if (error) throw new Error(`Could not record create transaction: ${error.message}`);
    if (!data || data.length !== 1) {
      throw new Error("A different create transaction is already recorded");
    }
  }
}

export class SupabaseJourneyListStore implements JourneyListStore {
  async listOwned(owner: `0x${string}`): Promise<JourneyListRow[]> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_journeys")
      .select("journey_id,goal,status,deck,fsrs_states,plan_version,created_at,updated_at")
      .eq("learner_address", owner)
      .order("updated_at", { ascending: false })
      .limit(24);
    if (error) throw new Error(`Could not list learning projects: ${error.message}`);
    return (data ?? []) as JourneyListRow[];
  }
}

function fsrsEntries(value: unknown): Array<{ due?: unknown }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).filter(
    (entry): entry is { due?: unknown } => Boolean(entry && typeof entry === "object"),
  );
}

export async function listJourneysForOwner(
  owner: `0x${string}`,
  store: JourneyListStore = new SupabaseJourneyListStore(),
  now = new Date(),
): Promise<{ journeys: JourneyListItem[] }> {
  const rows = await store.listOwned(owner);
  return {
    journeys: rows.map((row) => {
      const states = fsrsEntries(row.fsrs_states);
      return {
        journeyId: row.journey_id,
        goal: row.goal,
        status: row.status,
        cardCount: Array.isArray(row.deck) ? row.deck.length : 0,
        studiedCardCount: states.length,
        dueCount: states.filter(
          (state) =>
            typeof state.due === "string" &&
            Number.isFinite(Date.parse(state.due)) &&
            Date.parse(state.due) <= now.getTime(),
        ).length,
        planVersion: row.plan_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
  };
}

export function randomJourneyId(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

export async function prepareJourneyForOwner(
  request: PrepareJourneyRequest,
  owner: `0x${string}`,
  store: JourneyStore = new SupabaseJourneyStore(),
  journeyId: Hex = randomJourneyId(),
): Promise<PrepareJourneyResponse> {
  const prepared = prepareJourney(request, journeyId);
  await store.savePrepared(
    {
      journey_id: prepared.journeyId,
      learner_address: owner,
      goal: request.goal?.trim() || null,
      source_hash: prepared.sourceHash,
      goal_hash: prepared.goalHash,
      chunk_manifest_root: prepared.chunkManifestRoot,
      chunk_count: prepared.chunkCount,
    },
    prepared.chunks.map((chunk) => ({
      chunk_id: chunk.content.chunkId,
      page_start: chunk.content.pageStart,
      page_end: chunk.content.pageEnd,
      title: chunk.content.title,
      source_text: chunk.content.text,
      source_pages: chunk.sourcePages,
      source_chunk_hash: chunk.sourceChunkHash,
      manifest_proof: chunk.manifestProof,
      card_budget: chunk.cardBudget,
    })),
  );

  return PrepareJourneyResponseSchema.parse({
    journeyId: prepared.journeyId,
    createJourneyArgs: {
      journeyId: prepared.journeyId,
      sourceHash: prepared.sourceHash,
      goalHash: prepared.goalHash,
      chunkManifestRoot: prepared.chunkManifestRoot,
      chunkCount: prepared.chunkCount,
    },
    chunks: prepared.chunks.map((chunk) => ({
      chunkId: chunk.content.chunkId,
      pageStart: chunk.content.pageStart,
      pageEnd: chunk.content.pageEnd,
      title: chunk.content.title,
      cardBudget: chunk.cardBudget,
    })),
  });
}
