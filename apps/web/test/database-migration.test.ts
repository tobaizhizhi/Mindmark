import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const journeyId = `0x${"11".repeat(32)}`;
const secondJourneyId = `0x${"22".repeat(32)}`;
const runnerJourneyId = `0x${"44".repeat(32)}`;
const reviewJourneyId = `0x${"55".repeat(32)}`;
const largeJourneyId = `0x${"66".repeat(32)}`;
const learnerAddress = `0x${"aa".repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(64)}`;

let database: PGlite;

beforeAll(async () => {
  database = new PGlite();
  for (const migration of [
    "00000000000000_workspace_bootstrap.sql",
    "20260722000100_learning_data.sql",
    "20260722000200_runner_orchestration.sql",
    "20260722000300_reviews_and_sessions.sql",
    "20260723000100_expand_material_capacity.sql",
    "20260725000100_worker_rewards.sql",
  ]) {
    const sql = await readFile(path.join(root, "supabase/migrations", migration), "utf8");
    await database.exec(sql);
  }
});

afterAll(async () => {
  await database.close();
});

function journeyPayload(id: string, chunkCount = 2) {
  return {
    journey_id: id,
    learner_address: learnerAddress,
    goal: "Understand reentrancy",
    source_hash: hash("3"),
    goal_hash: hash("4"),
    chunk_manifest_root: hash("5"),
    chunk_count: chunkCount,
  };
}

function chunksPayload(chunkCount = 2) {
  return Array.from({ length: chunkCount }, (_, chunkId) => ({
    chunk_id: chunkId,
    page_start: chunkId + 1,
    page_end: chunkId + 1,
    title: `Chunk ${chunkId}`,
    source_text: `Source text ${chunkId}`,
    source_pages: [{ pageNumber: chunkId + 1, text: `Source text ${chunkId}` }],
    source_chunk_hash: hash(((chunkId % 10) + 1).toString(16)),
    manifest_proof: [hash("8")],
    card_budget: 3,
  }));
}

describe("Step 4 Supabase migration", () => {
  it("creates all private tables with RLS and no browser policies", async () => {
    const result = await database.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in (
          'learning_journeys',
          'source_chunks',
          'review_logs',
          'agent_events',
          'auth_nonces',
          'wallet_sessions'
          ,'session_summaries'
          ,'worker_rewards'
        )
      order by relname
    `);

    expect(result.rows).toHaveLength(8);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(
      true,
    );
    const policies = await database.query<{ count: number }>(
      "select count(*)::integer as count from pg_policies where schemaname = 'public'",
    );
    expect(policies.rows[0]?.count).toBe(0);
  });

  it("atomically inserts one journey and its contiguous chunks", async () => {
    await database.query(
      "select public.prepare_learning_journey($1::jsonb, $2::jsonb)",
      [JSON.stringify(journeyPayload(journeyId)), JSON.stringify(chunksPayload())],
    );

    const journeys = await database.query<{ status: string; chunk_count: number }>(
      "select status, chunk_count from public.learning_journeys where journey_id = $1",
      [journeyId],
    );
    const chunks = await database.query<{ chunk_id: number }>(
      "select chunk_id from public.source_chunks where journey_id = $1 order by chunk_id",
      [journeyId],
    );
    expect(journeys.rows).toEqual([{ status: "AWAITING_CREATE_TX", chunk_count: 2 }]);
    expect(chunks.rows.map((row) => row.chunk_id)).toEqual([0, 1]);
  });

  it("rejects a duplicate chunk payload before inserting the journey", async () => {
    const duplicateChunks = chunksPayload().map((chunk) => ({ ...chunk, chunk_id: 0 }));
    await expect(
      database.query(
        "select public.prepare_learning_journey($1::jsonb, $2::jsonb)",
        [JSON.stringify(journeyPayload(secondJourneyId)), JSON.stringify(duplicateChunks)],
      ),
    ).rejects.toThrow(/unique and contiguous/u);

    const result = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.learning_journeys where journey_id = $1",
      [secondJourneyId],
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it("accepts twelve contiguous chunks and allows the last chunk to be claimed", async () => {
    await database.query(
      "select public.prepare_learning_journey($1::jsonb, $2::jsonb)",
      [JSON.stringify(journeyPayload(largeJourneyId, 12)), JSON.stringify(chunksPayload(12))],
    );
    await database.query(
      "update public.learning_journeys set status = 'GENERATING' where journey_id = $1",
      [largeJourneyId],
    );
    const claimed = await database.query<{ claimed: boolean }>(
      "select public.claim_chunk_generation($1, 11, $2) as claimed",
      [largeJourneyId, learnerAddress],
    );
    const chunks = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.source_chunks where journey_id = $1",
      [largeJourneyId],
    );

    expect(claimed.rows[0]?.claimed).toBe(true);
    expect(chunks.rows[0]?.count).toBe(12);
  });

  it("enforces idempotent review and chunk keys", async () => {
    const sessionId = "123e4567-e89b-12d3-a456-426614174000";
    const insertReview = `
      insert into public.review_logs (
        journey_id, session_id, card_id, rating, response_ms, reviewed_at
      ) values ($1, $2, $3, 'good', 1200, now())
    `;
    await database.query(insertReview, [journeyId, sessionId, hash("9")]);
    await expect(
      database.query(insertReview, [journeyId, sessionId, hash("9")]),
    ).rejects.toThrow(/unique/u);

    await expect(
      database.query(
        `insert into public.source_chunks (
          journey_id, chunk_id, page_start, page_end, title, source_text,
          source_chunk_hash, manifest_proof, card_budget, status
        ) values ($1, 0, 1, 1, 'Duplicate', 'text', $2, '[]', 2, 'QUEUED')`,
        [journeyId, hash("a")],
      ),
    ).rejects.toThrow(/unique/u);
  });

  it("atomically creates exactly one Worker Reward after Chunk confirmation", async () => {
    const worker = `0x${"bb".repeat(20)}`;
    await database.query(
      `update public.source_chunks
       set worker_address = $2, status = 'SUBMITTING'
       where journey_id = $1 and chunk_id = 0`,
      [journeyId, worker],
    );
    const confirm = `select public.confirm_chunk_and_enqueue_reward(
      $1, 0, $2, 123, 80000, 25, $3, 1000000000000000
    ) as confirmed`;
    await database.query(confirm, [journeyId, hash("d"), learnerAddress]);
    await database.query(confirm, [journeyId, hash("e"), learnerAddress]);
    const rewards = await database.query<{ count: number; status: string; recipient_address: string }>(
      `select count(*)::integer as count, max(status) as status, max(recipient_address) as recipient_address
       from public.worker_rewards where journey_id = $1 and chunk_id = 0`,
      [journeyId],
    );
    expect(rewards.rows[0]).toEqual({ count: 1, status: "PENDING", recipient_address: worker });
  });

  it("leases reward work and preserves prepared raw transactions for recovery", async () => {
    const claimed = await database.query<{ status: string; attempt: number }>(
      "select status, attempt from public.claim_worker_reward()",
    );
    expect(claimed.rows[0]).toEqual({ status: "PROCESSING", attempt: 1 });
    const duplicateClaim = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.claim_worker_reward()",
    );
    expect(duplicateClaim.rows[0]?.count).toBe(0);
    const rawTransaction = `0x02${"11".repeat(40)}`;
    await database.query(
      `update public.worker_rewards
       set status = 'PREPARED', signed_transaction = $3, tx_hash = $2, treasury_nonce = 1,
           moss_plan_hash = $4, simulation_status = 'PASSED', moss_stage = 'SIMULATED'
       where journey_id = $1 and chunk_id = 0`,
      [journeyId, hash("f"), rawTransaction, hash("a")],
    );
    await database.query(
      "select public.release_worker_reward($1, 0, 'temporary RPC failure')",
      [journeyId],
    );
    const prepared = await database.query<{ status: string; signed_transaction: string }>(
      "select status, signed_transaction from public.worker_rewards where journey_id = $1 and chunk_id = 0",
      [journeyId],
    );
    expect(prepared.rows[0]).toEqual({ status: "PREPARED", signed_transaction: rawTransaction });
  });

  it("consumes a valid auth nonce only once", async () => {
    await database.query(
      `insert into public.auth_nonces (nonce, wallet_address, expires_at)
       values ('validnonce123', $1, now() + interval '10 minutes')`,
      [learnerAddress],
    );
    const first = await database.query<{ consumed: boolean }>(
      "select public.consume_auth_nonce('validnonce123', $1) as consumed",
      [learnerAddress],
    );
    const second = await database.query<{ consumed: boolean }>(
      "select public.consume_auth_nonce('validnonce123', $1) as consumed",
      [learnerAddress],
    );
    expect(first.rows[0]?.consumed).toBe(true);
    expect(second.rows[0]?.consumed).toBe(false);
  });

  it("claims generation work idempotently and recovers stale chunks", async () => {
    await database.query(
      "select public.prepare_learning_journey($1::jsonb, $2::jsonb)",
      [JSON.stringify(journeyPayload(runnerJourneyId)), JSON.stringify(chunksPayload())],
    );
    await database.query(
      "update public.learning_journeys set status = 'CREATED' where journey_id = $1",
      [runnerJourneyId],
    );
    const firstClaim = await database.query<{ claimed: boolean }>(
      "select public.claim_journey_generation($1) as claimed",
      [runnerJourneyId],
    );
    const duplicateClaim = await database.query<{ claimed: boolean }>(
      "select public.claim_journey_generation($1) as claimed",
      [runnerJourneyId],
    );
    expect(firstClaim.rows[0]?.claimed).toBe(true);
    expect(duplicateClaim.rows[0]?.claimed).toBe(false);

    const chunkClaim = await database.query<{ claimed: boolean }>(
      "select public.claim_chunk_generation($1, 0, $2) as claimed",
      [runnerJourneyId, learnerAddress],
    );
    expect(chunkClaim.rows[0]?.claimed).toBe(true);
    await database.query(
      "update public.source_chunks set chunk_lease_until = now() - interval '1 second' where journey_id = $1 and chunk_id = 0",
      [runnerJourneyId],
    );
    const recovery = await database.query<{ count: number }>(
      "select public.recover_stale_chunks() as count",
    );
    expect(recovery.rows[0]?.count).toBe(1);
    const status = await database.query<{ status: string; attempt: number }>(
      "select status, attempt from public.source_chunks where journey_id = $1 and chunk_id = 0",
      [runnerJourneyId],
    );
    expect(status.rows[0]).toEqual({ status: "RETRYABLE", attempt: 1 });
  });

  it("cleans source text and drafts on READY without deleting proofs or final data", async () => {
    await database.query(
      `update public.source_chunks
       set cards = '[{"id":"draft"}]'::jsonb
       where journey_id = $1`,
      [journeyId],
    );
    await database.query(
      `update public.learning_journeys
       set status = 'READY',
           deck = '{"cards":[{"id":"selected"}]}'::jsonb,
           card_provenance = '{"selected":{"chunkId":0}}'::jsonb,
           deck_root = $2
       where journey_id = $1`,
      [journeyId, hash("b")],
    );

    const chunks = await database.query<{
      source_text: string | null;
      source_pages: unknown[] | null;
      cards: unknown[];
      manifest_proof: string[];
    }>(
      "select source_text, source_pages, cards, manifest_proof from public.source_chunks where journey_id = $1",
      [journeyId],
    );
    expect(chunks.rows.every((chunk) => chunk.source_text === null)).toBe(true);
    expect(chunks.rows.every((chunk) => chunk.source_pages === null)).toBe(true);
    expect(chunks.rows.every((chunk) => chunk.cards.length === 0)).toBe(true);
    expect(chunks.rows.every((chunk) => chunk.manifest_proof.length > 0)).toBe(true);

    const journey = await database.query<{ deck: unknown; card_provenance: unknown }>(
      "select deck, card_provenance from public.learning_journeys where journey_id = $1",
      [journeyId],
    );
    expect(journey.rows[0]?.deck).toEqual({ cards: [{ id: "selected" }] });
    expect(journey.rows[0]?.card_provenance).toEqual({ selected: { chunkId: 0 } });
  });

  it("advances FSRS exactly once for a duplicate review and enforces ownership", async () => {
    const cardId = hash("c");
    const sessionId = "223e4567-e89b-12d3-a456-426614174000";
    await database.query(
      "select public.prepare_learning_journey($1::jsonb, $2::jsonb)",
      [JSON.stringify(journeyPayload(reviewJourneyId)), JSON.stringify(chunksPayload())],
    );
    await database.query(
      `update public.learning_journeys
       set status = 'READY', deck = $2::jsonb
       where journey_id = $1`,
      [reviewJourneyId, JSON.stringify([{ id: cardId }])],
    );
    const firstState = {
      due: "2026-07-23T00:00:00.000Z",
      reps: 1,
    };
    const secondState = {
      due: "2026-08-01T00:00:00.000Z",
      reps: 99,
    };
    const submit = `select public.submit_learning_review(
      $1, $2, $3::uuid, $4, 'good', 1000, '2026-07-22T00:00:00Z',
      null::jsonb, $5::jsonb
    ) as result`;
    const first = await database.query<{ result: { duplicate: boolean; nextReviewAt: string } }>(
      submit,
      [reviewJourneyId, learnerAddress, sessionId, cardId, JSON.stringify(firstState)],
    );
    const duplicate = await database.query<{
      result: { duplicate: boolean; nextReviewAt: string };
    }>(submit, [reviewJourneyId, learnerAddress, sessionId, cardId, JSON.stringify(secondState)]);
    expect(first.rows[0]?.result.duplicate).toBe(false);
    expect(duplicate.rows[0]?.result).toEqual({
      duplicate: true,
      accepted: true,
      nextReviewAt: firstState.due,
    });
    const state = await database.query<{ fsrs: unknown; count: number }>(
      `select fsrs_states->$2 as fsrs,
        (select count(*)::integer from public.review_logs where journey_id = $1) as count
       from public.learning_journeys where journey_id = $1`,
      [reviewJourneyId, cardId],
    );
    expect(state.rows[0]).toEqual({ fsrs: firstState, count: 1 });
    await expect(
      database.query(submit, [
        reviewJourneyId,
        `0x${"bb".repeat(20)}`,
        sessionId,
        cardId,
        JSON.stringify(firstState),
      ]),
    ).rejects.toThrow(/ready owned journey card not found/u);

    const summary = {
      sessionId,
      journeyId: reviewJourneyId,
      reviewedAt: "2026-07-22T00:00:00.000Z",
      reviewedCount: 1,
      forgottenCount: 0,
      averageResponseMs: 1000,
      dueForecast: [0, 1, 0, 0, 0, 0, 0],
      weakTags: [],
      triggerReasons: [],
    };
    const complete = `select public.complete_learning_session(
      $1, $2, $3::uuid, $4::jsonb, null::jsonb, 1
    ) as result`;
    const completed = await database.query<{
      result: { planUpdated: boolean; planVersion: number };
    }>(complete, [reviewJourneyId, learnerAddress, sessionId, JSON.stringify(summary)]);
    const duplicateCompletion = await database.query<{
      result: { summary: { reviewedCount: number }; planUpdated: boolean; planVersion: number };
    }>(complete, [
      reviewJourneyId,
      learnerAddress,
      sessionId,
      JSON.stringify({ ...summary, reviewedCount: 0 }),
    ]);
    expect(completed.rows[0]?.result).toMatchObject({ planUpdated: false, planVersion: 1 });
    expect(duplicateCompletion.rows[0]?.result).toMatchObject({
      planUpdated: false,
      planVersion: 1,
      summary: { reviewedCount: 1 },
    });
  });
});
