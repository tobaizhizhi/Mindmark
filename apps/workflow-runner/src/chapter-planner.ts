import {
  analyzeChapterStructure,
  ChapterPlanningProposalSchema,
  SourceBlockSchema,
  chapterTitleQualityIssues,
  classifySourceExclusions,
  mergeSourceExclusionRanges,
  normalizeChapterTitle,
  planChapterCountBudget,
  planChaptersDeterministically,
  type ChapterPlanningProposal,
  type SourceBlock,
} from "@mindmark/shared";
import { z } from "zod";
import {
  DEFAULT_AI_TOOL_TIMEOUT_MS,
  type AgentTranscriptEntry,
  type ToolCallingModel,
} from "./runtime-types.js";
import { nextDomainTool } from "./model.js";
import {
  detectLearningOutputLanguage,
  learnerFacingLanguageIssues,
} from "./language-policy.js";

const EmptyArgumentsSchema = z.object({}).strict();
const ProposeArgumentsSchema = ChapterPlanningProposalSchema;

export interface ChapterPlanner {
  plan(input: {
    projectId: `0x${string}`;
    blocks: SourceBlock[];
    goal?: string | null;
    signal?: AbortSignal;
  }): Promise<ChapterPlanningProposal>;
}

export class DeterministicChapterPlanner implements ChapterPlanner {
  async plan(input: { projectId: `0x${string}`; blocks: SourceBlock[] }): Promise<ChapterPlanningProposal> {
    const outline = planChaptersDeterministically(input.projectId, input.blocks);
    return {
      chapters: outline.chapters.map((chapter) => ({
        title: chapter.title,
        summary: chapter.summary,
        startBlock: chapter.startBlock,
        endBlock: chapter.endBlock,
        importance: chapter.importance,
      })),
      excludedRanges: outline.excludedRanges,
    };
  }
}

export class AiChapterPlanner implements ChapterPlanner {
  constructor(
    private readonly model: ToolCallingModel,
    private readonly options: { maxToolCalls?: number; timeoutMs?: number } = {},
  ) {}

  async plan(input: {
    projectId: `0x${string}`;
    blocks: SourceBlock[];
    goal?: string | null;
    signal?: AbortSignal;
  }): Promise<ChapterPlanningProposal> {
    const blocks = SourceBlockSchema.array().min(1).parse(input.blocks);
    const protectedExclusions = classifySourceExclusions(blocks);
    const initialBudget = planChapterCountBudget(blocks, protectedExclusions);
    const outputLanguage = detectLearningOutputLanguage(blocks, [input.goal]);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Chapter Planner timed out")),
      this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
    );
    timeout.unref();
    const transcript: AgentTranscriptEntry[] = [];
    let read = false;
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    try {
      for (let index = 0; index < (this.options.maxToolCalls ?? 3); index += 1) {
        const call = await nextDomainTool(this.model, {
          agent: "outline-planning",
          context: {
            projectId: input.projectId,
            goal: input.goal ?? null,
            chapterBudget: initialBudget,
            outputLanguage,
          },
          transcript,
          signal,
          timeoutMs: this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
        });
        let result: unknown;
        if (call.name === "read_source_outline") {
          EmptyArgumentsSchema.parse(call.arguments);
          read = true;
          result = {
            chapterBudget: initialBudget,
            outputLanguage,
            structuralHints: analyzeChapterStructure(blocks, protectedExclusions),
            blocks: blocks.map((block) => ({
              blockIndex: block.blockIndex,
              pageNumber: block.pageNumber,
              kind: block.kind,
              text: block.text,
              headingLevel: block.headingLevel,
            })),
          };
        } else if (call.name === "propose_chapters") {
          if (!read) {
            result = { accepted: false, error: "read_source_outline must be called first" };
          } else {
            const parsed = ProposeArgumentsSchema.safeParse(call.arguments);
            if (!parsed.success) {
              result = { accepted: false, errors: parsed.error.issues.map((issue) => issue.message) };
            } else {
              const proposal = ChapterPlanningProposalSchema.parse(parsed.data);
              try {
                const effectiveExclusions = mergeSourceExclusionRanges(
                  protectedExclusions,
                  proposal.excludedRanges,
                  blocks.length,
                );
                const budget = planChapterCountBudget(blocks, effectiveExclusions);
                if (
                  proposal.chapters.length < budget.minChapters
                  || proposal.chapters.length > budget.maxChapters
                ) {
                  result = {
                    accepted: false,
                    error: `Chapter count ${proposal.chapters.length} is outside the allowed ${budget.minChapters}-${budget.maxChapters}; target ${budget.targetChapters}`,
                    chapterBudget: budget,
                  };
                } else {
                  const languageIssues = learnerFacingLanguageIssues(
                    proposal.chapters.flatMap((chapter, chapterIndex) => [
                      { field: `chapters[${chapterIndex}].title`, text: chapter.title },
                      { field: `chapters[${chapterIndex}].summary`, text: chapter.summary },
                    ]),
                    outputLanguage,
                  );
                  const titleIssues = proposal.chapters.flatMap((chapter, chapterIndex) =>
                    chapterTitleQualityIssues(chapter.title).map((issue) =>
                      `chapters[${chapterIndex}].title: ${issue}`,
                    ),
                  );
                  if (languageIssues.length > 0 || titleIssues.length > 0) {
                    result = {
                      accepted: false,
                      errors: [...languageIssues, ...titleIssues],
                      outputLanguage,
                    };
                    transcript.push({ call, result });
                    continue;
                  }
                  transcript.push({
                    call,
                    result: {
                      accepted: true,
                      chapterCount: proposal.chapters.length,
                      exclusionCount: proposal.excludedRanges.length,
                      chapterBudget: budget,
                    },
                  });
                  return {
                    ...proposal,
                    chapters: proposal.chapters.map((chapter) => ({
                      ...chapter,
                      title: normalizeChapterTitle(chapter.title),
                    })),
                  };
                }
              } catch (error) {
                result = {
                  accepted: false,
                  error: error instanceof Error ? error.message : "Chapter proposal is invalid",
                  chapterBudget: initialBudget,
                };
              }
            }
          }
        } else {
          result = { accepted: false, error: "Unknown Chapter Planner tool" };
        }
        transcript.push({ call, result });
      }
      throw new Error("Chapter Planner did not propose a valid outline");
    } finally {
      clearTimeout(timeout);
    }
  }
}
