import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

const projectId = `0x${"31".repeat(32)}` as Hex;
const cardId = `0x${"41".repeat(32)}` as Hex;
const owner = `0x${"51".repeat(20)}` as `0x${string}`;

const sourceFileQuery = {
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
};
sourceFileQuery.select.mockReturnValue(sourceFileQuery);
sourceFileQuery.eq.mockReturnValue(sourceFileQuery);
sourceFileQuery.maybeSingle.mockResolvedValue({
  data: {
    project_id: projectId,
    project_kind: "UPLOAD",
    source_filename: "solidity-notes.pdf",
    source_storage_bucket: "learning-source-files",
    source_storage_path: `${owner}/${projectId}/source.pdf`,
    source_file_sha256: "ab".repeat(32),
    source_file_size: 1_024,
    source_file_status: "READY",
  },
  error: null,
});
const supabase = {
  from: vi.fn(() => sourceFileQuery),
  storage: {
    from: vi.fn(() => ({
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://storage.example/signed-source.pdf" },
        error: null,
      }),
    })),
  },
};

vi.mock("@/lib/server/supabase", () => ({ getSupabaseAdmin: () => supabase }));

import { askChapterTutorForOwner, type ChapterTutorModel } from "@/lib/server/chapter-ai-tutor";
import { getProjectSourceFileForOwner } from "@/lib/server/project-files";
import { projectProgressFromState } from "@/lib/server/project-lifecycle/progress";
import { getChapterReadingForOwner, type ProjectReadingStore } from "@/lib/server/project-reading";
import {
  getChapterStudyForOwner,
  submitChapterReviewForOwner,
  type ProjectStudyStore,
} from "@/lib/server/project-study";
import type { SerializedFsrsCard } from "@/lib/server/fsrs";

const cardContent = {
  type: "qa" as const,
  question: "为什么外部调用前应先更新状态？",
  answer: "避免被调用合约重入时看到旧状态。",
  keyPoint: "遵循 Checks-Effects-Interactions。",
  source: {
    page: 7,
    quote: "在执行外部调用之前先更新合约状态，可以降低重入攻击利用旧状态的风险。",
  },
  tags: ["solidity", "reentrancy"],
  importance: 5,
  initialDifficulty: 3,
};

class DemoReadingStore implements ProjectReadingStore {
  async loadOwnedChapter(id: Hex, chapterId: number, address: `0x${string}`) {
    if (id !== projectId || chapterId !== 0 || address !== owner) return null;
    return {
      project_id: projectId,
      project_kind: "UPLOAD" as const,
      pack_version_id: null,
      title: "Solidity 安全",
      chapter_id: 0,
      chapter_title: "重入防御",
      start_block: 0,
      end_block: 1,
      page_start: 7,
      page_end: 7,
      pack_chapter_id: null,
    };
  }

  async loadUploadBlocks() {
    return [
      { block_index: 0, page_number: 7, kind: "heading" as const, text: "重入防御" },
      { block_index: 1, page_number: 7, kind: "paragraph" as const, text: cardContent.source.quote },
    ];
  }

  async loadPackBlocks() {
    return [];
  }

  async loadCards() {
    return [{ card_id: cardId, content: cardContent }];
  }
}

class DemoStudyStore implements ProjectStudyStore {
  submitted: Parameters<ProjectStudyStore["submitReview"]>[0] | null = null;

  async loadOwnedChapter(id: Hex, chapterId: number, address: `0x${string}`) {
    if (id !== projectId || chapterId !== 0 || address !== owner) return null;
    return {
      chapter: { project_id: projectId, chapter_id: 0, status: "READY" as const },
      cards: [{ card_id: cardId, position: 0, content: cardContent }],
      states: [],
    };
  }

  async loadCardState() {
    return null;
  }

  async submitReview(input: Parameters<ProjectStudyStore["submitReview"]>[0]) {
    this.submitted = input;
    return { accepted: true, duplicate: false, nextReviewAt: input.nextState.due };
  }

  async completeSession() {
    throw new Error("not used in this path");
  }
}

describe("automated upload Learning Project demo path", () => {
  it("keeps Progress, PDF, Tutor citations and Review on one owned Chapter contract", async () => {
    const progress = projectProgressFromState({
      project: { projectId, status: "READY", updatedAt: "2026-08-03T00:00:00.000Z" },
      chapters: [{ chapterId: 0, title: "重入防御", status: "READY" }],
      latestJob: null,
    });
    expect(progress).toMatchObject({ stage: "READY", progressPercent: 100, completedChapters: 1 });

    const sourceFile = await getProjectSourceFileForOwner(projectId, owner);
    expect(sourceFile).toMatchObject({
      available: true,
      status: "READY",
      url: "https://storage.example/signed-source.pdf",
    });

    const reading = await getChapterReadingForOwner(projectId, 0, owner, new DemoReadingStore());
    expect(reading.cardLinks).toEqual([{ cardId, blockId: "source-block-1", match: "QUOTE" }]);

    const tutor: ChapterTutorModel = {
      answer: vi.fn().mockResolvedValue({
        answer: "先更新状态会让重入调用只能观察到新状态。",
        citations: [{ blockId: "source-block-1", pageNumber: 999, quote: "untrusted model quote" }],
        suggestedQuestions: ["CEI 的三个阶段是什么？"],
      }),
    };
    const tutorResponse = await askChapterTutorForOwner(projectId, 0, owner, {
      question: "为什么先更新状态？",
      currentPage: 7,
      selectedText: "执行外部调用之前先更新合约状态",
      history: [],
    }, { model: tutor, loadReading: async () => reading });
    expect(tutorResponse.citations).toEqual([{
      blockId: "source-block-1",
      pageNumber: 7,
      quote: cardContent.source.quote,
    }]);
    expect(vi.mocked(tutor.answer).mock.calls[0]?.[0].context).toContain("source-block-1 | page=7");

    const studyStore = new DemoStudyStore();
    const study = await getChapterStudyForOwner(projectId, 0, owner, studyStore);
    expect(study.queue).toEqual([cardId]);
    const review = await submitChapterReviewForOwner(projectId, 0, owner, {
      sessionId: "00000000-0000-4000-8000-000000000001",
      cardId,
      rating: "good",
      responseMs: 1_200,
      reviewedAt: "2026-08-03T00:01:00.000Z",
    }, studyStore);
    expect(review).toMatchObject({ accepted: true, duplicate: false });
    expect((studyStore.submitted?.nextState as SerializedFsrsCard).reps).toBe(1);
  });
});
