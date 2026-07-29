import {
  materializeChapterOutline,
  planChapterCardPolicy,
  planChaptersDeterministically,
} from "@mindmark/shared";
import { AiChapterPlanner } from "./chapter-planner.js";
import type { ToolCallingModel } from "./runtime-types.js";
import type { WorkflowJobRepositoryV2 } from "./types-v2.js";

function outlineChapterRows(
  chapters: ReturnType<typeof planChaptersDeterministically>["chapters"],
  sourceBlocks: import("@mindmark/shared").SourceBlock[],
) {
  return chapters.map((chapter) => {
    const policy = planChapterCardPolicy(
      chapter,
      sourceBlocks.slice(chapter.startBlock, chapter.endBlock + 1),
    );
    return {
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
      min_card_count: policy.minCardCount,
      target_card_count: policy.targetCardCount,
      max_card_count: policy.maxCardCount,
      card_policy_version: policy.policyVersion,
    };
  });
}

export class OutlinePlanningAgent {
  private readonly planner: AiChapterPlanner;

  constructor(
    private readonly repository: WorkflowJobRepositoryV2,
    model: ToolCallingModel,
    options: { timeoutMs?: number } = {},
  ) {
    this.planner = new AiChapterPlanner(model, options);
  }

  async runNext(): Promise<boolean> {
    const job = await this.repository.claimNextWorkflowJob(["PLAN_OUTLINE"]);
    if (!job) return false;

    try {
      const source = await this.repository.loadOutlinePlanningSource(job.projectId);
      const nextVersion = (source.headVersion ?? 0) + 1;
      let plannerVersion = "semantic-with-deterministic-fallback-v2";
      let outline;
      try {
        const proposals = await this.planner.plan({
          projectId: source.projectId,
          blocks: source.sourceBlocks,
          goal: source.goal,
        });
        outline = materializeChapterOutline(
          source.projectId,
          source.sourceBlocks,
          proposals,
          nextVersion,
        );
      } catch (error) {
        console.warn(
          "Chapter Planner failed; using deterministic outline:",
          error instanceof Error ? error.message : "unknown error",
        );
        plannerVersion = "hierarchical-deterministic-v2";
        outline = planChaptersDeterministically(source.projectId, source.sourceBlocks, nextVersion);
      }
      const outlineVersion = await this.repository.saveProjectOutlineDraft({
        projectId: source.projectId,
        ownerAddress: source.ownerAddress,
        expectedHeadVersion: source.headVersion,
        outlineHash: outline.outlineHash,
        plannerVersion,
        chapters: outlineChapterRows(outline.chapters, source.sourceBlocks),
      });
      await this.repository.completeWorkflowJob(job.jobId, {
        outlineVersion,
        outlineHash: outline.outlineHash,
        chapterCount: outline.chapters.length,
        plannerVersion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Outline planning failed";
      await this.repository.retryWorkflowJob(job.jobId, message);
    }
    return true;
  }
}
