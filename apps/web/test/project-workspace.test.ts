import { describe, expect, it } from "vitest";
import {
  getProjectWorkspaceForOwner,
  type ProjectWorkspaceRow,
  type ProjectWorkspaceStore,
} from "@/lib/server/project-lifecycle/workspace";

const projectId = `0x${"51".repeat(32)}` as const;
const owner = `0x${"ab".repeat(20)}` as const;

const row: ProjectWorkspaceRow = {
  project_id: projectId,
  title: "Solidity 基础",
  goal: "掌握状态变量",
  status: "GENERATING",
  project_kind: "UPLOAD",
  pack_version_id: null,
  registry_version: 2,
  updated_at: "2026-08-03T10:00:00.000Z",
  source_filename: "solidity.pdf",
  source_storage_bucket: "learning-source-files",
  source_storage_path: null,
  source_file_sha256: null,
  source_file_size: null,
  source_file_status: "MISSING",
  chapters: [
    {
      chapter_id: 0,
      position: 0,
      title: "变量",
      summary: "状态变量与局部变量",
      page_start: 1,
      page_end: 3,
      importance: 5,
      status: "READY",
      card_blueprint_slots: [],
      knowledge_cards: [
        {
          card_id: `0x${"01".repeat(32)}`,
          card_learning_states: [{
            reps: 3,
            lapses: 0,
            due_at: "2026-08-03T09:00:00.000Z",
            last_reviewed_at: "2026-08-02T10:00:00.000Z",
          }],
        },
        { card_id: `0x${"02".repeat(32)}`, card_learning_states: [] },
      ],
    },
    {
      chapter_id: 1,
      position: 1,
      title: "函数",
      summary: "函数声明与可见性",
      page_start: 4,
      page_end: 7,
      importance: 4,
      status: "GENERATING",
      card_blueprint_slots: [],
      knowledge_cards: [{ card_id: `0x${"03".repeat(32)}`, card_learning_states: [] }],
    },
  ],
  workflow_jobs: [{
    job_id: "123e4567-e89b-42d3-a456-426614174000",
    kind: "GENERATE_WORK_UNIT",
    chapter_id: 1,
    status: "RUNNING",
    attempt: 1,
    last_error: null,
  }],
  chapter_design_runs: [
    { chapter_id: 0, status: "COMPLETED" },
    { chapter_id: 1, status: "COMPLETED" },
  ],
  work_units: [
    { work_unit_id: 0, chapter_id: 0, status: "CONFIRMED", attempt: 1 },
    { work_unit_id: 1, chapter_id: 1, status: "GENERATING", attempt: 1 },
  ],
  card_quality_evaluations: [],
};

describe("Project workspace", () => {
  it("derives the project, Chapter progress and lifecycle from one store read", async () => {
    let reads = 0;
    const store: ProjectWorkspaceStore = {
      async load() {
        reads += 1;
        return row;
      },
    };

    const workspace = await getProjectWorkspaceForOwner(
      projectId,
      owner,
      store,
      new Date("2026-08-03T10:00:00.000Z"),
    );

    expect(reads).toBe(1);
    expect(workspace.project).toMatchObject({
      chapterCount: 2,
      readyChapterCount: 1,
      cardCount: 3,
      dueCount: 1,
    });
    expect(workspace.chapters.chapters[0]).toMatchObject({
      cardCount: 2,
      studiedCount: 1,
      dueCount: 1,
      newCount: 1,
      masteredCount: 1,
      progressPercent: 50,
    });
    expect(workspace.progress).toMatchObject({
      stage: "GENERATING_CARDS",
      currentChapter: { chapterId: 1, title: "函数" },
      completedChapters: 1,
      phaseCounts: {
        generation: { completed: 1, total: 2 },
        qualityCheck: { completed: 1, total: 2 },
        assembly: { completed: 1, total: 2 },
      },
    });
  });
});
