import {
  ChapterPlanningProposalSchema,
  SourceBlockSchema,
  classifySourceExclusions,
  mergeSourceExclusionRanges,
  planChapterCountBudget,
  planChaptersDeterministically,
  type ChapterPlanningProposal,
  type SourceBlock,
} from "@mindmark/shared";
import { z } from "zod";
import {
  DEFAULT_AI_TOOL_TIMEOUT_MS,
  type AgentToolCall,
  type AgentToolDefinition,
  type AgentTranscriptEntry,
  type ToolCallingModel,
} from "./runtime-types.js";
import {
  detectLearningOutputLanguage,
  learnerFacingLanguageIssues,
  learningOutputLanguageInstruction,
} from "./language-policy.js";

const EmptyArgumentsSchema = z.object({}).strict();
const ProposeArgumentsSchema = ChapterPlanningProposalSchema;

const plannerTools: AgentToolDefinition[] = [
  {
    name: "read_source_outline",
    description: "Read the ordered Source Blocks and learning goal. No raw IDs or hashes are writable.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_chapters",
    description: "Propose learner-facing chapter titles, summaries, and contiguous Source Block ranges.",
    parameters: {
      type: "object",
      required: ["chapters", "excludedRanges"],
      additionalProperties: false,
      properties: {
        chapters: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            required: ["title", "summary", "startBlock", "endBlock", "importance"],
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              startBlock: { type: "integer", minimum: 0 },
              endBlock: { type: "integer", minimum: 0 },
              importance: { type: "integer", minimum: 1, maximum: 5 },
            },
          },
        },
        excludedRanges: {
          type: "array",
          maxItems: 256,
          items: {
            type: "object",
            required: ["startBlock", "endBlock", "category", "reason"],
            additionalProperties: false,
            properties: {
              startBlock: { type: "integer", minimum: 0 },
              endBlock: { type: "integer", minimum: 0 },
              category: {
                type: "string",
                enum: [
                  "REPEATED_HEADER_FOOTER",
                  "PAGE_NUMBER",
                  "TABLE_OF_CONTENTS",
                  "COPYRIGHT",
                  "PROMOTIONAL",
                  "ADMINISTRATIVE",
                  "EXAM_UPDATE",
                  "VERSION_NOTICE",
                  "SCHEDULE_NOTICE",
                  "OTHER",
                ],
              },
              reason: { type: "string" },
            },
          },
        },
      },
    },
  },
];

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
    const languageInstruction = learningOutputLanguageInstruction(outputLanguage);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Chapter Planner timed out")),
      this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
    );
    timeout.unref();
    const transcript: AgentTranscriptEntry[] = [];
    let read = false;
    try {
      for (let index = 0; index < (this.options.maxToolCalls ?? 3); index += 1) {
        const call = await this.model.nextTool({
          system:
            `You are Mindmark's Chapter Planner. Account for every Source Block as either learner-facing Chapter content or an excluded non-learning range. Exclude repeated headers, footers, watermarks, page numbers, contents pages, copyright notices, promotional messages, administrative text, exam-syllabus changes, added or removed exam topics, score or question-format changes, schedules, registration notices, and course or document version updates. These notices must never become Chapters. A Chapter must contain real learnable knowledge and may span excluded blocks inside its range. Document headings are candidate boundaries, not automatic Chapters. Prefer coherent learning units over one Chapter per heading. Every non-excluded block must belong to exactly one ordered, non-overlapping Chapter. The initial Chapter budget is ${initialBudget.minChapters}-${initialBudget.maxChapters}, with a target of ${initialBudget.targetChapters}. Never exceed the budget returned by read_source_outline. ${languageInstruction} Never invent IDs, hashes, proofs, or transaction data.`,
          task: `Plan ${initialBudget.targetChapters} target Chapters (${initialBudget.minChapters}-${initialBudget.maxChapters} allowed) for Project ${input.projectId}. Learning goal: ${input.goal ?? "not specified"}`,
          tools: plannerTools,
          transcript,
          signal: input.signal ?? controller.signal,
        });
        let result: unknown;
        if (call.name === "read_source_outline") {
          EmptyArgumentsSchema.parse(call.arguments);
          read = true;
          result = {
            chapterBudget: initialBudget,
            outputLanguage,
            blocks: blocks.map((block) => ({
              blockIndex: block.blockIndex,
              pageNumber: block.pageNumber,
              kind: block.kind,
              text: block.text,
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
                  if (languageIssues.length > 0) {
                    result = {
                      accepted: false,
                      errors: languageIssues,
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
                  return proposal;
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

export function isChapterPlannerToolCall(call: AgentToolCall): boolean {
  return plannerTools.some((tool) => tool.name === call.name);
}
