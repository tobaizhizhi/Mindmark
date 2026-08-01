import {
  materializeChapterOutline,
  planChapterCardPolicy,
  planChaptersDeterministically,
  classifySourceExclusions,
  filterExcludedSourceBlocks,
  mergeSourceExclusionRanges,
  type SourceExclusionRange,
} from "@mindmark/shared";
import { AiChapterPlanner } from "./chapter-planner.js";
import type { ToolCallingModel } from "./runtime-types.js";
import type { WorkflowJobRepositoryV2 } from "./types-v2.js";

function outlineChapterRows(
  chapters: ReturnType<typeof planChaptersDeterministically>["chapters"],
  sourceBlocks: import("@mindmark/shared").SourceBlock[],
  excludedRanges: SourceExclusionRange[],
) {
  return chapters.map((chapter) => {
    const policy = planChapterCardPolicy(
      chapter,
      filterExcludedSourceBlocks(
        sourceBlocks.slice(chapter.startBlock, chapter.endBlock + 1),
        excludedRanges,
      ),
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
      let plannerVersion = "semantic-relevance-v6";
      let outline;
      try {
        const proposal = await this.planner.plan({
          projectId: source.projectId,
          blocks: source.sourceBlocks,
          goal: source.goal,
        });
        const protectedExclusions = classifySourceExclusions(source.sourceBlocks);
        const excludedRanges = mergeSourceExclusionRanges(
          protectedExclusions,
          proposal.excludedRanges,
          source.sourceBlocks.length,
        );
        outline = materializeChapterOutline(
          source.projectId,
          source.sourceBlocks,
          proposal.chapters,
          nextVersion,
          excludedRanges,
        );
      } catch (error) {
        console.warn(
          "Chapter Planner failed; using deterministic outline:",
          error instanceof Error ? error.message : "unknown error",
        );
        plannerVersion = "relevance-deterministic-v6";
        outline = planChaptersDeterministically(source.projectId, source.sourceBlocks, nextVersion);
      }
      const outlineVersion = await this.repository.saveProjectOutlineDraft({
        projectId: source.projectId,
        ownerAddress: source.ownerAddress,
        expectedHeadVersion: source.headVersion,
        outlineHash: outline.outlineHash,
        plannerVersion,
        chapters: outlineChapterRows(outline.chapters, source.sourceBlocks, outline.excludedRanges),
        exclusions: outline.excludedRanges.map((range) => ({
          start_block: range.startBlock,
          end_block: range.endBlock,
          category: range.category,
          reason: range.reason,
        })),
      });
      await this.repository.completeWorkflowJob(job.jobId, {
        outlineVersion,
        outlineHash: outline.outlineHash,
        chapterCount: outline.chapters.length,
        exclusionCount: outline.excludedRanges.length,
        plannerVersion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Outline planning failed";
      await this.repository.retryWorkflowJob(job.jobId, message);
    }
    return true;
  }
}
