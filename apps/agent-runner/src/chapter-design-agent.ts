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
  type CardBlueprintSlotProposal,
  type ChapterConceptProposal,
  type ChapterConceptInventory,
  type SourceBlock,
} from "@mindmark/shared";
import { z } from "zod";
import {
  DEFAULT_AI_TOOL_TIMEOUT_MS,
  type AgentToolDefinition,
  type AgentTranscriptEntry,
  type ToolCallingModel,
} from "./runtime-types.js";
import type { ChapterDesignRepositoryV3, ChapterDesignSourceV3 } from "./types-v2.js";
import {
  detectLearningOutputLanguage,
  learnerFacingLanguageIssues,
  learningOutputLanguageInstruction,
  type LearningOutputLanguage,
} from "./language-policy.js";
import { expandBlueprintEvidenceBlockIndexes } from "./blueprint-evidence.js";

const ProposeInventoryArgumentsSchema = z.object({
  concepts: ChapterConceptProposalListSchema,
}).strict();
const ProposeBlueprintArgumentsSchema = z.object({
  slots: CardBlueprintSlotProposalSchema.array().min(1).max(30),
}).strict();

const chapterDesignTools: AgentToolDefinition[] = [
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

function sampleEvenly<T>(values: readonly T[], count: number): T[] {
  if (count >= values.length) return [...values];
  if (count <= 1) return [values[Math.floor((values.length - 1) / 2)]!];
  return Array.from({ length: count }, (_, index) =>
    values[Math.round((index * (values.length - 1)) / (count - 1))]!,
  );
}

function compactConceptName(
  block: SourceBlock,
  ordinal: number,
  language: LearningOutputLanguage,
): string {
  const withoutFence = block.text
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^```[^\n]*\n?/u, "")
    .trim();
  const firstSentence = withoutFence.split(/(?:[。！？.!?]\s*|\n)/u)[0]?.trim() ?? "";
  const limit = language === "zh-CN" ? 48 : 80;
  if (firstSentence.length >= 2) return firstSentence.slice(0, limit);
  return language === "zh-CN" ? `核心要点 ${ordinal + 1}` : `Core point ${ordinal + 1}`;
}

function selectConceptBlocks(source: ChapterDesignSourceV3, count: number): SourceBlock[] {
  const chapterTitle = source.chapter.title.replace(/^#{1,6}\s+/u, "").trim().toLocaleLowerCase();
  const headings = source.sourceBlocks.filter((block) =>
    block.kind === "heading"
    && block.text.replace(/^#{1,6}\s+/u, "").trim().toLocaleLowerCase() !== chapterTitle,
  );
  const selected = sampleEvenly(headings, Math.min(count, headings.length));
  if (selected.length < count) {
    const selectedIndexes = new Set(selected.map((block) => block.blockIndex));
    const remaining = source.sourceBlocks.filter((block) => !selectedIndexes.has(block.blockIndex));
    selected.push(...sampleEvenly(remaining, Math.min(count - selected.length, remaining.length)));
  }
  return selected.sort((left, right) => left.blockIndex - right.blockIndex);
}

/** Keeps the workflow moving when the external model gateway is unavailable or too slow. */
export function buildDeterministicChapterDesign(source: ChapterDesignSourceV3): DesignedChapter {
  const outputLanguage = detectLearningOutputLanguage(source.sourceBlocks, [
    source.goal,
    source.chapter.title,
    source.chapter.summary,
  ]);
  const slotCount = source.cardPolicy.targetCardCount;
  const conceptCount = Math.min(source.sourceBlocks.length, slotCount, Math.max(1, Math.ceil(slotCount / 2)), 6);
  const anchors = selectConceptBlocks(source, conceptCount);
  const usedNames = new Set<string>();
  const concepts: ChapterConceptProposal[] = anchors.map((block, index) => {
    const baseName = compactConceptName(block, index, outputLanguage);
    const normalised = baseName.toLocaleLowerCase();
    const name = usedNames.has(normalised)
      ? `${baseName.slice(0, 150)} (${index + 1})`
      : baseName;
    usedNames.add(name.toLocaleLowerCase());
    return {
      name,
      importance: Math.max(3, Math.min(5, source.chapter.importance - (index === 0 ? 0 : 1))),
      learningObjective: outputLanguage === "zh-CN"
        ? `理解“${name}”的核心原理，并能依据资料进行解释与应用。`
        : `Understand the core principles of ${name} and explain and apply them from the source.`,
      sourceBlockIndexes: expandBlueprintEvidenceBlockIndexes(
        [block.blockIndex],
        source.sourceBlocks,
      ),
      prerequisites: [],
      misconceptions: [],
    };
  });
  const inventory = validateChapterConceptInventory(materializeChapterConceptInventory({
    projectId: source.projectId,
    chapterId: source.chapter.chapterId,
    outlineVersion: source.outlineVersion,
    sourceHash: source.chapter.sourceHash,
    concepts,
  }), source.chapter, source.sourceBlocks);
  const inventoryHash = hashChapterConceptInventoryV3(inventory);
  const secondaryTypes = ["application", "process", "comparison", "concept"] as const;
  const slots: CardBlueprintSlotProposal[] = Array.from({ length: slotCount }, (_, slotIndex) => {
    const concept = inventory.concepts[slotIndex % inventory.concepts.length]!;
    const cycle = Math.floor(slotIndex / inventory.concepts.length);
    const type = cycle === 0 ? "concept" : secondaryTypes[(cycle - 1) % secondaryTypes.length]!;
    const objective = outputLanguage === "zh-CN"
      ? type === "concept"
        ? `解释“${concept.name}”的核心含义。`
        : type === "application"
          ? `运用“${concept.name}”解决资料中的典型问题。`
          : type === "process"
            ? `梳理“${concept.name}”的关键步骤与因果关系。`
            : type === "comparison"
              ? `区分“${concept.name}”与相关概念的适用边界。`
              : `从另一个角度解释“${concept.name}”。`
      : type === "concept"
        ? `Explain the core meaning of ${concept.name}.`
        : type === "application"
          ? `Apply ${concept.name} to a representative source-grounded problem.`
          : type === "process"
            ? `Trace the key steps and causal relationships in ${concept.name}.`
            : type === "comparison"
              ? `Distinguish ${concept.name} from related concepts and boundaries.`
              : `Explain ${concept.name} from another perspective.`;
    return {
      conceptId: concept.conceptId,
      type,
      objective,
      difficulty: Math.min(5, 2 + cycle + (concept.importance >= 5 ? 1 : 0)),
      sourceBlockIndexes: concept.sourceBlockIndexes,
      required: cycle === 0,
    };
  });
  const blueprint = validateCardBlueprint(materializeCardBlueprint({
    projectId: source.projectId,
    chapterId: source.chapter.chapterId,
    outlineVersion: source.outlineVersion,
    inventoryHash,
    slots,
  }), inventory, source.chapter, source.cardPolicy);
  return {
    inventory,
    blueprint,
    inventoryHash,
    blueprintHash: hashCardBlueprintV3(blueprint),
  };
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
    const outputLanguage = detectLearningOutputLanguage(source.sourceBlocks, [
      source.goal,
      source.chapter.title,
      source.chapter.summary,
    ]);
    const languageInstruction = learningOutputLanguageInstruction(outputLanguage);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Chapter Design timed out")),
      this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
    );
    timeout.unref();
    const transcript: AgentTranscriptEntry[] = [];
    let inventory: ChapterConceptInventory | null = null;
    let inventoryHash: `0x${string}` | null = null;
    let inventoryRepairCount = 0;
    let blueprintRepairCount = 0;
    const context = {
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
        cardCount: {
          minimum: source.cardPolicy.minCardCount,
          target: source.cardPolicy.targetCardCount,
          maximum: source.cardPolicy.maxCardCount,
        },
      },
      outputLanguage,
      blocks: source.sourceBlocks.map((block) => ({
        blockIndex: block.blockIndex,
        pageNumber: block.pageNumber,
        kind: block.kind,
        text: block.text,
      })),
    };
    try {
      for (let index = 0; index < (this.options.maxToolCalls ?? 8); index += 1) {
        const phaseConfiguration = !inventory
          ? {
              tools: [chapterDesignTools[0]!],
              maxCompletionTokens: 2048,
              instruction: "Propose or repair the Chapter Concept Inventory now.",
            }
          : {
              tools: [chapterDesignTools[1]!],
              maxCompletionTokens: 2048,
              instruction: "Propose or repair the Card Blueprint now.",
            };
        const call = await this.model.nextTool({
          system: [
            "You are Mindmark's Chapter Design Agent.",
            "First identify the concepts a learner must master; then design cited card slots for them.",
            "Use only assigned Source Blocks. Do not write learner cards yet.",
            `Create ${source.cardPolicy.minCardCount}-${source.cardPolicy.maxCardCount} total Blueprint Slots, aiming for ${source.cardPolicy.targetCardCount}.`,
            languageInstruction,
            "Never invent IDs, hashes, status, wallet, proofs, or transaction fields.",
          ].join(" "),
          task: `Design learning coverage for Chapter ${source.chapter.chapterId}: ${source.chapter.title}. Learning goal: ${source.goal ?? "not specified"}. ${phaseConfiguration.instruction}\nContext: ${JSON.stringify(context)}`,
          tools: phaseConfiguration.tools,
          transcript,
          signal: controller.signal,
          maxCompletionTokens: phaseConfiguration.maxCompletionTokens,
        });
        let result: unknown;
        if (call.name === "propose_chapter_concepts") {
          try {
              const proposals = ProposeInventoryArgumentsSchema.parse(call.arguments).concepts;
              const languageIssues = learnerFacingLanguageIssues(
                proposals.flatMap((concept, conceptIndex) => [
                  {
                    field: `concepts[${conceptIndex}].learningObjective`,
                    text: concept.learningObjective,
                  },
                  ...concept.misconceptions.map((misconception, misconceptionIndex) => ({
                    field: `concepts[${conceptIndex}].misconceptions[${misconceptionIndex}]`,
                    text: misconception,
                  })),
                ]),
                outputLanguage,
              );
              if (languageIssues.length > 0) throw new Error(languageIssues.join("; "));
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
        } else if (call.name === "propose_card_blueprint") {
          if (!inventory || !inventoryHash) {
            result = { accepted: false, errors: ["propose_chapter_concepts must be accepted first"] };
          } else {
            try {
              const proposals = ProposeBlueprintArgumentsSchema.parse(call.arguments).slots;
              const languageIssues = learnerFacingLanguageIssues(
                proposals.map((slot, slotIndex) => ({
                  field: `slots[${slotIndex}].objective`,
                  text: slot.objective,
                })),
                outputLanguage,
              );
              if (languageIssues.length > 0) throw new Error(languageIssues.join("; "));
              const candidate = materializeCardBlueprint({
                projectId: source.projectId,
                chapterId: source.chapter.chapterId,
                outlineVersion: source.outlineVersion,
                inventoryHash,
                slots: proposals,
              });
              const blueprint = validateCardBlueprint(
                candidate,
                inventory,
                source.chapter,
                source.cardPolicy,
              );
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
  private modelRetryAfter = 0;

  constructor(
    private readonly repository: ChapterDesignRepositoryV3,
    model: ToolCallingModel,
    private readonly options: {
      timeoutMs?: number;
      promptVersion?: string;
      modelId?: string;
      modelFailureBackoffMs?: number;
    } = {},
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
      let strategy: "AI" | "DETERMINISTIC_FALLBACK" = "AI";
      let fallbackReason: string | null = null;
      let design: DesignedChapter;
      if (Date.now() < this.modelRetryAfter) {
        strategy = "DETERMINISTIC_FALLBACK";
        fallbackReason = "Chapter Design model is temporarily unavailable after a previous failure";
        design = buildDeterministicChapterDesign(source);
      } else {
        try {
          design = await this.designModule.design(source);
          this.modelRetryAfter = 0;
        } catch (error) {
          strategy = "DETERMINISTIC_FALLBACK";
          fallbackReason = issuesOf(error).join("; ").slice(0, 200);
          this.modelRetryAfter = Date.now() + (this.options.modelFailureBackoffMs ?? 300_000);
          design = buildDeterministicChapterDesign(source);
        }
      }
      await this.repository.completeChapterDesign({
        designRunId: run.designRunId,
        ...design,
        promptVersion: this.options.promptVersion ?? "chapter-design-v3.2.0",
        modelId: strategy === "AI"
          ? this.options.modelId ?? "configured-model"
          : "deterministic-chapter-design-v1",
        metrics: {
          conceptCount: design.inventory.concepts.length,
          slotCount: design.blueprint.slots.length,
          durationMs: Math.round(performance.now() - startedAt),
          strategy,
          ...(fallbackReason ? { fallbackReason } : {}),
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
