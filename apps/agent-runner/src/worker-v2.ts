import { KnowledgeCardContentSchema } from "@mindmark/shared";
import { getAddress } from "viem";
import { z } from "zod";
import {
  DEFAULT_AI_TOOL_TIMEOUT_MS,
  type AgentToolDefinition,
  type AgentTranscriptEntry,
  type ToolCallingModel,
  type WorkerDraft,
} from "./runtime-types.js";
import type {
  ProjectRegistryGatewayV2,
  ProjectRunnerRepositoryV2,
  RunnerWorkUnitV2,
} from "./types-v2.js";
import { validateAndCommitCardsV2, verifyCommittedCardsV2 } from "./validation-v2.js";

const EmptyArgumentsSchema = z.object({}).strict();
const SaveDraftArgumentsSchema = z.object({
  cards: KnowledgeCardContentSchema.array().min(1).max(30),
}).strict();

const workerToolsV2: AgentToolDefinition[] = [
  {
    name: "read_assigned_work_unit",
    description: "Read the assigned Chapter context, Source Blocks, learning goal, and card budget.",
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
            required: ["type", "question", "answer", "keyPoint", "source", "tags", "importance", "initialDifficulty"],
            properties: {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown V2 Worker failure";
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
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("V2 Worker tool loop timed out")),
        this.options.timeoutMs ?? DEFAULT_AI_TOOL_TIMEOUT_MS,
      );
      timeout.unref();
      const transcript: AgentTranscriptEntry[] = [];
      let draft: WorkerDraft | null = null;
      let read = false;
      let repairCount = 0;
      let lastValidationErrors: string[] = [];
      const startedAt = performance.now();
      try {
        for (let index = 0; index < (this.options.maxToolCalls ?? 8); index += 1) {
          const call = await this.model.nextTool({
            system:
              "You are a Mindmark Work Unit Worker. Generate distinct, self-contained knowledge cards only from the assigned Chapter Source Blocks. Every quote must be verbatim. Never choose IDs, hashes, roots, proofs, wallets, or transaction arguments.",
            task: `Generate ${unit.cardTarget} cards (minimum ${unit.cardMinimum}, maximum ${unit.cardBudget}) for Chapter ${bundle.chapter.chapterId}: ${bundle.chapter.title}.`,
            tools: workerToolsV2,
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
              const parsed = SaveDraftArgumentsSchema.safeParse(call.arguments);
              if (!parsed.success) {
                result = { accepted: false, errors: parsed.error.issues.map((issue) => issue.message) };
              } else {
                draft = parsed.data.cards;
                result = { accepted: true, cardCount: draft.length };
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
                if (repairCount > 1) throw new Error("V2 Worker exceeded the single card validation repair");
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
                  payload: { cardCount: validation.cards.length, workerIndex: this.workerIndex },
                });
                transcript.push({
                  call,
                  result: { accepted: true, cardCount: validation.cards.length, status: "CANDIDATE_READY" },
                });
                return;
              }
            }
          } else {
            result = { accepted: false, errors: ["Unknown V2 Worker tool"] };
          }
          transcript.push({ call, result });
        }
        const validationDetail = lastValidationErrors.length > 0
          ? `: ${lastValidationErrors.join("; ")}`
          : "";
        throw new Error(`V2 Worker did not produce valid Work Unit candidates${validationDetail}`);
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
