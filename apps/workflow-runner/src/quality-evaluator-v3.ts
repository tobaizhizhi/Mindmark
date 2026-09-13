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
import { z } from "zod";
import { AgentRunnerClient } from "./agent-runner-client.js";

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

const CardQualityResponseSchema = z.object({
  evaluation: CardRubricEvaluationSchema,
  model: z.string().min(1),
  prompt_version: z.literal("card-rubric-langgraph-v1"),
});

export class RemoteCardQualityEvaluatorV3 implements CardQualityEvaluatorV3 {
  readonly modelId: string;
  readonly promptVersion: string;
  private readonly timeoutMs: number;
  private readonly rubricMinimums: GenerationPolicyV3["rubricMinimums"];
  private readonly client: AgentRunnerClient;

  constructor(
    configuration: {
      baseUrl: string;
      internalToken: string;
      modelId?: string;
      timeoutMs?: number;
      rubricMinimums?: GenerationPolicyV3["rubricMinimums"];
    },
  ) {
    this.modelId = configuration.modelId ?? "agent-runner:evaluation";
    this.promptVersion = "card-rubric-langgraph-v1";
    this.timeoutMs = configuration.timeoutMs ?? 120_000;
    this.rubricMinimums = configuration.rubricMinimums ?? DEFAULT_GENERATION_POLICY_V3.rubricMinimums;
    this.client = new AgentRunnerClient(configuration);
  }

  async evaluate(
    input: CardQualityEvaluationContextV3,
    signal?: AbortSignal,
  ): Promise<CardRubricEvaluation> {
    const response = await this.client.post({
      path: "/v1/card-quality-evaluations",
      body: {
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
        evidenceBlocks: input.evidenceBlocks.map((block) => ({
          blockIndex: block.blockIndex,
          pageNumber: block.pageNumber,
          text: block.text,
        })),
        rubricMinimums: this.rubricMinimums,
        timeout_ms: this.timeoutMs,
        max_completion_tokens: 4_096,
      },
      schema: CardQualityResponseSchema,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (response.evaluation.cardId !== input.card.id) {
      throw new Error("Card quality evaluation returned the wrong cardId");
    }
    return response.evaluation;
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
