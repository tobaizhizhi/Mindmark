import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  hashGoal,
  intakeSource,
  WorkflowOperationsSnapshotSchema,
  hashCardBlueprintV3,
  hashChapterConceptInventoryV3,
  hashFrozenProjectDesignV3,
  materializeCardBlueprint,
  materializeChapterConceptInventory,
  planBlueprintWorkUnits,
  planChaptersDeterministically,
  planWorkUnits,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const projectId = `0x${"77".repeat(32)}` as Hex;
const workflowProjectId = `0x${"88".repeat(32)}` as Hex;
const designProjectId = `0x${"99".repeat(32)}` as Hex;
const owner = `0x${"aa".repeat(20)}`;
let database: PGlite;

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
  ]) {
    await database.exec(await readFile(path.join(root, "supabase/migrations", migration), "utf8"));
  }
});

afterAll(async () => database.close());

describe("V2 database baseline", () => {
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
          'card_blueprint_slots', 'card_quality_evaluations', 'knowledge_card_feedback'
        )
    `);
    expect(result.rows).toHaveLength(21);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const policies = await database.query<{ count: number }>(
      "select count(*)::integer as count from pg_policies where schemaname = 'public'",
    );
    expect(policies.rows[0]?.count).toBe(0);
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

  it("keeps one source idempotent, versions its outline, and only materializes Chapters on confirmation", async () => {
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
      { projectId, chapterCount: 2, readyChapterCount: 0, cardCount: 0, dueCount: 0, folderId, sourceFilename: "security.pdf", sourceMimeType: "application/pdf", sourcePageCount: 2, status: "AWAITING_REGISTRY", title: "重入安全资料", updatedAt: expect.any(String) },
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
    await database.query(
      "update public.learning_projects set status = 'GENERATING' where project_id = $1",
      [projectId],
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
    const unitCount = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.work_units where project_id = $1",
      [projectId],
    );
    expect(generationJobs.rows).toHaveLength(unitCount.rows[0]!.count);
    expect(generationJobs.rows.every((job) => job.status === "QUEUED" && job.chapter_id !== null)).toBe(true);

    const firstJob = generationJobs.rows[0]!;
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
        text: "# 重入防御\n\n外部调用会把执行控制权交给未知代码。\n\n在外部交互之前更新状态可以降低重入风险。",
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
  });
});
