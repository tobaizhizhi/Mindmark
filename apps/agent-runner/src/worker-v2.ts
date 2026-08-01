import {
  Bytes32Schema,
  KnowledgeCardContentSchema,
  normalizeSourceText,
} from "@mindmark/shared";
import { getAddress } from "viem";
import { z } from "zod";
import {
  DEFAULT_AI_TOOL_TIMEOUT_MS,
  type AgentToolDefinition,
  type AgentTranscriptEntry,
  type ToolCallingModel,
} from "./runtime-types.js";
import type {
  BlueprintWorkerRepositoryV3,
  ProjectRegistryGatewayV2,
  ProjectRunnerRepositoryV2,
  RunnerWorkUnitV2,
  WorkUnitBlueprintContextV3,
} from "./types-v2.js";
import {
  validateAndCommitBlueprintCardsV3,
  validateAndCommitCardsV2,
  verifyCommittedCardsV2,
} from "./validation-v2.js";
import {
  detectLearningOutputLanguage,
  learnerFacingLanguageIssues,
  learningOutputLanguageInstruction,
} from "./language-policy.js";
import { nextToolWithTransientRetry } from "./model.js";

const EmptyArgumentsSchema = z.object({}).strict();
const SaveDraftArgumentsSchemaV2 = z.object({
  cards: KnowledgeCardContentSchema.array().min(1).max(30),
}).strict();
const BlueprintCardDraftSchema = KnowledgeCardContentSchema.extend({
  blueprintSlotId: Bytes32Schema,
}).strict();
const SaveDraftArgumentsSchemaV3 = z.object({
  cards: BlueprintCardDraftSchema.array().min(1).max(30),
}).strict();

// Keep each model response small enough for the configured AI endpoint.
export const MAX_BLUEPRINT_SLOTS_PER_MODEL_BATCH = 1;

export function workUnitToolTimeoutMs(configuredMs: number, blueprintSlotCount: number): number {
  const scaledMs = 60_000 + Math.max(0, blueprintSlotCount) * 12_000;
  return Math.min(600_000, Math.max(configuredMs, scaledMs));
}

function workerTools(policyVersion: 2 | 3): AgentToolDefinition[] {
  const blueprintDriven = policyVersion === 3;
  return [
  {
    name: "read_assigned_work_unit",
    description: blueprintDriven
      ? "Read the assigned Chapter context, Source Blocks, and exact Card Blueprint Slots."
      : "Read the assigned Chapter context, Source Blocks, learning goal, and card budget.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_work_unit_draft",
    description: "Save card content only. The server derives Project, Chapter, Work Unit, card IDs, and proofs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["cards"],
      properties: {
        cards: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            required: blueprintDriven
              ? ["blueprintSlotId", "type", "question", "answer", "keyPoint", "source", "tags", "importance", "initialDifficulty"]
              : ["type", "question", "answer", "keyPoint", "source", "tags", "importance", "initialDifficulty"],
            properties: {
              ...(blueprintDriven ? { blueprintSlotId: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } } : {}),
              type: { enum: ["concept", "qa"] },
              question: { type: "string" },
              answer: { type: "string" },
              keyPoint: { type: "string" },
              source: {
                type: "object",
                additionalProperties: false,
                required: ["page", "quote"],
                properties: { page: { type: "integer" }, quote: { type: "string" } },
              },
              tags: { type: "array", items: { type: "string" } },
              importance: { type: "integer", minimum: 1, maximum: 5 },
              initialDifficulty: { type: "integer", minimum: 1, maximum: 5 },
            },
          },
        },
      },
    },
  },
  {
    name: "validate_work_unit_cards",
    description: "Validate citations and derive server-side V2 card commitments.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown V2 Worker failure";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

function groundBlueprintCitation(
  draft: z.infer<typeof BlueprintCardDraftSchema>,
  context: WorkUnitBlueprintContextV3,
  sourceBlocks: NonNullable<RunnerWorkUnitV2["sourceBlocks"]>,
): z.infer<typeof BlueprintCardDraftSchema> {
  const slot = context.slots.find((candidate) => candidate.slotId === draft.blueprintSlotId);
  if (!slot) return draft;
  const evidenceBlocks = sourceBlocks.filter((block) => slot.sourceBlockIndexes.includes(block.blockIndex));
  const normalizedQuote = normalizeSourceText(draft.source.quote);
  const exactEvidence = evidenceBlocks.find((block) =>
    block.pageNumber === draft.source.page && normalizeSourceText(block.text).includes(normalizedQuote),
  );
  if (exactEvidence) return draft;
  const fallbackEvidence = evidenceBlocks.find((block) => normalizeSourceText(block.text).length >= 20);
  if (!fallbackEvidence) return draft;
  return {
    ...draft,
    source: {
      page: fallbackEvidence.pageNumber,
      quote: normalizeSourceText(fallbackEvidence.text).slice(0, 400).trim(),
    },
  };
}

function verifyPersisted(unit: RunnerWorkUnitV2): boolean {
  return Boolean(
    unit.cardsRoot &&
    unit.cardCount === unit.workerCards.length &&
    verifyCommittedCardsV2({
      projectId: unit.projectId,
      chapterId: unit.chapterId,
      workUnitId: unit.workUnitId,
      cards: unit.workerCards,
      expectedRoot: unit.cardsRoot,
    }),
  );
}

export class WorkUnitWorkerAgent {
  constructor(
    private readonly repository: ProjectRunnerRepositoryV2,
    private readonly registry: ProjectRegistryGatewayV2,
    private readonly model: ToolCallingModel,
    private readonly workerIndex: number,
    private readonly options: { maxToolCalls?: number; timeoutMs?: number } = {},
  ) {}

  async runClaimed(initialUnit: RunnerWorkUnitV2): Promise<void> {
    try {
      const expectedWorker = this.registry.workerAddress(this.workerIndex);
      if (!initialUnit.workerAddress || getAddress(initialUnit.workerAddress) !== getAddress(expectedWorker)) {
        throw new Error("Claimed Work Unit is assigned to another Worker wallet");
      }
      const unit = await this.repository.getWorkUnit(initialUnit.projectId, initialUnit.workUnitId);
      const onChain = await this.registry.readWorkUnit(unit.projectId, unit.workUnitId);
      if (onChain) {
        await this.recoverExisting(unit, onChain);
        return;
      }
      if (unit.status === "APPROVED" || unit.status === "SUBMITTING") {
        await this.submitPersisted(unit);
        return;
      }
      if (unit.status !== "GENERATING") {
        throw new Error(`Work Unit has non-generatable status ${unit.status}`);
      }
      if (!unit.sourceBlocks?.length) throw new Error("Claimed Work Unit source has been cleaned or is missing");
      const sourceBlocks = unit.sourceBlocks;
      const bundle = await this.repository.getChapterBundle(unit.projectId, unit.chapterId);
      const policyVersion = bundle.project.generationPolicyVersion;
      const outputLanguage = detectLearningOutputLanguage(sourceBlocks, [
        bundle.project.goal,
        bundle.chapter.title,
        bundle.chapter.summary,
      ]);
      const languageInstruction = learningOutputLanguageInstruction(outputLanguage);
      const blueprintContext = policyVersion === 3
        ? await this.loadBlueprintContext(unit)
        : null;
      if (blueprintContext) {
        await this.runBlueprintBatches({
          unit,
          bundle,
          sourceBlocks,
          outputLanguage,
          languageInstruction,
          blueprintContext,
        });
        return;
      }
      const controller = new AbortController();
      const timeoutMs = workUnitToolTimeoutMs(
        this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
        0,
      );
      const timeout = setTimeout(
        () => controller.abort(new Error("V2 Worker tool loop timed out")),
        timeoutMs,
      );
      const transcript: AgentTranscriptEntry[] = [];
      let draft: unknown[] | null = null;
      let read = false;
      let repairCount = 0;
      let lastValidationErrors: string[] = [];
      const startedAt = performance.now();
      try {
        for (let index = 0; index < (this.options.maxToolCalls ?? 8); index += 1) {
          const call = await nextToolWithTransientRetry(this.model, {
            system: `You are a Mindmark Work Unit Worker. Generate distinct, self-contained knowledge cards only from the assigned Chapter Source Blocks. Every quote must be verbatim. ${languageInstruction} Never choose IDs, hashes, roots, proofs, wallets, or transaction arguments.`,
            task: `Generate ${unit.cardTarget} cards (minimum ${unit.cardMinimum}, maximum ${unit.cardBudget}) for Chapter ${bundle.chapter.chapterId}: ${bundle.chapter.title}.`,
            tools: workerTools(2),
            transcript,
            signal: controller.signal,
          });
          let result: unknown;
          if (call.name === "read_assigned_work_unit") {
            EmptyArgumentsSchema.parse(call.arguments);
            read = true;
            result = {
              learningGoal: bundle.project.goal,
              chapter: { title: bundle.chapter.title, summary: bundle.chapter.summary },
              cardMinimum: unit.cardMinimum,
              cardTarget: unit.cardTarget,
              cardBudget: unit.cardBudget,
              outputLanguage,
              blocks: sourceBlocks.map((block) => ({
                blockIndex: block.blockIndex,
                pageNumber: block.pageNumber,
                kind: block.kind,
                text: block.text,
              })),
            };
          } else if (call.name === "save_work_unit_draft") {
            if (!read) {
              result = { accepted: false, errors: ["read_assigned_work_unit must be called first"] };
            } else {
              const parsed = SaveDraftArgumentsSchemaV2.safeParse(call.arguments);
              if (!parsed.success) {
                result = { accepted: false, errors: parsed.error.issues.map((issue) => issue.message) };
              } else {
                const languageIssues = learnerFacingLanguageIssues(
                  parsed.data.cards.flatMap((card, cardIndex) => [
                    { field: `cards[${cardIndex}].question`, text: card.question },
                    { field: `cards[${cardIndex}].answer`, text: card.answer },
                    { field: `cards[${cardIndex}].keyPoint`, text: card.keyPoint },
                  ]),
                  outputLanguage,
                );
                if (languageIssues.length > 0) {
                  draft = null;
                  result = { accepted: false, errors: languageIssues, outputLanguage };
                } else {
                  draft = parsed.data.cards;
                  result = { accepted: true, cardCount: draft.length, outputLanguage };
                }
              }
            }
          } else if (call.name === "validate_work_unit_cards") {
            EmptyArgumentsSchema.parse(call.arguments);
            if (!draft) {
              result = { accepted: false, errors: ["save_work_unit_draft must be called first"] };
            } else {
              const validation = validateAndCommitCardsV2({
                rawCards: draft,
                projectId: unit.projectId,
                chapterId: unit.chapterId,
                workUnitId: unit.workUnitId,
                cardMinimum: unit.cardMinimum,
                cardTarget: unit.cardTarget,
                cardBudget: unit.cardBudget,
                sourceBlocks,
              });
              if (!validation.valid) {
                repairCount += 1;
                lastValidationErrors = validation.errors;
                if (repairCount > 1) {
                  throw new Error("V2 Worker exceeded the single card validation repair");
                }
                result = { accepted: false, errors: validation.errors };
              } else {
                lastValidationErrors = [];
                await this.repository.markWorkUnitValidating(unit.projectId, unit.workUnitId);
                await this.repository.saveWorkUnitResult(unit.projectId, unit.workUnitId, {
                  cards: validation.cards,
                  cardsRoot: validation.cardsRoot,
                  generationMs: Math.round(performance.now() - startedAt),
                });
                await this.repository.recordProjectAgentEvent({
                  projectId: unit.projectId,
                  chapterId: unit.chapterId,
                  workUnitId: unit.workUnitId,
                  role: "worker",
                  type: "WORK_UNIT_CANDIDATE_READY",
                  payload: {
                    cardCount: validation.cards.length,
                    workerIndex: this.workerIndex,
                    policyVersion: 2,
                  },
                });
                transcript.push({
                  call,
                  result: { accepted: true, cardCount: validation.cards.length, status: "CANDIDATE_READY" },
                });
                return;
              }
            }
          } else {
            result = {
              accepted: false,
              errors: ["Unknown V2 Worker tool"],
            };
          }
          transcript.push({ call, result });
        }
        const validationDetail = lastValidationErrors.length > 0
          ? `: ${lastValidationErrors.join("; ")}`
          : "";
        throw new Error(
          `V2 Worker did not produce valid Work Unit candidates${validationDetail}`,
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      await this.repository.markWorkUnitRetryable(
        initialUnit.projectId,
        initialUnit.workUnitId,
        messageOf(error),
      );
      throw error;
    }
  }

  private async runBlueprintBatches(input: {
    unit: RunnerWorkUnitV2;
    bundle: Awaited<ReturnType<ProjectRunnerRepositoryV2["getChapterBundle"]>>;
    sourceBlocks: NonNullable<RunnerWorkUnitV2["sourceBlocks"]>;
    outputLanguage: ReturnType<typeof detectLearningOutputLanguage>;
    languageInstruction: string;
    blueprintContext: WorkUnitBlueprintContextV3;
  }): Promise<void> {
    const startedAt = performance.now();
    const slotCount = input.blueprintContext.slots.length;
    const batchContexts: WorkUnitBlueprintContextV3[] = [];
    for (let offset = 0; offset < slotCount; offset += MAX_BLUEPRINT_SLOTS_PER_MODEL_BATCH) {
      const slots = input.blueprintContext.slots.slice(offset, offset + MAX_BLUEPRINT_SLOTS_PER_MODEL_BATCH);
      const slotIds = new Set(slots.map((slot) => slot.slotId));
      batchContexts.push({
        ...input.blueprintContext,
        slots,
        repairInstructions: input.blueprintContext.repairInstructions.filter((repair) => slotIds.has(repair.slotId)),
      });
    }
    const generatedBatches = await mapWithConcurrency(batchContexts, 1, async (batchContext, batchIndex) => {
      try {
        return await this.generateBlueprintBatch({
          ...input,
          blueprintContext: batchContext,
        });
      } catch (error) {
        throw new Error(`V3 Blueprint Worker batch ${batchIndex + 1} failed: ${messageOf(error)}`);
      }
    });
    const rawCards = generatedBatches.flat();

    const validation = validateAndCommitBlueprintCardsV3({
      rawCards,
      projectId: input.unit.projectId,
      chapterId: input.unit.chapterId,
      workUnitId: input.unit.workUnitId,
      slots: input.blueprintContext.slots,
      sourceBlocks: input.sourceBlocks,
    });
    if (!validation.valid) {
      throw new Error(`V3 Blueprint Worker combined validation failed: ${validation.errors.join("; ")}`);
    }
    await this.repository.markWorkUnitValidating(input.unit.projectId, input.unit.workUnitId);
    await this.repository.saveWorkUnitResult(input.unit.projectId, input.unit.workUnitId, {
      cards: validation.cards,
      cardsRoot: validation.cardsRoot,
      generationMs: Math.round(performance.now() - startedAt),
      slotCandidates: validation.slotCandidates,
    });
    await this.repository.recordProjectAgentEvent({
      projectId: input.unit.projectId,
      chapterId: input.unit.chapterId,
      workUnitId: input.unit.workUnitId,
      role: "worker",
      type: "WORK_UNIT_CANDIDATE_READY",
      payload: {
        cardCount: validation.cards.length,
        workerIndex: this.workerIndex,
        policyVersion: 3,
        batchCount: Math.ceil(slotCount / MAX_BLUEPRINT_SLOTS_PER_MODEL_BATCH),
        designRunId: input.blueprintContext.designRunId,
      },
    });
  }

  private async generateBlueprintBatch(input: {
    unit: RunnerWorkUnitV2;
    bundle: Awaited<ReturnType<ProjectRunnerRepositoryV2["getChapterBundle"]>>;
    sourceBlocks: NonNullable<RunnerWorkUnitV2["sourceBlocks"]>;
    outputLanguage: ReturnType<typeof detectLearningOutputLanguage>;
    languageInstruction: string;
    blueprintContext: WorkUnitBlueprintContextV3;
  }): Promise<z.infer<typeof BlueprintCardDraftSchema>[]> {
    const controller = new AbortController();
    const evidenceBlockIndexes = new Set(
      input.blueprintContext.slots.flatMap((slot) => slot.sourceBlockIndexes),
    );
    const batchSourceBlocks = input.sourceBlocks.filter((block) => evidenceBlockIndexes.has(block.blockIndex));
    const batchTimeoutMs = Math.max(workUnitToolTimeoutMs(
      this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
      input.blueprintContext.slots.length,
    ), 180_000);
    const timeout = setTimeout(
      () => controller.abort(new Error("V3 Blueprint Worker batch timed out")),
      batchTimeoutMs,
    );
    const transcript: AgentTranscriptEntry[] = [{
      call: { id: "server-read", name: "read_assigned_work_unit", arguments: {} },
      result: {
        learningGoal: input.bundle.project.goal,
        chapter: { title: input.bundle.chapter.title, summary: input.bundle.chapter.summary },
        cardMinimum: input.unit.cardMinimum,
        cardTarget: input.unit.cardTarget,
        cardBudget: input.unit.cardBudget,
        outputLanguage: input.outputLanguage,
        blocks: (batchSourceBlocks.length > 0 ? batchSourceBlocks : input.sourceBlocks).map((block) => ({
          blockIndex: block.blockIndex,
          pageNumber: block.pageNumber,
          kind: block.kind,
          text: block.text,
        })),
        blueprintSlots: input.blueprintContext.slots.map((slot) => ({
          blueprintSlotId: slot.slotId,
          conceptName: input.blueprintContext.inventory.concepts.find(
            (concept) => concept.conceptId === slot.conceptId,
          )?.name,
          objective: slot.objective,
          type: slot.type,
          difficulty: slot.difficulty,
          required: slot.required,
          evidenceBlockIndexes: slot.sourceBlockIndexes,
        })),
        repairInstructions: input.blueprintContext.repairInstructions.map((repair) => ({
          blueprintSlotId: repair.slotId,
          rejectedCandidateRevision: repair.candidateRevision,
          failureCodes: repair.failureCodes,
          instruction: repair.instruction,
          rejectedCard: repair.previousCard,
        })),
      },
    }];
    let repairCount = 0;
    let lastValidationErrors: string[] = [];
    try {
      for (let index = 0; index < Math.min(this.options.maxToolCalls ?? 3, 3); index += 1) {
        const call = await nextToolWithTransientRetry(this.model, {
          system: `You are a Mindmark Blueprint Worker. The assigned Work Unit context has already been read and is available in the tool transcript. Generate exactly one distinct, self-contained card for every supplied Blueprint Slot, then call save_work_unit_draft directly. Follow each Slot objective, type, difficulty, and evidence indexes. When a repair instruction is present, replace the rejected candidate by addressing every failure code and instruction; do not restate its failed question, answer, or key point. Return the supplied blueprintSlotId with its card. ${input.languageInstruction} Never choose any other IDs, hashes, roots, proofs, wallets, or transaction arguments.`,
          task: `Generate and save exactly ${input.blueprintContext.slots.length} cards, one for each supplied Blueprint Slot, for Chapter ${input.bundle.chapter.chapterId}: ${input.bundle.chapter.title}.`,
          tools: workerTools(3).filter((tool) => tool.name === "save_work_unit_draft"),
          transcript,
          signal: controller.signal,
        });
        let result: unknown;
        if (call.name === "save_work_unit_draft") {
          const parsed = SaveDraftArgumentsSchemaV3.safeParse(call.arguments);
          if (!parsed.success) {
            result = { accepted: false, errors: parsed.error.issues.map((issue) => issue.message) };
          } else {
            const languageIssues = learnerFacingLanguageIssues(
              parsed.data.cards.flatMap((card, cardIndex) => [
                { field: `cards[${cardIndex}].question`, text: card.question },
                { field: `cards[${cardIndex}].answer`, text: card.answer },
                { field: `cards[${cardIndex}].keyPoint`, text: card.keyPoint },
              ]),
              input.outputLanguage,
            );
            if (languageIssues.length > 0) {
              result = { accepted: false, errors: languageIssues, outputLanguage: input.outputLanguage };
            } else {
              const draft = parsed.data.cards.map((card) =>
                groundBlueprintCitation(card, input.blueprintContext, input.sourceBlocks),
              );
              const validation = validateAndCommitBlueprintCardsV3({
                rawCards: draft,
                projectId: input.unit.projectId,
                chapterId: input.unit.chapterId,
                workUnitId: input.unit.workUnitId,
                slots: input.blueprintContext.slots,
                sourceBlocks: input.sourceBlocks,
              });
              if (validation.valid) return draft;
              repairCount += 1;
              lastValidationErrors = validation.errors;
              if (repairCount > 1) {
                throw new Error(`V3 Blueprint Worker exceeded the single card validation repair: ${validation.errors.join("; ")}`);
              }
              result = { accepted: false, errors: validation.errors };
            }
          }
        } else {
          result = { accepted: false, errors: ["Call save_work_unit_draft with the generated cards"] };
        }
        transcript.push({ call, result });
      }
      const validationDetail = lastValidationErrors.length > 0
        ? `: ${lastValidationErrors.join("; ")}`
        : "";
      throw new Error(`V3 Blueprint Worker did not produce valid batch candidates${validationDetail}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async loadBlueprintContext(unit: RunnerWorkUnitV2): Promise<WorkUnitBlueprintContextV3> {
    const repository = this.repository as ProjectRunnerRepositoryV2 & Partial<BlueprintWorkerRepositoryV3>;
    if (!repository.getWorkUnitBlueprintContext) {
      throw new Error("V3 Work Unit repository does not support Blueprint context loading");
    }
    return repository.getWorkUnitBlueprintContext(unit.projectId, unit.workUnitId);
  }

  private async recoverExisting(
    unit: RunnerWorkUnitV2,
    chain: NonNullable<Awaited<ReturnType<ProjectRegistryGatewayV2["readWorkUnit"]>>>,
  ): Promise<void> {
    const expectedWorker = this.registry.workerAddress(this.workerIndex);
    if (
      chain.chapterId !== unit.chapterId ||
      chain.sourceUnitHash !== unit.sourceUnitHash ||
      chain.cardsRoot !== unit.cardsRoot ||
      chain.cardCount !== unit.cardCount ||
      getAddress(chain.worker) !== getAddress(expectedWorker) ||
      !verifyPersisted(unit)
    ) {
      throw new Error("Monad Work Unit commitment does not match persisted validated data");
    }
    await this.repository.markWorkUnitConfirmed(unit.projectId, unit.workUnitId, {
      txHash: unit.commitTxHash,
      blockNumber: chain.committedBlock,
      gasUsed: null,
      confirmationMs: 0,
    });
  }

  private async submitPersisted(unit: RunnerWorkUnitV2): Promise<void> {
    if (!unit.cardsRoot || !unit.cardCount || !verifyPersisted(unit)) {
      throw new Error("Persisted V2 Worker cards do not match their commitment");
    }
    if (unit.status === "SUBMITTING" && unit.commitTxHash) {
      const status = await this.registry.readTransactionStatus(unit.commitTxHash);
      if (status === "PENDING") throw new Error("Work Unit commitment transaction is still pending");
      if (status === "SUCCESS") {
        const chain = await this.registry.readWorkUnit(unit.projectId, unit.workUnitId);
        if (!chain) throw new Error("Successful Work Unit transaction has no commitment");
        await this.recoverExisting(unit, chain);
        return;
      }
    }
    const receipt = await this.registry.commitWorkUnit(
      this.workerIndex,
      {
        projectId: unit.projectId,
        workUnitId: unit.workUnitId,
        chapterId: unit.chapterId,
        sourceUnitHash: unit.sourceUnitHash,
        cardsRoot: unit.cardsRoot,
        cardCount: unit.cardCount,
        manifestProof: unit.manifestProof,
      },
      (txHash) => this.repository.markWorkUnitSubmitting(unit.projectId, unit.workUnitId, txHash),
    );
    await this.repository.markWorkUnitConfirmed(unit.projectId, unit.workUnitId, receipt);
    await this.repository.recordProjectAgentEvent({
      projectId: unit.projectId,
      chapterId: unit.chapterId,
      workUnitId: unit.workUnitId,
      role: "worker",
      type: "WORK_UNIT_CONFIRMED",
      payload: { cardCount: unit.cardCount, workerIndex: this.workerIndex },
      txHash: receipt.txHash,
    });
  }
}
