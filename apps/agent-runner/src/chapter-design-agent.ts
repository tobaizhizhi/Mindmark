import {
  CardBlueprintSlotProposalSchema,
  ChapterConceptProposalListSchema,
  hashCardBlueprintV3,
  hashChapterConceptInventoryV3,
  materializeCardBlueprint,
  materializeChapterConceptInventory,
  validateCardBlueprint,
  validateChapterConceptInventory,
  type CardBlueprint,
  type ChapterConceptInventory,
} from "@mindmark/shared";
import { z } from "zod";
import {
  DEFAULT_AI_TOOL_TIMEOUT_MS,
  type AgentToolDefinition,
  type AgentTranscriptEntry,
  type ToolCallingModel,
} from "./runtime-types.js";
import type { ChapterDesignRepositoryV3, ChapterDesignSourceV3 } from "./types-v2.js";

const EmptyArgumentsSchema = z.object({}).strict();
const ProposeInventoryArgumentsSchema = z.object({
  concepts: ChapterConceptProposalListSchema,
}).strict();
const ProposeBlueprintArgumentsSchema = z.object({
  slots: CardBlueprintSlotProposalSchema.array().min(1).max(30),
}).strict();

const chapterDesignTools: AgentToolDefinition[] = [
  {
    name: "read_chapter_design_context",
    description: "Read only the confirmed Chapter source, learning goal, and card-design rules.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_chapter_concepts",
    description: "Propose source-grounded learning concepts. Do not provide IDs, hashes, statuses, wallet, or transaction fields.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["concepts"],
      properties: {
        concepts: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "importance", "learningObjective", "sourceBlockIndexes", "prerequisites", "misconceptions"],
            properties: {
              name: { type: "string" },
              importance: { type: "integer", minimum: 1, maximum: 5 },
              learningObjective: { type: "string" },
              sourceBlockIndexes: { type: "array", minItems: 1, items: { type: "integer", minimum: 0 } },
              prerequisites: { type: "array", items: { type: "string" } },
              misconceptions: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
  {
    name: "propose_card_blueprint",
    description: "Map the accepted concept IDs to cited card slots. Important concepts need required slots; important misconceptions need a required misconception slot.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slots"],
      properties: {
        slots: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["conceptId", "type", "objective", "difficulty", "sourceBlockIndexes", "required"],
            properties: {
              conceptId: { type: "string" },
              type: { enum: ["concept", "comparison", "process", "application", "misconception"] },
              objective: { type: "string" },
              difficulty: { type: "integer", minimum: 1, maximum: 5 },
              sourceBlockIndexes: { type: "array", minItems: 1, items: { type: "integer", minimum: 0 } },
              required: { type: "boolean" },
            },
          },
        },
      },
    },
  },
];

function issuesOf(error: unknown): string[] {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message);
  return [error instanceof Error ? error.message : "Chapter Design validation failed"];
}

export type DesignedChapter = {
  inventory: ChapterConceptInventory;
  blueprint: CardBlueprint;
  inventoryHash: `0x${string}`;
  blueprintHash: `0x${string}`;
};

/** AI-internal graph with explicit, bounded repair loops and no durable state. */
export class ChapterDesignModule {
  constructor(
    private readonly model: ToolCallingModel,
    private readonly options: { maxToolCalls?: number; timeoutMs?: number } = {},
  ) {}

  async design(source: ChapterDesignSourceV3): Promise<DesignedChapter> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Chapter Design timed out")),
      this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
    );
    timeout.unref();
    const transcript: AgentTranscriptEntry[] = [];
    let read = false;
    let inventory: ChapterConceptInventory | null = null;
    let inventoryHash: `0x${string}` | null = null;
    let inventoryRepairCount = 0;
    let blueprintRepairCount = 0;
    try {
      for (let index = 0; index < (this.options.maxToolCalls ?? 8); index += 1) {
        const call = await this.model.nextTool({
          system: [
            "You are Mindmark's Chapter Design Agent.",
            "First identify the concepts a learner must master; then design cited card slots for them.",
            "Use only assigned Source Blocks. Do not write learner cards yet.",
            "Never invent IDs, hashes, status, wallet, proofs, or transaction fields.",
          ].join(" "),
          task: `Design learning coverage for Chapter ${source.chapter.chapterId}: ${source.chapter.title}. Learning goal: ${source.goal ?? "not specified"}.`,
          tools: chapterDesignTools,
          transcript,
          signal: controller.signal,
        });
        let result: unknown;
        if (call.name === "read_chapter_design_context") {
          EmptyArgumentsSchema.parse(call.arguments);
          read = true;
          result = {
            chapter: {
              chapterId: source.chapter.chapterId,
              title: source.chapter.title,
              summary: source.chapter.summary,
              sourceRange: [source.chapter.startBlock, source.chapter.endBlock],
            },
            policy: {
              importantConceptNeedsRequiredSlot: true,
              importantMisconceptionNeedsRequiredSlot: true,
              cardTypes: ["concept", "comparison", "process", "application", "misconception"],
            },
            blocks: source.sourceBlocks.map((block) => ({
              blockIndex: block.blockIndex,
              pageNumber: block.pageNumber,
              kind: block.kind,
              text: block.text,
            })),
          };
        } else if (call.name === "propose_chapter_concepts") {
          if (!read) {
            result = { accepted: false, errors: ["read_chapter_design_context must be called first"] };
          } else {
            try {
              const proposals = ProposeInventoryArgumentsSchema.parse(call.arguments).concepts;
              const candidate = materializeChapterConceptInventory({
                projectId: source.projectId,
                chapterId: source.chapter.chapterId,
                outlineVersion: source.outlineVersion,
                sourceHash: source.chapter.sourceHash,
                concepts: proposals,
              });
              inventory = validateChapterConceptInventory(candidate, source.chapter, source.sourceBlocks);
              inventoryHash = hashChapterConceptInventoryV3(inventory);
              result = {
                accepted: true,
                concepts: inventory.concepts.map((concept) => ({
                  conceptId: concept.conceptId,
                  name: concept.name,
                  importance: concept.importance,
                  learningObjective: concept.learningObjective,
                  sourceBlockIndexes: concept.sourceBlockIndexes,
                  misconceptions: concept.misconceptions,
                })),
              };
            } catch (error) {
              inventoryRepairCount += 1;
              if (inventoryRepairCount > 1) throw new Error(`Chapter Concept Inventory repair exhausted: ${issuesOf(error).join("; ")}`);
              result = { accepted: false, errors: issuesOf(error) };
            }
          }
        } else if (call.name === "propose_card_blueprint") {
          if (!inventory || !inventoryHash) {
            result = { accepted: false, errors: ["propose_chapter_concepts must be accepted first"] };
          } else {
            try {
              const proposals = ProposeBlueprintArgumentsSchema.parse(call.arguments).slots;
              const candidate = materializeCardBlueprint({
                projectId: source.projectId,
                chapterId: source.chapter.chapterId,
                outlineVersion: source.outlineVersion,
                inventoryHash,
                slots: proposals,
              });
              const blueprint = validateCardBlueprint(candidate, inventory, source.chapter);
              transcript.push({ call, result: { accepted: true, slotCount: blueprint.slots.length } });
              return {
                inventory,
                blueprint,
                inventoryHash,
                blueprintHash: hashCardBlueprintV3(blueprint),
              };
            } catch (error) {
              blueprintRepairCount += 1;
              if (blueprintRepairCount > 1) throw new Error(`Card Blueprint repair exhausted: ${issuesOf(error).join("; ")}`);
              result = { accepted: false, errors: issuesOf(error) };
            }
          }
        } else {
          result = { accepted: false, errors: ["Unknown Chapter Design tool"] };
        }
        transcript.push({ call, result });
      }
      throw new Error("Chapter Design did not produce a valid Card Blueprint");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ChapterDesignWorkflowAgent {
  private readonly designModule: ChapterDesignModule;

  constructor(
    private readonly repository: ChapterDesignRepositoryV3,
    model: ToolCallingModel,
    private readonly options: { timeoutMs?: number; promptVersion?: string; modelId?: string } = {},
  ) {
    this.designModule = new ChapterDesignModule(model, { timeoutMs: options.timeoutMs });
  }

  async runClaimed(input: { projectId: `0x${string}`; chapterId: number }): Promise<{
    state: "DESIGNED" | "ALREADY_DESIGNED";
    designRunId: string;
  }> {
    const source = await this.repository.loadChapterDesignSource(input.projectId, input.chapterId);
    const run = await this.repository.startChapterDesign(
      source.projectId,
      source.chapter.chapterId,
      source.outlineVersion,
    );
    if (run.status === "COMPLETED") return { state: "ALREADY_DESIGNED", designRunId: run.designRunId };
    try {
      const startedAt = performance.now();
      const design = await this.designModule.design(source);
      await this.repository.completeChapterDesign({
        designRunId: run.designRunId,
        ...design,
        promptVersion: this.options.promptVersion ?? "chapter-design-v3.0.0",
        modelId: this.options.modelId ?? "configured-model",
        metrics: {
          conceptCount: design.inventory.concepts.length,
          slotCount: design.blueprint.slots.length,
          durationMs: Math.round(performance.now() - startedAt),
        },
      });
      return { state: "DESIGNED", designRunId: run.designRunId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chapter Design failed";
      await this.repository.failChapterDesign(run.designRunId, message, /repair exhausted/u.test(message));
      throw error;
    }
  }
}
