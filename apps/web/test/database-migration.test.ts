import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  PackChapterSchema,
  PackManifestSchema,
  buildCardTree,
  buildCardPackArtifact,
  deriveCardIdV2,
  hashGoal,
  hashKnowledgeCard,
  intakeSource,
  LearningQualityOperationsReportSchema,
  WorkflowOperationsSnapshotSchema,
  hashCardBlueprintV3,
  hashChapterConceptInventoryV3,
  hashFrozenProjectDesignV3,
  materializeCardBlueprint,
  materializeChapterConceptInventory,
  planBlueprintWorkUnits,
  planChaptersDeterministically,
  planWorkUnits,
  type CardPackBundle,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const projectId = `0x${"77".repeat(32)}` as Hex;
const duplicateSourceProjectId = `0x${"66".repeat(32)}` as Hex;
const workflowProjectId = `0x${"88".repeat(32)}` as Hex;
const designProjectId = `0x${"99".repeat(32)}` as Hex;
const legacyPricingProjectId = `0x${"44".repeat(32)}` as Hex;
const relevanceProjectId = `0x${"55".repeat(32)}` as Hex;
const owner = `0x${"aa".repeat(20)}`;
let database: PGlite;

async function loadCardPackFixture(version = "v1"): Promise<CardPackBundle> {
  const versionDir = path.join(root, `content/card-packs/solidity-foundations/${version}`);
  const manifest = PackManifestSchema.parse(JSON.parse(
    await readFile(path.join(versionDir, "manifest.json"), "utf8"),
  ));
  const chapters = await Promise.all(manifest.chapters.map(async (chapter) => (
    PackChapterSchema.parse(JSON.parse(await readFile(path.join(versionDir, chapter.cardsFile), "utf8")))
  )));
  return { manifest, chapters };
}

beforeAll(async () => {
  database = new PGlite();
  for (const migration of [
    "20260724000100_v2_foundation.sql",
    "20260725000200_chapter_first_v2.sql",
    "20260726000100_v2_runner_pipeline.sql",
    "20260727000100_material_chapter_card_correction.sql",
    "20260727000200_document_library.sql",
    "20260728000100_workflow_jobs.sql",
    "20260728000200_workflow_dispatch.sql",
    "20260728000300_operations_diagnostics.sql",
    "20260729000100_runner_constraint_alignment.sql",
    "20260730000100_learning_design_v3.sql",
    "20260730000200_learning_quality_operations.sql",
    "20260730000300_allow_duplicate_project_sources.sql",
    "20260731000100_outline_learning_relevance.sql",
    "20260731000200_blueprint_capacity_guards.sql",
    "20260801000100_card_packs.sql",
    "20260801000200_card_pack_code_exercises.sql",
    "20260801000300_card_pack_curriculum_progression.sql",
    "20260802000100_card_pack_curriculum_v4.sql",
    "20260802000200_card_pack_curriculum_v4_constraints.sql",
    "20260802000300_card_pack_reading_v5.sql",
    "20260802000400_original_pdf_storage.sql",
    "20260803000100_schema_capabilities.sql",
    "20260804000100_preserve_upload_source_text.sql",
    "20260805000200_retry_blocked_moss_rewards.sql",
    "20260807000100_project_sponsor_escrow.sql",
    "20260807000200_generation_failure_recovery.sql",
    "20260807000300_dynamic_work_unit_pricing.sql",
    "20260807000400_legacy_escrow_pricing_recovery.sql",
    "20260808000100_parallel_worker_dispatch.sql",
  ]) {
    await database.exec(await readFile(path.join(root, "supabase/migrations", migration), "utf8"));
  }
});

afterAll(async () => database.close());

describe("V2 database baseline", () => {
  it("resets blocked Moss rewards before enqueuing a safe retry", async () => {
    const result = await database.query<{ definition: string }>(`
      select pg_get_functiondef(functions.oid) as definition
      from pg_proc as functions
      join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
      where namespaces.nspname = 'public'
        and functions.proname = 'retry_blocked_work_unit_reward_v2'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.definition).toMatch(/status\s*=\s*'RETRYABLE'/iu);
    expect(result.rows[0]!.definition).toMatch(/signed_transaction\s*=\s*null/iu);
    expect(result.rows[0]!.definition).toMatch(/treasury_nonce\s*=\s*null/iu);
    expect(result.rows[0]!.definition).toMatch(/enqueue_workflow_job_v2/iu);
  });

  it("retains uploaded Source Block text after Project finalization", async () => {
    const result = await database.query<{ definition: string }>(`
      select pg_get_functiondef(functions.oid) as definition
      from pg_proc as functions
      join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
      where namespaces.nspname = 'public' and functions.proname = 'mark_project_ready_v2'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.definition).not.toMatch(/update\s+public\.source_blocks\s+set\s+text\s*=\s*null/iu);
  });

  it("exposes the final schema capabilities and exact read-only RPC signature", async () => {
    const capabilityResult = await database.query<{ capabilities: unknown }>(
      "select public.get_schema_capabilities_v1() as capabilities",
    );
    expect(capabilityResult.rows[0]?.capabilities).toEqual({
      schemaVersion: "2026-08-08.1",
      capabilities: {
        coreLearningV2: true,
        learningDesignV3: true,
        cardPackReadingV5: true,
        originalPdfStorage: true,
        learnerProgress: true,
        sponsorEscrow: true,
        parallelWorkerDispatch: true,
      },
      missing: [],
    });
    const signature = await database.query<{ arguments: string }>(`
      select pg_get_function_identity_arguments(functions.oid) as arguments
      from pg_proc as functions
      join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
      where namespaces.nspname = 'public' and functions.proname = 'get_schema_capabilities_v1'
    `);
    expect(signature.rows).toEqual([{ arguments: "" }]);
  });

  it("adds a worker-lane claim RPC for safe parallel generation", async () => {
    const result = await database.query<{ arguments: string; definition: string }>(`
      select pg_get_function_identity_arguments(functions.oid) as arguments,
             pg_get_functiondef(functions.oid) as definition
      from pg_proc as functions
      join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
      where namespaces.nspname = 'public'
        and functions.proname = 'claim_next_generation_workflow_job_for_worker_v2'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.arguments).toBe("p_worker_index integer");
    expect(result.rows[0]?.definition).toMatch(/mod\(work_unit_id,\s*3\)\s*=\s*p_worker_index/iu);
    expect(result.rows[0]?.definition).toMatch(/for update skip locked/iu);
  });

  it("derives Escrow Reward terms from the funded Project instead of confirmation input", async () => {
    const result = await database.query<{ arguments: string; definition: string }>(`
      select pg_get_function_identity_arguments(functions.oid) as arguments,
        pg_get_functiondef(functions.oid) as definition
      from pg_proc as functions
      join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
      where namespaces.nspname = 'public'
        and functions.proname = 'confirm_work_unit_and_enqueue_escrow_reward_v3'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.arguments).not.toMatch(/treasury|amount_wei/iu);
    expect(result.rows[0]!.definition).toMatch(/escrow_state\s*=\s*'FUNDED'/iu);
    expect(result.rows[0]!.definition).toMatch(/card_quality_evaluations/iu);
    expect(result.rows[0]!.definition).toMatch(/v_unit\.reward_amount_wei/iu);
  });

  it("detects the exact seven-argument Outline Draft RPC even when the legacy overload remains", async () => {
    await database.exec("begin");
    try {
      await database.exec(`
        drop function public.save_project_outline_draft_v2(
          text, text, integer, text, text, jsonb, jsonb
        )
      `);
      const capabilityResult = await database.query<{
        capabilities: { capabilities: { coreLearningV2: boolean }; missing: string[] };
      }>("select public.get_schema_capabilities_v1() as capabilities");
      expect(capabilityResult.rows[0]?.capabilities).toMatchObject({
        capabilities: { coreLearningV2: false },
        missing: expect.arrayContaining(["core_learning_v2"]),
      });
    } finally {
      await database.exec("rollback");
    }
  });

  it("rejects an unsafe or incomplete source PDF Storage bucket", async () => {
    await database.exec(`
      create schema storage;
      create table storage.buckets (
        id text primary key,
        public boolean not null,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      insert into storage.buckets (id, public, file_size_limit, allowed_mime_types)
      values ('learning-source-files', true, 15728640, array['application/pdf']::text[])
    `);
    const unsafe = await database.query<{
      capabilities: { capabilities: { originalPdfStorage: boolean }; missing: string[] };
    }>("select public.get_schema_capabilities_v1() as capabilities");
    expect(unsafe.rows[0]?.capabilities).toMatchObject({
      capabilities: { originalPdfStorage: false },
      missing: expect.arrayContaining(["original_pdf_storage"]),
    });

    await database.exec(`
      update storage.buckets
      set public = false
      where id = 'learning-source-files'
    `);
    const safe = await database.query<{
      capabilities: { capabilities: { originalPdfStorage: boolean }; missing: string[] };
    }>("select public.get_schema_capabilities_v1() as capabilities");
    expect(safe.rows[0]?.capabilities).toMatchObject({
      capabilities: { originalPdfStorage: true },
      missing: expect.not.arrayContaining(["original_pdf_storage"]),
    });
  });

  it("creates V2 and additive V3 learning tables with forced RLS and no browser policies", async () => {
    const result = await database.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in (
          'auth_nonces', 'wallet_sessions', 'project_folders', 'learning_projects',
          'source_blocks', 'project_outline_versions', 'project_outline_items',
          'chapters', 'work_units', 'knowledge_cards', 'card_learning_states',
          'review_sessions', 'project_review_logs', 'project_agent_events', 'work_unit_rewards',
          'workflow_jobs', 'workflow_events', 'chapter_design_runs',
          'card_blueprint_slots', 'card_slot_candidates', 'card_quality_evaluations',
          'knowledge_card_feedback', 'project_outline_exclusions',
          'card_packs', 'card_pack_versions', 'card_pack_chapters',
          'card_pack_cards', 'card_pack_installations',
          'card_pack_chapter_reading_blocks'
        )
    `);
    expect(result.rows).toHaveLength(29);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const policies = await database.query<{ count: number }>(
      "select count(*)::integer as count from pg_policies where schemaname = 'public'",
    );
    expect(policies.rows[0]?.count).toBe(0);
  });

  it("publishes and installs a Card Pack atomically with owner-scoped progress", async () => {
    const artifact = buildCardPackArtifact(await loadCardPackFixture());
    const published = await database.query<{ pack_version_id: string }>(
      "select public.publish_card_pack_v1($1::jsonb, $2::jsonb, $3, $4) as pack_version_id",
      [
        JSON.stringify(artifact.manifest),
        JSON.stringify(artifact.chapters),
        artifact.manifestHash,
        artifact.contentHash,
      ],
    );
    const packVersionId = published.rows[0]!.pack_version_id;
    const first = await database.query<{ result: {
      projectId: Hex;
      installationId: string;
      idempotent: boolean;
      chapterCount: number;
      cardCount: number;
    } }>(
      "select public.install_card_pack_v1($1, $2::uuid, null) as result",
      [owner, packVersionId],
    );
    const repeated = await database.query<{ result: { projectId: Hex; installationId: string; idempotent: boolean } }>(
      "select public.install_card_pack_v1($1, $2::uuid, null) as result",
      [owner, packVersionId],
    );
    const secondOwner = `0x${"bb".repeat(20)}`;
    const second = await database.query<{ result: { projectId: Hex; idempotent: boolean } }>(
      "select public.install_card_pack_v1($1, $2::uuid, null) as result",
      [secondOwner, packVersionId],
    );

    expect(first.rows[0]?.result).toMatchObject({
      idempotent: false,
      chapterCount: 8,
      cardCount: 40,
    });
    expect(repeated.rows[0]?.result).toEqual({
      ...first.rows[0]!.result,
      idempotent: true,
    });
    expect(second.rows[0]?.result.idempotent).toBe(false);
    expect(second.rows[0]?.result.projectId).not.toBe(first.rows[0]?.result.projectId);

    const projects = await database.query<{
      project_id: Hex;
      project_kind: string;
      status: string;
      chapter_count: number;
      card_count: number;
      work_unit_count: number;
      workflow_job_count: number;
    }>(`
      select projects.project_id, projects.project_kind, projects.status,
        (select count(*)::integer from public.chapters where project_id = projects.project_id) as chapter_count,
        (select count(*)::integer from public.knowledge_cards where project_id = projects.project_id) as card_count,
        (select count(*)::integer from public.work_units where project_id = projects.project_id) as work_unit_count,
        (select count(*)::integer from public.workflow_jobs where project_id = projects.project_id) as workflow_job_count
      from public.learning_projects as projects
      where projects.pack_version_id = $1::uuid
      order by projects.owner_address
    `, [packVersionId]);
    expect(projects.rows).toHaveLength(2);
    expect(projects.rows.every((project) => (
      project.project_kind === "PACK"
      && project.status === "READY"
      && project.chapter_count === 8
      && project.card_count === 40
      && project.work_unit_count === 0
      && project.workflow_job_count === 0
    ))).toBe(true);

    const origins = await database.query<{ origin_type: string; count: number }>(`
      select origin_type, count(*)::integer as count
      from public.knowledge_cards where project_id = $1
      group by origin_type
    `, [first.rows[0]!.result.projectId]);
    expect(origins.rows).toEqual([{ origin_type: "PACK", count: 40 }]);
    const projectSummary = await database.query<{ project_kind: string; pack_version_id: string }>(`
      select project_kind, pack_version_id
      from public.get_project_summaries_v2($1, now())
      where project_id = $2
    `, [owner, first.rows[0]!.result.projectId]);
    expect(projectSummary.rows[0]).toEqual({ project_kind: "PACK", pack_version_id: packVersionId });
    const catalog = await database.query<{ result: { packs: Array<{ slug: string; cardCount: number; installedProjectId: Hex | null }> } }>(
      "select public.list_published_card_packs_v1($1) as result",
      [owner],
    );
    expect(catalog.rows[0]?.result.packs).toEqual([
      expect.objectContaining({ slug: "solidity-foundations", cardCount: 40, installedProjectId: first.rows[0]!.result.projectId }),
    ]);
    const detail = await database.query<{ result: { chapters: Array<{ cards: unknown[] }> } }>(
      "select public.get_published_card_pack_v1($1::uuid, $2) as result",
      [packVersionId, owner],
    );
    expect(detail.rows[0]?.result.chapters).toHaveLength(8);
    expect(detail.rows[0]?.result.chapters[0]?.cards).toHaveLength(5);
    const secondInstallation = await database.query<{ installation_id: string; project_id: Hex }>(
      "select installation_id, project_id from public.card_pack_installations where owner_address = $1",
      [secondOwner],
    );
    await database.query("select public.delete_card_pack_installation_v1($1, $2::uuid)", [
      secondOwner,
      secondInstallation.rows[0]!.installation_id,
    ]);
    const deletedProject = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.learning_projects where project_id = $1",
      [secondInstallation.rows[0]!.project_id],
    );
    expect(deletedProject.rows[0]?.count).toBe(0);
    await expect(database.query(
      "update public.learning_projects set status = 'GENERATING' where project_id = $1",
      [first.rows[0]!.result.projectId],
    )).rejects.toThrow(/cannot enter the AI or Monad execution lifecycle/u);
  });

  it("publishes code exercises and exposes only the newest Pack release by default", async () => {
    const artifact = buildCardPackArtifact(await loadCardPackFixture("v2"));
    const published = await database.query<{ pack_version_id: string }>(
      "select public.publish_card_pack_v2($1::jsonb, $2::jsonb, $3, $4) as pack_version_id",
      [
        JSON.stringify(artifact.manifest),
        JSON.stringify(artifact.chapters),
        artifact.manifestHash,
        artifact.contentHash,
      ],
    );
    const packVersionId = published.rows[0]!.pack_version_id;
    const detail = await database.query<{ result: {
      title: string;
      version: string;
      cardCount: number;
      chapters: Array<{ cards: Array<{ type: string; code?: { language: string; solutionCode: string } }> }>;
    } }>("select public.get_published_card_pack_v1($1::uuid, null) as result", [packVersionId]);

    expect(detail.rows[0]?.result).toMatchObject({
      title: "Solidity 基础与代码实战",
      version: "2.0.0",
      cardCount: 48,
    });
    expect(detail.rows[0]?.result.chapters.flatMap((chapter) => chapter.cards).filter((card) => card.code)).toHaveLength(16);
    expect(detail.rows[0]?.result.chapters[0]?.cards[2]).toMatchObject({
      type: "code_complete",
      code: { language: "solidity", solutionCode: expect.stringContaining("count += 1") },
    });

    const catalog = await database.query<{ result: { packs: Array<{ version: string; cardCount: number }> } }>(
      "select public.list_published_card_packs_v1(null) as result",
    );
    expect(catalog.rows[0]?.result.packs).toEqual([
      expect.objectContaining({ version: "2.0.0", cardCount: 48 }),
    ]);
  });

  it("publishes and installs the progressive v3 curriculum without an AI workflow", async () => {
    const artifact = buildCardPackArtifact(await loadCardPackFixture("v3"));
    const published = await database.query<{ pack_version_id: string }>(
      "select public.publish_card_pack_v3($1::jsonb, $2::jsonb, $3, $4) as pack_version_id",
      [
        JSON.stringify(artifact.manifest),
        JSON.stringify(artifact.chapters),
        artifact.manifestHash,
        artifact.contentHash,
      ],
    );
    const packVersionId = published.rows[0]!.pack_version_id;
    const detail = await database.query<{ result: {
      version: string;
      chapterCount: number;
      cardCount: number;
      chapters: Array<{
        learningObjectives: string[];
        prerequisiteChapterIds: number[];
        cards: Array<{ code?: { starterCode?: string; solutionCode: string } }>;
      }>;
    } }>("select public.get_published_card_pack_v1($1::uuid, null) as result", [packVersionId]);

    expect(detail.rows[0]?.result).toMatchObject({
      version: "3.0.0",
      chapterCount: 15,
      cardCount: 105,
    });
    expect(detail.rows[0]?.result.chapters).toHaveLength(15);
    expect(detail.rows[0]?.result.chapters[0]?.learningObjectives).toHaveLength(3);
    expect(detail.rows[0]?.result.chapters[0]?.prerequisiteChapterIds).toEqual([]);
    expect(detail.rows[0]?.result.chapters[1]?.prerequisiteChapterIds).toEqual([0]);
    const publishedCodeCards = detail.rows[0]!.result.chapters
      .flatMap((chapter) => chapter.cards)
      .filter((card) => card.code);
    expect(publishedCodeCards).toHaveLength(45);
    expect(publishedCodeCards.every((card) => (
      Boolean(card.code?.starterCode) && Boolean(card.code?.solutionCode)
    ))).toBe(true);

    const progressiveOwner = `0x${"cc".repeat(20)}`;
    const first = await database.query<{ result: {
      projectId: Hex;
      installationId: string;
      chapterCount: number;
      cardCount: number;
      idempotent: boolean;
    } }>("select public.install_card_pack_v1($1, $2::uuid, null) as result", [progressiveOwner, packVersionId]);
    const repeated = await database.query<{ result: { projectId: Hex; installationId: string; idempotent: boolean } }>(
      "select public.install_card_pack_v1($1, $2::uuid, null) as result",
      [progressiveOwner, packVersionId],
    );

    expect(first.rows[0]?.result).toMatchObject({ chapterCount: 15, cardCount: 105, idempotent: false });
    expect(repeated.rows[0]?.result).toEqual({
      ...first.rows[0]!.result,
      idempotent: true,
    });
    const installed = await database.query<{
      project_kind: string;
      status: string;
      chapter_count: number;
      card_count: number;
      code_card_count: number;
      work_unit_count: number;
      workflow_job_count: number;
    }>(`
      select projects.project_kind, projects.status,
        (select count(*)::integer from public.chapters where project_id = projects.project_id) as chapter_count,
        (select count(*)::integer from public.knowledge_cards where project_id = projects.project_id) as card_count,
        (select count(*)::integer from public.knowledge_cards where project_id = projects.project_id and content ? 'code') as code_card_count,
        (select count(*)::integer from public.work_units where project_id = projects.project_id) as work_unit_count,
        (select count(*)::integer from public.workflow_jobs where project_id = projects.project_id) as workflow_job_count
      from public.learning_projects as projects
      where projects.project_id = $1
    `, [first.rows[0]!.result.projectId]);
    expect(installed.rows[0]).toEqual({
      project_kind: "PACK",
      status: "READY",
      chapter_count: 15,
      card_count: 105,
      code_card_count: 45,
      work_unit_count: 0,
      workflow_job_count: 0,
    });

    const catalog = await database.query<{ result: { packs: Array<{ version: string; chapterCount: number; cardCount: number }> } }>(
      "select public.list_published_card_packs_v1(null) as result",
    );
    expect(catalog.rows[0]?.result.packs).toEqual([
      expect.objectContaining({ version: "3.0.0", chapterCount: 15, cardCount: 105 }),
    ]);
  });

  it("publishes and installs the structured v4 staged curriculum", async () => {
    const artifact = buildCardPackArtifact(await loadCardPackFixture("v4"));
    const published = await database.query<{ pack_version_id: string }>(
      "select public.publish_card_pack_v4($1::jsonb, $2::jsonb, $3, $4) as pack_version_id",
      [
        JSON.stringify(artifact.manifest),
        JSON.stringify(artifact.chapters),
        artifact.manifestHash,
        artifact.contentHash,
      ],
    );
    const packVersionId = published.rows[0]!.pack_version_id;
    const detail = await database.query<{ result: {
      version: string;
      chapterCount: number;
      cardCount: number;
      chapters: Array<{
        stageId: number;
        stageTitle: string;
        newConcepts: string[];
        prerequisiteConcepts: string[];
        practiceFocus: string;
        projectMilestone: string;
        cards: Array<{ code?: { starterCode?: string; solutionCode: string } }>;
      }>;
    } }>("select public.get_published_card_pack_v1($1::uuid, null) as result", [packVersionId]);

    expect(detail.rows[0]?.result).toMatchObject({ version: "4.0.0", chapterCount: 16, cardCount: 112 });
    expect(detail.rows[0]?.result.chapters).toHaveLength(16);
    expect(detail.rows[0]?.result.chapters.map((chapter) => chapter.stageId)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5,
    ]);
    expect(detail.rows[0]?.result.chapters[8]).toMatchObject({
      newConcepts: expect.arrayContaining(["delete 重置"]),
      practiceFocus: expect.any(String),
      projectMilestone: expect.any(String),
    });
    expect(detail.rows[0]?.result.chapters[9]?.newConcepts).toEqual(
      expect.arrayContaining(["constant 配置"]),
    );
    const codeCards = detail.rows[0]!.result.chapters.flatMap((chapter) => chapter.cards).filter((card) => card.code);
    expect(codeCards).toHaveLength(48);
    expect(codeCards.every((card) => Boolean(card.code?.starterCode) && Boolean(card.code?.solutionCode))).toBe(true);

    const ownerV4 = `0x${"ce".repeat(20)}`;
    const installed = await database.query<{ result: {
      projectId: Hex;
      projectKind: string;
      status: string;
      chapterCount: number;
      cardCount: number;
      idempotent: boolean;
    } }>("select public.install_card_pack_v1($1, $2::uuid, null) as result", [ownerV4, packVersionId]);
    expect(installed.rows[0]?.result).toMatchObject({
      projectKind: "PACK",
      status: "READY",
      chapterCount: 16,
      cardCount: 112,
      idempotent: false,
    });
    const counts = await database.query<{ chapter_count: number; card_count: number; workflow_job_count: number }>(`
      select
        (select count(*)::integer from public.chapters where project_id = $1) as chapter_count,
        (select count(*)::integer from public.knowledge_cards where project_id = $1) as card_count,
        (select count(*)::integer from public.workflow_jobs where project_id = $1) as workflow_job_count
    `, [installed.rows[0]!.result.projectId]);
    expect(counts.rows[0]).toEqual({ chapter_count: 16, card_count: 112, workflow_job_count: 0 });
  });

  it("publishes v5 authored reading blocks and preserves card anchors on install", async () => {
    const artifact = buildCardPackArtifact(await loadCardPackFixture("v5"));
    const published = await database.query<{ pack_version_id: string }>(
      "select public.publish_card_pack_v5($1::jsonb, $2::jsonb, $3, $4) as pack_version_id",
      [JSON.stringify(artifact.manifest), JSON.stringify(artifact.chapters), artifact.manifestHash, artifact.contentHash],
    );
    const packVersionId = published.rows[0]!.pack_version_id;
    const reading = await database.query<{ count: number; first_kind: string; first_text: string }>(`
      select count(*)::integer as count,
        min(kind) filter (where position = 0) as first_kind,
        min(text) filter (where position = 0) as first_text
      from public.card_pack_chapter_reading_blocks
      where pack_version_id = $1 and chapter_id = 0
    `, [packVersionId]);
    expect(reading.rows[0]).toMatchObject({ count: 12, first_kind: "heading" });
    expect(reading.rows[0]?.first_text).toContain("合约外壳");

    const ownerV5 = `0x${"dd".repeat(20)}`;
    const installed = await database.query<{ result: { projectId: Hex; status: string } }>(
      "select public.install_card_pack_v1($1, $2::uuid, null) as result",
      [ownerV5, packVersionId],
    );
    const cards = await database.query<{ content: { readingBlockId?: string } }>(`
      select content from public.knowledge_cards
      where project_id = $1 and chapter_id = 0 order by position
    `, [installed.rows[0]!.result.projectId]);
    expect(cards.rows).toHaveLength(7);
    expect(cards.rows.every((row) => typeof row.content.readingBlockId === "string")).toBe(true);
    const invalidMutation = database.query(
      "insert into public.card_pack_chapter_reading_blocks(pack_version_id, chapter_id, block_id, position, kind, text) values ($1, 0, 'late-block', 99, 'paragraph', 'late')",
      [packVersionId],
    );
    await expect(invalidMutation).rejects.toThrow(/immutable/u);
  });

  it("queues, retries, completes and recovers outline planning jobs", async () => {
    const source = intakeSource([
      { pageNumber: 1, text: "# 调用原理\n\n外部调用会把执行控制权交给未知代码。" },
    ]);
    const request = {
      project_id: workflowProjectId,
      owner_address: owner,
      client_request_id: "workflow-intake-1",
      title: "章节队列资料",
      goal: "理解可恢复的章节规划",
      source_hash: source.sourceHash,
      goal_hash: hashGoal("理解可恢复的章节规划"),
      source_filename: "workflow.pdf",
      source_mime_type: "application/pdf",
      source_page_count: 1,
      source_character_count: source.characterCount,
    };
    const blocks = source.blocks.map((block) => ({
      block_index: block.blockIndex,
      page_number: block.pageNumber,
      kind: block.kind,
      text: block.text,
      block_hash: block.blockHash,
      heading_level: block.headingLevel,
    }));
    await database.query(
      "select public.register_learning_project_source_v2($1::jsonb, $2::jsonb)",
      [JSON.stringify(request), JSON.stringify(blocks)],
    );

    const queued = await database.query<{ job_id: string }>(
      "select public.enqueue_outline_planning_v2($1, $2) as job_id",
      [workflowProjectId, owner],
    );
    const queuedAgain = await database.query<{ job_id: string }>(
      "select public.enqueue_outline_planning_v2($1, $2) as job_id",
      [workflowProjectId, owner],
    );
    const firstJobId = queued.rows[0]!.job_id;
    expect(queuedAgain.rows[0]?.job_id).toBe(firstJobId);

    const claimed = await database.query<{ job_id: string; status: string; attempt: number }>(
      "select job_id, status, attempt from public.claim_next_workflow_job_v2(array['PLAN_OUTLINE']::text[])",
    );
    expect(claimed.rows[0]).toEqual({ job_id: firstJobId, status: "RUNNING", attempt: 1 });
    await database.query("select public.retry_workflow_job_v2($1::uuid, $2)", [
      firstJobId,
      "temporary model failure",
    ]);
    const retried = await database.query<{ status: string; last_error: string }>(
      "select status, last_error from public.workflow_jobs where job_id = $1::uuid",
      [firstJobId],
    );
    expect(retried.rows[0]).toEqual({ status: "RETRYABLE", last_error: "temporary model failure" });

    await database.query("update public.workflow_jobs set available_at = now() where job_id = $1::uuid", [firstJobId]);
    const claimedAgain = await database.query<{ attempt: number }>(
      "select attempt from public.claim_next_workflow_job_v2(array['PLAN_OUTLINE']::text[])",
    );
    expect(claimedAgain.rows[0]?.attempt).toBe(2);
    await database.query("select public.complete_workflow_job_v2($1::uuid, $2::jsonb)", [
      firstJobId,
      JSON.stringify({ outlineVersion: 1, chapterCount: 1 }),
    ]);
    const completed = await database.query<{ status: string }>(
      "select status from public.workflow_jobs where job_id = $1::uuid",
      [firstJobId],
    );
    expect(completed.rows[0]?.status).toBe("SUCCEEDED");

    const stale = await database.query<{ job_id: string }>(
      "select public.enqueue_outline_planning_v2($1, $2) as job_id",
      [workflowProjectId, owner],
    );
    const staleJobId = stale.rows[0]!.job_id;
    await database.query("select * from public.claim_next_workflow_job_v2(array['PLAN_OUTLINE']::text[])");
    await database.query(
      "update public.workflow_jobs set attempt = 3, lease_until = now() - interval '1 second' where job_id = $1::uuid",
      [staleJobId],
    );
    await expect(database.query<{ recovered: number }>(
      "select public.recover_stale_workflow_jobs_v2() as recovered",
    )).resolves.toMatchObject({ rows: [{ recovered: 1 }] });
    const staleState = await database.query<{ status: string; project_status: string }>(`
      select jobs.status, projects.status as project_status
      from public.workflow_jobs as jobs
      join public.learning_projects as projects on projects.project_id = jobs.project_id
      where jobs.job_id = $1::uuid
    `, [staleJobId]);
    expect(staleState.rows[0]).toEqual({ status: "FAILED", project_status: "FAILED_RETRYABLE" });
  });

  it("keeps one intake request idempotent, versions its outline, and allows the same PDF in a new Project", async () => {
    const source = intakeSource([
      { pageNumber: 1, text: "# 第一章 原理\n\n外部调用把控制权交给未知代码，状态必须先更新。" },
      { pageNumber: 2, text: "# 第二章 防御\n\n检查条件、更新状态，最后执行外部交互。" },
    ]);
    const request = {
      project_id: projectId,
      owner_address: owner,
      client_request_id: "project-intake-1",
      title: "重入安全资料",
      goal: "理解原理与防御",
      source_hash: source.sourceHash,
      goal_hash: hashGoal("理解原理与防御"),
      source_filename: "security.pdf",
      source_mime_type: "application/pdf",
      source_page_count: 2,
      source_character_count: source.characterCount,
    };
    const blocks = source.blocks.map((block) => ({
      block_index: block.blockIndex,
      page_number: block.pageNumber,
      kind: block.kind,
      text: block.text,
      block_hash: block.blockHash,
      heading_level: block.headingLevel,
    }));
    const first = await database.query<{ project_id: Hex }>(
      "select public.register_learning_project_source_v2($1::jsonb, $2::jsonb) as project_id",
      [JSON.stringify(request), JSON.stringify(blocks)],
    );
    const retry = await database.query<{ project_id: Hex }>(
      "select public.register_learning_project_source_v2($1::jsonb, $2::jsonb) as project_id",
      [JSON.stringify(request), JSON.stringify(blocks)],
    );
    expect(first.rows[0]?.project_id).toBe(projectId);
    expect(retry.rows[0]?.project_id).toBe(projectId);

    const outline = planChaptersDeterministically(projectId, source.blocks);
    const items = outline.chapters.map((chapter) => ({
      item_id: `chapter-${chapter.chapterId}`,
      position: chapter.position,
      title: chapter.title,
      summary: chapter.summary,
      start_block: chapter.startBlock,
      end_block: chapter.endBlock,
      page_start: chapter.pageStart,
      page_end: chapter.pageEnd,
      source_hash: chapter.sourceHash,
      importance: chapter.importance,
      min_card_count: 3,
      target_card_count: 4,
      max_card_count: 6,
    }));
    const draft = await database.query<{ version: number }>(
      "select public.save_project_outline_draft_v2($1, $2, null, $3, 'deterministic-v2', $4::jsonb) as version",
      [projectId, owner, outline.outlineHash, JSON.stringify(items)],
    );
    expect(draft.rows[0]?.version).toBe(1);
    const beforeConfirmation = await database.query<{ chapters: number }>(
      "select count(*)::integer as chapters from public.chapters where project_id = $1",
      [projectId],
    );
    expect(beforeConfirmation.rows[0]?.chapters).toBe(0);

    const workPlan = planWorkUnits(projectId, outline.chapters, source.blocks);
    const chapters = outline.chapters.map((chapter) => ({
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
      min_card_count: 3,
      target_card_count: 4,
      max_card_count: 6,
    }));
    const workUnits = workPlan.workUnits.map((unit) => ({
      work_unit_id: unit.workUnitId,
      chapter_id: unit.chapterId,
      unit_index: unit.unitIndex,
      start_block: unit.startBlock,
      end_block: unit.endBlock,
      source_text: unit.sourceText,
      source_blocks: unit.sourceBlocks,
      source_unit_hash: unit.sourceUnitHash,
      manifest_proof: unit.manifestProof,
      card_minimum: unit.cardMinimum,
      card_target: unit.cardTarget,
      card_budget: unit.cardBudget,
    }));
    await database.query(
      "select public.confirm_project_outline_draft_v2($1, $2, 1, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)",
      [
        projectId,
        owner,
        outline.outlineHash,
        workPlan.workUnitManifestRoot,
        JSON.stringify(chapters),
        JSON.stringify(workUnits),
        JSON.stringify({ projectId, outlineVersion: 1 }),
      ],
    );
    const materialized = await database.query<{ status: string; chapters: number; work_units: number }>(`
      select projects.status,
        (select count(*)::integer from public.chapters where project_id = projects.project_id) as chapters,
        (select count(*)::integer from public.work_units where project_id = projects.project_id) as work_units
      from public.learning_projects as projects where project_id = $1
    `, [projectId]);
    expect(materialized.rows[0]).toEqual({
      status: "AWAITING_REGISTRY",
      chapters: outline.chapters.length,
      work_units: workPlan.workUnits.length,
    });

    const duplicateRequest = {
      ...request,
      project_id: duplicateSourceProjectId,
      client_request_id: "project-intake-duplicate-pdf",
    };
    const duplicate = await database.query<{ project_id: Hex }>(
      "select public.register_learning_project_source_v2($1::jsonb, $2::jsonb) as project_id",
      [JSON.stringify(duplicateRequest), JSON.stringify(blocks)],
    );
    expect(duplicate.rows[0]?.project_id).toBe(duplicateSourceProjectId);
    const duplicateProjects = await database.query<{ project_count: number; block_count: number }>(`
      select count(distinct projects.project_id)::integer as project_count,
        count(blocks.block_index)::integer as block_count
      from public.learning_projects as projects
      join public.source_blocks as blocks on blocks.project_id = projects.project_id
      where projects.owner_address = $1 and projects.source_hash = $2
    `, [owner, source.sourceHash]);
    expect(duplicateProjects.rows[0]).toEqual({
      project_count: 2,
      block_count: blocks.length * 2,
    });
  });

  it("keeps folder operations separate from source and outline commitments", async () => {
    const folder = await database.query<{ folder_id: string }>(
      "select public.create_project_folder_v2($1, $2, null) as folder_id",
      [owner, "安全资料"],
    );
    const folderId = folder.rows[0]!.folder_id;
    await database.query("select public.move_learning_project_to_folder_v2($1, $2, $3::uuid)", [
      owner,
      projectId,
      folderId,
    ]);
    const library = await database.query<{ result: { documents: Array<{ projectId: string; chapterCount: number }> } }>(
      "select public.get_document_library_v2($1, $2::uuid, now()) as result",
      [owner, folderId],
    );
    expect(library.rows[0]?.result.documents).toEqual([
      { projectId, projectKind: "UPLOAD", packVersionId: null, chapterCount: 2, readyChapterCount: 0, cardCount: 0, dueCount: 0, folderId, sourceFilename: "security.pdf", sourceMimeType: "application/pdf", sourcePageCount: 2, status: "AWAITING_REGISTRY", title: "重入安全资料", updatedAt: expect.any(String) },
    ]);
  });

  it("accepts Chapter quality-gate audit events", async () => {
    await expect(database.query(`
      insert into public.project_agent_events (
        project_id, agent_role, event_type, payload
      ) values ($1, 'chapter-quality-gate', 'CHAPTER_CANDIDATES_APPROVED', '{}'::jsonb)
    `, [projectId])).resolves.toBeDefined();
  });

  it("creates exact Runner jobs from Project and Work Unit state transitions", async () => {
    const pricedUnits = await database.query<{ work_unit_id: number }>(
      "select work_unit_id from public.work_units where project_id = $1 order by work_unit_id",
      [projectId],
    );
    const quotes = pricedUnits.rows.map(({ work_unit_id }) => ({
      work_unit_id,
      workload_score: 1,
      reward_tier: "S",
      reward_amount_wei: "1000",
    }));
    await database.query(
      "select public.mark_project_escrow_funded_v2($1, $2, $3, $4, $5, $6::jsonb, $7, $7, $8, 0, $9, 1)",
      [
        projectId,
        `0x${"22".repeat(20)}`,
        `0x${"33".repeat(20)}`,
        "work-unit-pricing-v1",
        `0x${"44".repeat(32)}`,
        JSON.stringify(quotes),
        quotes.length * 1000,
        quotes.length,
        `0x${"55".repeat(32)}`,
      ],
    );
    const generationJobs = await database.query<{
      kind: string;
      chapter_id: number | null;
      work_unit_id: number | null;
      status: string;
    }>(`
      select kind, chapter_id, work_unit_id, status
      from public.workflow_jobs
      where project_id = $1 and kind = 'GENERATE_WORK_UNIT'
      order by work_unit_id
    `, [projectId]);
    expect(generationJobs.rows).toHaveLength(pricedUnits.rows.length);
    expect(generationJobs.rows.every((job) => job.status === "QUEUED" && job.chapter_id !== null)).toBe(true);

    const firstJob = generationJobs.rows[0]!;
    const completedJob = generationJobs.rows.find((job) => job.work_unit_id !== firstJob.work_unit_id)!;
    const claimed = await database.query<{ status: string; worker_address: string }>(
      "select status, worker_address from public.claim_work_unit_for_workflow_v2($1, $2, $3)",
      [projectId, firstJob.work_unit_id, `0x${"11".repeat(20)}`],
    );
    expect(claimed.rows[0]).toMatchObject({ status: "GENERATING", worker_address: `0x${"11".repeat(20)}` });

    await database.query(
      "update public.work_units set status = 'RETRYABLE', attempt = 3 where project_id = $1 and work_unit_id = $2",
      [projectId, firstJob.work_unit_id],
    );
    const fourthAttempt = await database.query<{ status: string; attempt: number }>(
      "select status, attempt from public.claim_work_unit_for_workflow_v2($1, $2, $3)",
      [projectId, firstJob.work_unit_id, `0x${"11".repeat(20)}`],
    );
    expect(fourthAttempt.rows[0]).toMatchObject({ status: "GENERATING", attempt: 4 });

    await database.query(
      "select public.mark_work_unit_retryable_v2($1, $2, $3)",
      [projectId, firstJob.work_unit_id, "citation is outside the Blueprint Slot evidence"],
    );
    await database.query(
      "update public.workflow_jobs set status = 'RUNNING', attempt = 10 where project_id = $1 and kind = 'GENERATE_WORK_UNIT' and work_unit_id = $2",
      [projectId, firstJob.work_unit_id],
    );
    await database.query<{ failed: boolean }>(
      "select public.retry_workflow_job_v2(job_id, 'citation is outside the Blueprint Slot evidence') as failed from public.workflow_jobs where project_id = $1 and kind = 'GENERATE_WORK_UNIT' and work_unit_id = $2",
      [projectId, firstJob.work_unit_id],
    );
    await database.query(
      "update public.workflow_jobs set status = 'SUCCEEDED', completed_at = now() where project_id = $1 and kind = 'GENERATE_WORK_UNIT' and work_unit_id <> $2 and status = 'QUEUED'",
      [projectId, firstJob.work_unit_id],
    );
    const terminalFailure = await database.query<{ project_status: string; chapter_status: string }>(`
      select projects.status as project_status, chapters.status as chapter_status
      from public.learning_projects as projects
      join public.chapters as chapters on chapters.project_id = projects.project_id
      where projects.project_id = $1 and chapters.chapter_id = $2
    `, [projectId, firstJob.chapter_id]);
    expect(terminalFailure.rows[0]).toEqual({
      project_status: "FAILED_RETRYABLE",
      chapter_status: "FAILED_RETRYABLE",
    });
    await database.query(
      "update public.work_units set status = 'CANDIDATE_READY' where project_id = $1 and work_unit_id = $2",
      [projectId, completedJob.work_unit_id],
    );

    const recovered = await database.query<{ job_count: number }>(
      "select public.retry_failed_project_generation_v2($1, $2) as job_count",
      [projectId, owner],
    );
    expect(recovered.rows[0]?.job_count).toBe(1);
    const recoveredState = await database.query<{
      project_status: string;
      chapter_status: string;
      unit_status: string;
      unit_attempt: number;
      job_status: string;
      job_attempt: number;
    }>(`
      select projects.status as project_status, chapters.status as chapter_status,
        units.status as unit_status, units.attempt as unit_attempt,
        jobs.status as job_status, jobs.attempt as job_attempt
      from public.learning_projects as projects
      join public.chapters as chapters on chapters.project_id = projects.project_id and chapters.chapter_id = $2
      join public.work_units as units on units.project_id = projects.project_id and units.work_unit_id = $3
      join public.workflow_jobs as jobs on jobs.project_id = projects.project_id
        and jobs.kind = 'GENERATE_WORK_UNIT' and jobs.work_unit_id = units.work_unit_id
      where projects.project_id = $1
    `, [projectId, firstJob.chapter_id, firstJob.work_unit_id]);
    expect(recoveredState.rows[0]).toEqual({
      project_status: "GENERATING",
      chapter_status: "GENERATING",
      unit_status: "RETRYABLE",
      unit_attempt: 0,
      job_status: "QUEUED",
      job_attempt: 0,
    });
    const preservedCandidate = await database.query<{ status: string }>(
      "select status from public.work_units where project_id = $1 and work_unit_id = $2",
      [projectId, completedJob.work_unit_id],
    );
    expect(preservedCandidate.rows[0]?.status).toBe("CANDIDATE_READY");
    await database.query(
      "update public.work_units set status = 'QUEUED' where project_id = $1 and work_unit_id = $2",
      [projectId, completedJob.work_unit_id],
    );

    await database.query(
      "update public.work_units set status = 'CANDIDATE_READY' where project_id = $1",
      [projectId],
    );
    const qualityJobs = await database.query<{ kind: string; chapter_id: number }>(`
      select kind, chapter_id from public.workflow_jobs
      where project_id = $1 and kind = 'QUALITY_CHECK_CHAPTER' and status = 'QUEUED'
      order by chapter_id
    `, [projectId]);
    const chapterCount = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.chapters where project_id = $1",
      [projectId],
    );
    expect(qualityJobs.rows).toHaveLength(chapterCount.rows[0]!.count);

    const obsoleteClaims = await database.query<{ count: number }>(`
      select count(*)::integer as count
      from pg_proc as functions
      join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
      where namespaces.nspname = 'public'
        and functions.proname in (
          'claim_next_work_unit_v2',
          'recover_stale_work_units_v2',
          'claim_next_chapter_quality_check_v2',
          'claim_next_chapter_assembly_v2',
          'claim_next_project_finalization_v2',
          'claim_work_unit_reward_v2'
        )
    `);
    expect(obsoleteClaims.rows[0]?.count).toBe(0);

    const operations = await database.query<{ snapshot: unknown }>(
      "select public.get_workflow_operations_v2() as snapshot",
    );
    const snapshot = WorkflowOperationsSnapshotSchema.parse(operations.rows[0]?.snapshot);
    expect(snapshot.metrics.queuedJobs).toBeGreaterThan(0);
    expect(snapshot.jobs.some((job) => job.kind === "GENERATE_WORK_UNIT")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("source_text");
  });

  it("freezes only fully validated V3 Chapter designs before creating Work Units", async () => {
    const source = intakeSource([
      {
        pageNumber: 1,
        text: "# 重入防御\n\n外部调用会把执行控制权交给未知代码，并可能再次调用原合约。\n\n在外部交互之前更新状态可以降低重入风险。",
      },
    ]);
    const request = {
      project_id: designProjectId,
      owner_address: owner,
      client_request_id: "design-v3-intake-1",
      title: "设计质量资料",
      goal: "理解重入防御",
      source_hash: source.sourceHash,
      goal_hash: hashGoal("理解重入防御"),
      source_filename: "design.pdf",
      source_mime_type: "application/pdf",
      source_page_count: 1,
      source_character_count: source.characterCount,
    };
    const blocks = source.blocks.map((block) => ({
      block_index: block.blockIndex,
      page_number: block.pageNumber,
      kind: block.kind,
      text: block.text,
      block_hash: block.blockHash,
      heading_level: block.headingLevel,
    }));
    await database.query(
      "select public.register_learning_project_source_v2($1::jsonb, $2::jsonb)",
      [JSON.stringify(request), JSON.stringify(blocks)],
    );
    const outline = planChaptersDeterministically(designProjectId, source.blocks);
    const items = outline.chapters.map((chapter) => ({
      item_id: `chapter-${chapter.chapterId}`,
      position: chapter.position,
      title: chapter.title,
      summary: chapter.summary,
      start_block: chapter.startBlock,
      end_block: chapter.endBlock,
      page_start: chapter.pageStart,
      page_end: chapter.pageEnd,
      source_hash: chapter.sourceHash,
      importance: chapter.importance,
      min_card_count: 2,
      target_card_count: 3,
      max_card_count: 4,
    }));
    await database.query(
      "select public.save_project_outline_draft_v2($1, $2, null, $3, 'test-v3', $4::jsonb)",
      [designProjectId, owner, outline.outlineHash, JSON.stringify(items)],
    );
    await database.query(
      "select public.confirm_project_outline_design_v3($1, $2, 1, $3, $4::jsonb)",
      [designProjectId, owner, outline.outlineHash, JSON.stringify(items.map((item, chapterId) => ({
        ...item,
        chapter_id: chapterId,
      })))],
    );
    const initial = await database.query<{ status: string; chapters: number; work_units: number; jobs: number }>(`
      select projects.status,
        (select count(*)::integer from public.chapters where project_id = projects.project_id) as chapters,
        (select count(*)::integer from public.work_units where project_id = projects.project_id) as work_units,
        (select count(*)::integer from public.workflow_jobs where project_id = projects.project_id and kind = 'DESIGN_CHAPTER') as jobs
      from public.learning_projects as projects where projects.project_id = $1
    `, [designProjectId]);
    expect(initial.rows[0]).toEqual({ status: "DESIGNING_CARDS", chapters: 1, work_units: 0, jobs: 1 });

    const chapter = outline.chapters[0]!;
    const inventory = materializeChapterConceptInventory({
      projectId: designProjectId,
      chapterId: chapter.chapterId,
      outlineVersion: 1,
      sourceHash: chapter.sourceHash,
      concepts: [{
        name: "重入风险",
        importance: 5,
        learningObjective: "解释外部调用如何引入重入风险。",
        sourceBlockIndexes: [1],
        prerequisites: [],
        misconceptions: ["外部调用本身一定不安全。"],
      }],
    });
    const inventoryHash = hashChapterConceptInventoryV3(inventory);
    const blueprint = materializeCardBlueprint({
      projectId: designProjectId,
      chapterId: chapter.chapterId,
      outlineVersion: 1,
      inventoryHash,
      slots: [
        {
          conceptId: inventory.concepts[0]!.conceptId,
          type: "concept",
          objective: "解释重入发生的条件。",
          difficulty: 2,
          sourceBlockIndexes: [1],
          required: true,
        },
        {
          conceptId: inventory.concepts[0]!.conceptId,
          type: "misconception",
          objective: "纠正对外部调用风险的误解。",
          difficulty: 3,
          sourceBlockIndexes: [1],
          required: true,
        },
      ],
    });
    const blueprintHash = hashCardBlueprintV3(blueprint);
    const run = await database.query<{ design_run_id: string }>(
      "select public.start_chapter_design_v3($1, $2, 1) as design_run_id",
      [designProjectId, chapter.chapterId],
    );
    await database.query(
      "select public.complete_chapter_design_v3($1::uuid, $2::jsonb, $3::jsonb, $4, $5, 'test-v3', 'fake-model', '{}'::jsonb)",
      [run.rows[0]!.design_run_id, JSON.stringify(inventory), JSON.stringify(blueprint), inventoryHash, blueprintHash],
    );
    const freezeJob = await database.query<{ kind: string; status: string }>(`
      select kind, status from public.workflow_jobs
      where project_id = $1 and kind = 'FREEZE_PROJECT_DESIGN'
    `, [designProjectId]);
    expect(freezeJob.rows).toEqual([{ kind: "FREEZE_PROJECT_DESIGN", status: "QUEUED" }]);

    const plan = planBlueprintWorkUnits(designProjectId, outline.chapters, source.blocks, [blueprint]);
    const frozenDesignHash = hashFrozenProjectDesignV3({
      projectId: designProjectId,
      outlineVersion: 1,
      designs: [{ chapterId: chapter.chapterId, inventoryHash, blueprintHash }],
    });
    await database.query(
      "select public.freeze_project_design_v3($1, 1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb)",
      [
        designProjectId,
        plan.workUnitManifestRoot,
        JSON.stringify(plan.workUnits.map((unit) => ({
          work_unit_id: unit.workUnitId,
          chapter_id: unit.chapterId,
          unit_index: unit.unitIndex,
          start_block: unit.startBlock,
          end_block: unit.endBlock,
          source_text: unit.sourceText,
          source_blocks: unit.sourceBlocks,
          source_unit_hash: unit.sourceUnitHash,
          manifest_proof: unit.manifestProof,
          card_minimum: unit.cardMinimum,
          card_target: unit.cardTarget,
          card_budget: unit.cardBudget,
        }))),
        JSON.stringify(plan.slotAssignments.map((assignment) => ({
          slot_id: assignment.slotId,
          work_unit_id: assignment.workUnitId,
        }))),
        frozenDesignHash,
        JSON.stringify({ projectId: designProjectId, outlineVersion: 1 }),
      ],
    );
    const frozen = await database.query<{ status: string; work_units: number; assigned_slots: number }>(`
      select projects.status,
        (select count(*)::integer from public.work_units where project_id = projects.project_id) as work_units,
        (select count(*)::integer from public.card_blueprint_slots where project_id = projects.project_id and assigned_work_unit_id is not null) as assigned_slots
      from public.learning_projects as projects where project_id = $1
    `, [designProjectId]);
    expect(frozen.rows[0]).toEqual({ status: "AWAITING_REGISTRY", work_units: 1, assigned_slots: 2 });

    const workUnit = plan.workUnits[0]!;
    const drafts = blueprint.slots.map((slot) => {
      const evidence = source.blocks.find((block) => block.blockIndex === slot.sourceBlockIndexes[0])!;
      const content = {
        type: slot.type === "concept" ? "concept" as const : "qa" as const,
        question: `${slot.objective}？`,
        answer: evidence.text,
        keyPoint: slot.objective,
        source: { page: evidence.pageNumber, quote: evidence.text },
        tags: ["重入防御"],
        importance: 5,
        initialDifficulty: slot.difficulty,
      };
      const cardHash = hashKnowledgeCard(content);
      return {
        slotId: slot.slotId,
        content,
        cardHash,
        id: deriveCardIdV2(designProjectId, workUnit.chapterId, workUnit.workUnitId, cardHash),
      };
    });
    const cardTree = buildCardTree(drafts.map((draft) => draft.id));
    const candidates = drafts.map((draft) => ({
      slot_id: draft.slotId,
      card: {
        ...draft.content,
        id: draft.id,
        cardHash: draft.cardHash,
        projectId: designProjectId,
        chapterId: workUnit.chapterId,
        workUnitId: workUnit.workUnitId,
        workerProof: cardTree.cards.find((card) => card.cardId === draft.id)!.proof,
      },
    }));
    await database.query(
      "update public.learning_projects set status = 'GENERATING' where project_id = $1",
      [designProjectId],
    );
    await database.query(
      "update public.work_units set status = 'VALIDATING' where project_id = $1 and work_unit_id = $2",
      [designProjectId, workUnit.workUnitId],
    );

    await expect(database.query(
      "select public.save_work_unit_candidates_v3($1, $2, $3, 25, $4::jsonb)",
      [designProjectId, workUnit.workUnitId, cardTree.root, JSON.stringify(candidates.slice(0, 1))],
    )).rejects.toThrow(/every assigned Blueprint Slot/u);
    const afterRejectedSave = await database.query<{ status: string; candidates: number }>(`
      select units.status,
        (select count(*)::integer from public.card_slot_candidates where project_id = units.project_id) as candidates
      from public.work_units as units
      where units.project_id = $1 and units.work_unit_id = $2
    `, [designProjectId, workUnit.workUnitId]);
    expect(afterRejectedSave.rows[0]).toEqual({ status: "VALIDATING", candidates: 0 });

    await database.query(
      "select public.save_work_unit_candidates_v3($1, $2, $3, 25, $4::jsonb)",
      [designProjectId, workUnit.workUnitId, cardTree.root, JSON.stringify(candidates)],
    );
    const saved = await database.query<{
      status: string;
      card_count: number;
      cards_root: string;
      worker_card_count: number;
      candidate_count: number;
      min_revision: number;
      max_revision: number;
      ready_slots: number;
    }>(`
      select units.status, units.card_count, units.cards_root,
        jsonb_array_length(units.worker_cards) as worker_card_count,
        (select count(*)::integer from public.card_slot_candidates as candidates
          where candidates.project_id = units.project_id and candidates.work_unit_id = units.work_unit_id
        ) as candidate_count,
        (select min(candidate_revision)::integer from public.card_slot_candidates as candidates
          where candidates.project_id = units.project_id and candidates.work_unit_id = units.work_unit_id
        ) as min_revision,
        (select max(candidate_revision)::integer from public.card_slot_candidates as candidates
          where candidates.project_id = units.project_id and candidates.work_unit_id = units.work_unit_id
        ) as max_revision,
        (select count(*)::integer from public.card_blueprint_slots as slots
          where slots.project_id = units.project_id and slots.assigned_work_unit_id = units.work_unit_id
            and slots.status = 'CANDIDATE_READY'
        ) as ready_slots
      from public.work_units as units
      where units.project_id = $1 and units.work_unit_id = $2
    `, [designProjectId, workUnit.workUnitId]);
    expect(saved.rows[0]).toEqual({
      status: "CANDIDATE_READY",
      card_count: 2,
      cards_root: cardTree.root,
      worker_card_count: 2,
      candidate_count: 2,
      min_revision: 1,
      max_revision: 1,
      ready_slots: 2,
    });
    await expect(database.query(
      "update public.card_slot_candidates set card = '{}'::jsonb where project_id = $1",
      [designProjectId],
    )).rejects.toThrow(/immutable/u);

    await database.query(
      "update public.chapters set status = 'QUALITY_CHECK' where project_id = $1 and chapter_id = $2",
      [designProjectId, workUnit.chapterId],
    );
    const firstEvaluation = candidates.map((candidate, index) => ({
      slot_id: candidate.slot_id,
      card_id: candidate.card.id,
      candidate_revision: 1,
      verdict: index === 0 ? "APPROVED" : "REPAIR_REQUESTED",
      hard_failures: index === 0 ? [] : ["SEMANTIC_DUPLICATE"],
      rubric_scores: {
        cardId: candidate.card.id,
        citationSufficient: true,
        factuality: 4,
        learningValue: 4,
        clarity: 4,
        completeness: 4,
        citationRelevance: 4,
        difficultyFit: 5,
        verdict: index === 0 ? "ACCEPT" : "REPAIR",
        reasons: index === 0 ? [] : ["Candidate repeats another Slot."],
      },
    }));
    await database.query(
      "select public.request_chapter_slot_repairs_v3($1, $2, $3::uuid, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)",
      [
        designProjectId,
        workUnit.chapterId,
        run.rows[0]!.design_run_id,
        JSON.stringify(firstEvaluation),
        JSON.stringify([{ slot_id: candidates[1]!.slot_id, reason: "Semantic duplicate" }]),
        JSON.stringify({ passes: false, weightedCoverage: 1 }),
        JSON.stringify([{ leftCandidateId: candidates[0]!.card.id, rightCandidateId: candidates[1]!.card.id }]),
        "deterministic-test",
        "quality-v3-test-1",
      ],
    );
    const repairState = await database.query<{
      unit_status: string;
      accepted_slots: number;
      repair_slots: number;
      accepted_candidates: number;
      rejected_candidates: number;
      repair_reason: string;
    }>(`
      select units.status as unit_status,
        (select count(*)::integer from public.card_blueprint_slots
          where project_id = units.project_id and status = 'ACCEPTED') as accepted_slots,
        (select count(*)::integer from public.card_blueprint_slots
          where project_id = units.project_id and status = 'REPAIR_REQUESTED') as repair_slots,
        (select count(*)::integer from public.card_slot_candidates
          where project_id = units.project_id and status = 'ACCEPTED') as accepted_candidates,
        (select count(*)::integer from public.card_slot_candidates
          where project_id = units.project_id and status = 'REJECTED') as rejected_candidates,
        (select repair_reason from public.card_quality_evaluations
          where project_id = units.project_id and slot_id = $3
          order by created_at desc limit 1) as repair_reason
      from public.work_units as units where units.project_id = $1 and units.work_unit_id = $2
    `, [designProjectId, workUnit.workUnitId, candidates[1]!.slot_id]);
    expect(repairState.rows[0]).toEqual({
      unit_status: "REPAIRING",
      accepted_slots: 1,
      repair_slots: 1,
      accepted_candidates: 1,
      rejected_candidates: 1,
      repair_reason: "Semantic duplicate",
    });

    const repairedContent = {
      ...drafts[1]!.content,
      question: "怎样纠正对外部调用风险的误解？",
      keyPoint: "外部调用转移控制权，但风险取决于调用前后的状态处理",
    };
    const repairedHash = hashKnowledgeCard(repairedContent);
    const repairedId = deriveCardIdV2(
      designProjectId,
      workUnit.chapterId,
      workUnit.workUnitId,
      repairedHash,
    );
    const repairedTree = buildCardTree([repairedId]);
    const repairedCard = {
      ...repairedContent,
      id: repairedId,
      cardHash: repairedHash,
      projectId: designProjectId,
      chapterId: workUnit.chapterId,
      workUnitId: workUnit.workUnitId,
      workerProof: repairedTree.cards[0]!.proof,
    };
    await database.query(
      "update public.work_units set status = 'VALIDATING' where project_id = $1 and work_unit_id = $2",
      [designProjectId, workUnit.workUnitId],
    );
    await database.query(
      "select public.save_work_unit_candidates_v3($1, $2, $3, 30, $4::jsonb)",
      [
        designProjectId,
        workUnit.workUnitId,
        repairedTree.root,
        JSON.stringify([{ slot_id: candidates[1]!.slot_id, card: repairedCard }]),
      ],
    );

    const finalDraftCards = [candidates[0]!.card, repairedCard];
    const finalTree = buildCardTree(finalDraftCards.map((card) => card.id));
    const finalCards = finalDraftCards.map((card) => ({
      ...card,
      workerProof: finalTree.cards.find((entry) => entry.cardId === card.id)!.proof,
    }));
    await database.query(
      "update public.chapters set status = 'QUALITY_CHECK' where project_id = $1 and chapter_id = $2",
      [designProjectId, workUnit.chapterId],
    );
    await database.query(
      "select public.approve_chapter_candidates_v3($1, $2, $3::uuid, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)",
      [
        designProjectId,
        workUnit.chapterId,
        run.rows[0]!.design_run_id,
        JSON.stringify([
          { ...firstEvaluation[0], verdict: "APPROVED", hard_failures: [] },
          {
            slot_id: candidates[1]!.slot_id,
            card_id: repairedId,
            candidate_revision: 2,
            verdict: "APPROVED",
            hard_failures: [],
            rubric_scores: {
              cardId: repairedId,
              citationSufficient: true,
              factuality: 4,
              learningValue: 4,
              clarity: 4,
              completeness: 4,
              citationRelevance: 4,
              difficultyFit: 5,
              verdict: "ACCEPT",
              reasons: [],
            },
          },
        ]),
        JSON.stringify([{
          work_unit_id: workUnit.workUnitId,
          worker_cards: finalCards,
          cards_root: finalTree.root,
          card_count: finalCards.length,
        }]),
        JSON.stringify({ passes: true, weightedCoverage: 1 }),
        "[]",
        "deterministic-test",
        "quality-v3-test-1",
      ],
    );
    const approved = await database.query<{
      unit_status: string;
      accepted_slots: number;
      accepted_candidates: number;
      rejected_candidates: number;
      evaluations: number;
    }>(`
      select units.status as unit_status,
        (select count(*)::integer from public.card_blueprint_slots
          where project_id = units.project_id and status = 'ACCEPTED') as accepted_slots,
        (select count(*)::integer from public.card_slot_candidates
          where project_id = units.project_id and status = 'ACCEPTED') as accepted_candidates,
        (select count(*)::integer from public.card_slot_candidates
          where project_id = units.project_id and status = 'REJECTED') as rejected_candidates,
        (select count(*)::integer from public.card_quality_evaluations
          where project_id = units.project_id) as evaluations
      from public.work_units as units where units.project_id = $1 and units.work_unit_id = $2
    `, [designProjectId, workUnit.workUnitId]);
    expect(approved.rows[0]).toEqual({
      unit_status: "APPROVED",
      accepted_slots: 2,
      accepted_candidates: 2,
      rejected_candidates: 1,
      evaluations: 4,
    });

    const escrowAddress = `0x${"22".repeat(20)}`;
    const workerAddress = `0x${"33".repeat(20)}`;
    const fundingTxHash = `0x${"44".repeat(32)}`;
    const confirmationTxHash = `0x${"55".repeat(32)}`;
    const pricingRoot = `0x${"66".repeat(32)}`;
    await database.query(
      "update public.work_units set worker_address = $3 where project_id = $1 and work_unit_id = $2",
      [designProjectId, workUnit.workUnitId, workerAddress],
    );
    await database.query(
      "select public.mark_project_escrow_funded_v2($1, $2, $3, 'work-unit-pricing-v1', $4, $5::jsonb, 1000, 1000, 1, 0, $6, 100)",
      [
        designProjectId,
        escrowAddress,
        owner,
        pricingRoot,
        JSON.stringify([{
          work_unit_id: workUnit.workUnitId,
          workload_score: 9,
          reward_tier: "S",
          reward_amount_wei: "1000",
        }]),
        fundingTxHash,
      ],
    );
    await database.query(
      "select public.confirm_work_unit_and_enqueue_escrow_reward_v3($1, $2, $3, 101, 21000, 250)",
      [designProjectId, workUnit.workUnitId, confirmationTxHash],
    );
    const confirmed = await database.query<{
      unit_status: string;
      reward_status: string;
      reward_recipient: string;
      reward_amount: string;
    }>(`
      select units.status as unit_status,
        rewards.status as reward_status,
        rewards.recipient_address as reward_recipient,
        rewards.amount_wei::text as reward_amount
      from public.work_units as units
      join public.work_unit_rewards as rewards
        on rewards.project_id = units.project_id and rewards.work_unit_id = units.work_unit_id
      where units.project_id = $1 and units.work_unit_id = $2
    `, [designProjectId, workUnit.workUnitId]);
    expect(confirmed.rows).toEqual([{
      unit_status: "CONFIRMED",
      reward_status: "PENDING",
      reward_recipient: workerAddress,
      reward_amount: "1000",
    }]);
  });

  it("confirms legacy fixed-price Work Units after dynamic pricing is installed", async () => {
    const workerAddress = `0x${"33".repeat(20)}`;
    const confirmationTxHash = `0x${"77".repeat(32)}`;

    await database.exec("begin");
    try {
      await database.query(
        `insert into public.learning_projects (
           project_id, owner_address, title, goal, source_hash, goal_hash,
           outline_version, outline_hash, status, project_escrow_address,
           sponsor_treasury_address, reward_per_work_unit_wei,
           escrow_total_budget_wei, escrow_remaining_budget_wei,
           escrow_work_unit_count, escrow_settled_work_unit_count,
           escrow_funding_tx_hash, escrow_funded_block, escrow_state
         ) values (
           $1, $2, 'Legacy pricing fixture', 'Verify fixed pricing compatibility',
           $3, $4, 1, $5, 'FAILED_RETRYABLE', $6, $7, 1000, 1000, 1000, 1, 0, $8, 100, 'FUNDED'
         )`,
        [
          legacyPricingProjectId,
          owner,
          `0x${"11".repeat(32)}`,
          `0x${"22".repeat(32)}`,
          `0x${"33".repeat(32)}`,
          `0x${"55".repeat(20)}`,
          `0x${"66".repeat(20)}`,
          `0x${"88".repeat(32)}`,
        ],
      );
      await database.query(
        `insert into public.chapters (
           project_id, chapter_id, position, title, summary, start_block, end_block,
           page_start, page_end, source_hash, importance, status, min_card_count,
           target_card_count, max_card_count
         ) values ($1, 0, 0, 'Legacy chapter', 'Compatibility fixture', 0, 0, 1, 1, $2, 1, 'FAILED_RETRYABLE', 2, 2, 2)`,
        [legacyPricingProjectId, `0x${"99".repeat(32)}`],
      );
      await database.query(
        `insert into public.work_units (
           project_id, work_unit_id, chapter_id, unit_index, start_block, end_block,
           source_unit_hash, manifest_proof, card_budget, card_minimum, card_target,
           worker_address, status, worker_cards, cards_root, card_count
         ) values ($1, 0, 0, 0, 0, 0, $2, '[]'::jsonb, 1, 1, 1, $3, 'APPROVED', '[{}]'::jsonb, $4, 1)`,
        [legacyPricingProjectId, `0x${"aa".repeat(32)}`, workerAddress, `0x${"bb".repeat(32)}`],
      );
      await database.query(
        `insert into public.workflow_jobs (
           project_id, kind, chapter_id, work_unit_id, status, attempt, last_error, completed_at
         ) values ($1, 'GENERATE_WORK_UNIT', 0, 0, 'FAILED', 10,
           'quality-approved priced Work Unit confirmation target is missing', now())`,
        [legacyPricingProjectId],
      );

      const retried = await database.query<{ job_count: number }>(
        "select public.retry_failed_project_generation_v2($1, $2) as job_count",
        [legacyPricingProjectId, owner],
      );
      expect(retried.rows).toEqual([{ job_count: 1 }]);
      const recovered = await database.query<{
        project_status: string;
        unit_status: string;
        job_status: string;
      }>(`
        select projects.status as project_status, units.status as unit_status,
          jobs.status as job_status
        from public.learning_projects as projects
        join public.work_units as units on units.project_id = projects.project_id
        join public.workflow_jobs as jobs
          on jobs.project_id = units.project_id and jobs.work_unit_id = units.work_unit_id
        where projects.project_id = $1
      `, [legacyPricingProjectId]);
      expect(recovered.rows).toEqual([{
        project_status: "GENERATING",
        unit_status: "APPROVED",
        job_status: "QUEUED",
      }]);

      await database.query(
        "select public.confirm_work_unit_and_enqueue_escrow_reward_v3($1, 0, $2, 101, 21000, 250)",
        [legacyPricingProjectId, confirmationTxHash],
      );

      const confirmed = await database.query<{ unit_status: string; reward_amount: string }>(`
        select units.status as unit_status, rewards.amount_wei::text as reward_amount
        from public.work_units as units
        join public.work_unit_rewards as rewards
          on rewards.project_id = units.project_id and rewards.work_unit_id = units.work_unit_id
        where units.project_id = $1 and units.work_unit_id = 0
      `, [legacyPricingProjectId]);
      expect(confirmed.rows).toEqual([{ unit_status: "CONFIRMED", reward_amount: "1000" }]);
    } finally {
      await database.exec("rollback");
    }
  });

  it("returns bounded aggregate V3 quality operations without card or source content", async () => {
    const result = await database.query<{ report: unknown }>(
      "select public.get_learning_quality_operations_v3() as report",
    );
    const report = LearningQualityOperationsReportSchema.parse(result.rows[0]?.report);

    expect(report.chapters.some((chapter) => chapter.projectId === designProjectId)).toBe(true);
    expect(report.slots.some((slot) => slot.projectId === designProjectId && slot.status === "ACCEPTED")).toBe(true);
    expect(report.chapters.length).toBeLessThanOrEqual(384);
    expect(report.slots.length).toBeLessThanOrEqual(480);
    expect(JSON.stringify(report)).not.toContain("外部调用会");
    expect(JSON.stringify(report)).not.toContain("答案遗漏");
  });

  it("persists non-learning notice exclusions while confirming only learning Chapters", async () => {
    const source = intakeSource([
      { pageNumber: 1, text: "# 2026 年考纲变化\n\n新增考点：外部调用。" },
      { pageNumber: 2, text: "# 第一章 调用原理\n\n外部调用会转移执行控制权。" },
      { pageNumber: 3, text: "# 考试安排\n\n报名时间为 9 月 1 日，考试日期为 11 月 20 日。" },
      { pageNumber: 4, text: "# 第二章 防御顺序\n\n先更新状态，再执行外部调用。" },
    ]);
    const request = {
      project_id: relevanceProjectId,
      owner_address: owner,
      client_request_id: "outline-relevance-intake-1",
      title: "学习内容相关性",
      goal: "只保留可学习知识",
      source_hash: source.sourceHash,
      goal_hash: hashGoal("只保留可学习知识"),
      source_filename: "relevance.pdf",
      source_mime_type: "application/pdf",
      source_page_count: source.pageCount,
      source_character_count: source.characterCount,
    };
    await database.query(
      "select public.register_learning_project_source_v2($1::jsonb, $2::jsonb)",
      [JSON.stringify(request), JSON.stringify(source.blocks.map((block) => ({
        block_index: block.blockIndex,
        page_number: block.pageNumber,
        kind: block.kind,
        text: block.text,
        block_hash: block.blockHash,
        heading_level: block.headingLevel,
      })))],
    );
    const outline = planChaptersDeterministically(relevanceProjectId, source.blocks);
    const items = outline.chapters.map((chapter) => ({
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
      min_card_count: 2,
      target_card_count: 3,
      max_card_count: 4,
    }));
    const exclusions = outline.excludedRanges.map((range) => ({
      start_block: range.startBlock,
      end_block: range.endBlock,
      category: range.category,
      reason: range.reason,
    }));
    await database.query(
      "select public.save_project_outline_draft_v2($1, $2, null, $3, 'relevance-v4', $4::jsonb, $5::jsonb)",
      [relevanceProjectId, owner, outline.outlineHash, JSON.stringify(items), JSON.stringify(exclusions)],
    );
    const saved = await database.query<{ categories: string[] }>(`
      select array_agg(category order by exclusion_index) as categories
      from public.project_outline_exclusions
      where project_id = $1 and outline_version = 1
    `, [relevanceProjectId]);
    expect(saved.rows[0]?.categories).toEqual(expect.arrayContaining(["EXAM_UPDATE", "SCHEDULE_NOTICE"]));

    await database.query(
      "select public.confirm_project_outline_design_v3($1, $2, 1, $3, $4::jsonb)",
      [relevanceProjectId, owner, outline.outlineHash, JSON.stringify(items)],
    );
    const confirmed = await database.query<{ status: string; chapter_count: number }>(`
      select projects.status,
        (select count(*)::integer from public.chapters where project_id = projects.project_id) as chapter_count
      from public.learning_projects as projects where projects.project_id = $1
    `, [relevanceProjectId]);
    expect(confirmed.rows[0]).toEqual({ status: "DESIGNING_CARDS", chapter_count: 2 });
  });
});
