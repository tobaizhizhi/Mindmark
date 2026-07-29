import {
  ChapterProposalListSchema,
  SourceBlockSchema,
  planChaptersDeterministically,
  type ChapterProposal,
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

const EmptyArgumentsSchema = z.object({}).strict();
const ProposeArgumentsSchema = z
  .object({ chapters: ChapterProposalListSchema })
  .strict();

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
      required: ["chapters"],
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
  }): Promise<ChapterProposal[]>;
}

export class DeterministicChapterPlanner implements ChapterPlanner {
  async plan(input: { projectId: `0x${string}`; blocks: SourceBlock[] }): Promise<ChapterProposal[]> {
    return planChaptersDeterministically(input.projectId, input.blocks).chapters.map((chapter) => ({
      title: chapter.title,
      summary: chapter.summary,
      startBlock: chapter.startBlock,
      endBlock: chapter.endBlock,
      importance: chapter.importance,
    }));
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
  }): Promise<ChapterProposal[]> {
    const blocks = SourceBlockSchema.array().min(1).parse(input.blocks);
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
            "You are Mindmark's Chapter Planner. Return only learner-facing chapter proposals. Use contiguous Source Block indices; never invent IDs, hashes, proofs, or transaction data. Cover every block exactly once.",
          task: `Plan chapters for Project ${input.projectId}. Learning goal: ${input.goal ?? "not specified"}`,
          tools: plannerTools,
          transcript,
          signal: input.signal ?? controller.signal,
        });
        let result: unknown;
        if (call.name === "read_source_outline") {
          EmptyArgumentsSchema.parse(call.arguments);
          read = true;
          result = {
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
              const proposals = ChapterProposalListSchema.parse(parsed.data.chapters);
              transcript.push({ call, result: { accepted: true, chapterCount: proposals.length } });
              return proposals;
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
