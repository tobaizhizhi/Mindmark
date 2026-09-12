import {
  CardRubricEvaluationSchema,
  DEFAULT_GENERATION_POLICY_V3,
  normalizeSourceText,
  type CardBlueprintSlot,
  type CardRubricEvaluation,
  type GenerationPolicyV3,
  type SourceBlock,
  type WorkerKnowledgeCardV2,
} from "@mindmark/shared";
import type { AgentToolDefinition, ToolCallingModel } from "./runtime-types.js";
import { nextToolWithTransientRetry } from "./model.js";

export type CardQualityEvaluationContextV3 = {
  conceptName: string;
  slot: CardBlueprintSlot;
  card: WorkerKnowledgeCardV2;
  evidenceBlocks: SourceBlock[];
};

export interface CardQualityEvaluatorV3 {
  readonly modelId: string;
  readonly promptVersion: string;
  evaluate(input: CardQualityEvaluationContextV3, signal?: AbortSignal): Promise<CardRubricEvaluation>;
}

const submitQualityEvaluationTool: AgentToolDefinition = {
  name: "submit_card_quality_evaluation",
  description: "Submit evidence sufficiency, six Rubric scores, a verdict, and actionable reasons.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "cardId",
      "citationSufficient",
      "factuality",
      "learningValue",
      "clarity",
      "completeness",
      "citationRelevance",
      "difficultyFit",
      "verdict",
      "reasons",
    ],
    properties: {
      cardId: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      citationSufficient: { type: "boolean" },
      factuality: { type: "integer", minimum: 0, maximum: 5 },
      learningValue: { type: "integer", minimum: 0, maximum: 5 },
      clarity: { type: "integer", minimum: 0, maximum: 5 },
      completeness: { type: "integer", minimum: 0, maximum: 5 },
      citationRelevance: { type: "integer", minimum: 0, maximum: 5 },
      difficultyFit: { type: "integer", minimum: 0, maximum: 5 },
      verdict: { enum: ["ACCEPT", "REPAIR", "REJECT"] },
      reasons: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 500 } },
    },
  },
};

export class ModelCardQualityEvaluatorV3 implements CardQualityEvaluatorV3 {
  readonly modelId: string;
  readonly promptVersion: string;

  constructor(
    private readonly model: ToolCallingModel,
    options: {
      modelId: string;
      promptVersion?: string;
      timeoutMs?: number;
      rubricMinimums?: GenerationPolicyV3["rubricMinimums"];
      retryDelaysMs?: readonly number[];
    },
  ) {
    this.modelId = options.modelId;
    this.promptVersion = options.promptVersion ?? "card-rubric-v3-2";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.rubricMinimums = options.rubricMinimums ?? DEFAULT_GENERATION_POLICY_V3.rubricMinimums;
    this.retryDelaysMs = options.retryDelaysMs ?? [5_000, 15_000];
  }

  private readonly timeoutMs: number;
  private readonly rubricMinimums: GenerationPolicyV3["rubricMinimums"];
  private readonly retryDelaysMs: readonly number[];

  async evaluate(
    input: CardQualityEvaluationContextV3,
    signal?: AbortSignal,
  ): Promise<CardRubricEvaluation> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const call = await nextToolWithTransientRetry(this.model, {
      system: [
        "You are the Mindmark Card Quality Evaluator. Judge only the supplied Blueprint Slot, card, and evidence.",
        "First decide whether the quoted evidence is sufficient for every material claim in the answer.",
        "Then score factuality, learning value, clarity, completeness, citation relevance, and difficulty fit from 0 to 5.",
        `Use these minimum scores for ACCEPT: ${JSON.stringify(this.rubricMinimums)}.`,
        "Do not use external knowledge. ACCEPT only when the evidence is sufficient and every minimum is met.",
        "Give concise, actionable repair reasons. Submit exactly one structured evaluation.",
      ].join(" "),
      task: JSON.stringify({
        conceptName: input.conceptName,
        slot: {
          objective: input.slot.objective,
          type: input.slot.type,
          difficulty: input.slot.difficulty,
          required: input.slot.required,
          evidenceBlockIndexes: input.slot.sourceBlockIndexes,
        },
        card: {
          cardId: input.card.id,
          type: input.card.type,
          question: input.card.question,
          answer: input.card.answer,
          keyPoint: input.card.keyPoint,
          source: input.card.source,
          importance: input.card.importance,
          initialDifficulty: input.card.initialDifficulty,
        },
        evidence: input.evidenceBlocks.map((block) => ({
          blockIndex: block.blockIndex,
          pageNumber: block.pageNumber,
          text: block.text,
        })),
      }),
      tools: [submitQualityEvaluationTool],
      transcript: [],
      signal: combinedSignal,
    }, this.retryDelaysMs);
    if (call.name !== submitQualityEvaluationTool.name) {
      throw new Error("Card quality model called an unknown tool");
    }
    const evaluation = CardRubricEvaluationSchema.parse(call.arguments);
    if (evaluation.cardId !== input.card.id) {
      throw new Error("Card quality evaluation returned the wrong cardId");
    }
    return evaluation;
  }
}

export class DeterministicCardQualityEvaluatorV3 implements CardQualityEvaluatorV3 {
  readonly modelId = "deterministic-rubric-v1";
  readonly promptVersion = "deterministic-rubric-v1";

  async evaluate(input: CardQualityEvaluationContextV3): Promise<CardRubricEvaluation> {
    const quote = normalizeSourceText(input.card.source.quote);
    const citationSufficient = input.evidenceBlocks.some(
      (block) => block.pageNumber === input.card.source.page && normalizeSourceText(block.text).includes(quote),
    );
    return CardRubricEvaluationSchema.parse({
      cardId: input.card.id,
      citationSufficient,
      factuality: citationSufficient ? 4 : 1,
      learningValue: 4,
      clarity: 4,
      completeness: citationSufficient ? 4 : 2,
      citationRelevance: citationSufficient ? 4 : 1,
      difficultyFit: input.card.initialDifficulty === input.slot.difficulty ? 5 : 2,
      verdict: citationSufficient && input.card.initialDifficulty === input.slot.difficulty ? "ACCEPT" : "REPAIR",
      reasons: citationSufficient
        ? []
        : ["The quoted source is not present in the Blueprint Slot evidence."],
    });
  }
}
