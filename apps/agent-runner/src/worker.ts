import { KnowledgeCardContentSchema } from "@mindmark/shared";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import type {
  AgentToolDefinition,
  AgentTranscriptEntry,
  RegistryGateway,
  RunnerChunk,
  RunnerRepository,
  ToolCallingModel,
  WorkerDraft,
} from "./types.js";
import { validateAndCommitCards, verifyCommittedCards } from "./validation.js";

const EmptyArgumentsSchema = z.object({}).strict();
const SaveDraftArgumentsSchema = z
  .object({ cards: KnowledgeCardContentSchema.array().min(1).max(30) })
  .strict();

const workerTools: AgentToolDefinition[] = [
  {
    name: "read_assigned_chunk",
    description: "Read only the assigned source pages, learning goal, and card budget.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_chunk_draft",
    description: "Save a draft containing only card content. IDs and commitments are server-derived.",
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
            required: [
              "type",
              "question",
              "answer",
              "keyPoint",
              "source",
              "tags",
              "importance",
              "initialDifficulty",
            ],
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
    name: "validate_chunk_cards",
    description: "Validate the current draft and derive server-side card commitments.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_chunk_commitment",
    description: "Read the current chunk commitment from Monad before submitting.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submit_chunk_commitment",
    description: "Submit persisted validated data. This tool accepts no commitment arguments.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Worker failure";
}

function findChunk(chunks: RunnerChunk[], chunkId: number): RunnerChunk {
  const chunk = chunks.find((candidate) => candidate.chunkId === chunkId);
  if (!chunk) throw new Error(`Chunk ${chunkId} does not exist`);
  return chunk;
}

function workerRole(workerIndex: number): "worker-0" | "worker-1" | "worker-2" {
  if (workerIndex === 0) return "worker-0";
  if (workerIndex === 1) return "worker-1";
  if (workerIndex === 2) return "worker-2";
  throw new RangeError(`Unknown Worker index: ${workerIndex}`);
}

export class WorkerAgent {
  constructor(
    private readonly repository: RunnerRepository,
    private readonly registry: RegistryGateway,
    private readonly model: ToolCallingModel,
    private readonly options: { maxToolCalls?: number; timeoutMs?: number } = {},
  ) {}

  async run(journeyId: Hex, chunkId: number): Promise<void> {
    const workerIndex = chunkId % 3;
    const role = workerRole(workerIndex);
    try {
      let bundle = await this.repository.getJourneyBundle(journeyId);
      let chunk = findChunk(bundle.chunks, chunkId);
      const existing = await this.registry.readChunk(journeyId, chunkId);
      if (existing) {
        await this.recoverExisting(chunk, existing, workerIndex);
        return;
      }
      if (chunk.status === "SAVED" || chunk.status === "SUBMITTING") {
        await this.submitSaved(journeyId, chunkId, workerIndex);
        return;
      }
      if (chunk.status !== "GENERATING") {
        throw new Error(`Chunk ${chunkId} is not claimed for generation`);
      }
      if (!chunk.sourcePages || !chunk.sourceText) {
        throw new Error("Assigned source text has already been cleaned or is unavailable");
      }
      const sourcePages = chunk.sourcePages;

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Worker tool loop timed out")),
        this.options.timeoutMs ?? 60_000,
      );
      timeout.unref();
      const transcript: AgentTranscriptEntry[] = [];
      let hasRead = false;
      let markedValidating = false;
      let draft: WorkerDraft | null = null;
      let validated = false;
      let repairCount = 0;
      const startedAt = performance.now();

      try {
        for (let callIndex = 0; callIndex < (this.options.maxToolCalls ?? 8); callIndex += 1) {
          const call = await this.model.nextTool({
            system:
              "You are one isolated Mindmark Worker. Use tools in order, produce atomic cited cards, and never invent IDs, roots, proofs, or transaction inputs. Write all learner-facing card content in the same language as the source and learning goal; for Chinese material, use concise Simplified Chinese and retain English only for necessary code identifiers.",
            task: `Generate cited knowledge cards for Journey ${journeyId}, chunk ${chunkId}.`,
            tools: workerTools,
            transcript,
            signal: controller.signal,
          });
          let result: unknown;

          if (call.name === "read_assigned_chunk") {
            EmptyArgumentsSchema.parse(call.arguments);
            hasRead = true;
            result = {
              chunkId,
              title: chunk.title,
              pageStart: chunk.pageStart,
              pageEnd: chunk.pageEnd,
              sourcePages,
              goal: bundle.journey.goal,
              cardBudget: chunk.cardBudget,
            };
          } else if (call.name === "save_chunk_draft") {
            if (!hasRead) {
              result = { saved: false, error: "read_assigned_chunk must be called first" };
            } else {
              const parsed = SaveDraftArgumentsSchema.safeParse(call.arguments);
              if (!parsed.success) {
                result = {
                  saved: false,
                  errors: parsed.error.issues.map((issue) => issue.message),
                };
              } else {
                draft = parsed.data.cards;
                validated = false;
                result = { saved: true, cardCount: draft.length };
              }
            }
          } else if (call.name === "validate_chunk_cards") {
            EmptyArgumentsSchema.parse(call.arguments);
            if (!draft) {
              result = { valid: false, errors: ["No draft has been saved"] };
            } else {
              if (!markedValidating) {
                await this.repository.markChunkValidating(journeyId, chunkId);
                markedValidating = true;
              }
              const validation = validateAndCommitCards({
                rawCards: draft,
                journeyId,
                chunkId,
                cardBudget: chunk.cardBudget,
                sourcePages,
              });
              if (!validation.valid) {
                repairCount += 1;
                if (repairCount > 1) {
                  throw new Error("Worker exceeded the single card validation repair");
                }
                result = { valid: false, errors: validation.errors };
              } else {
                await this.repository.saveChunkResult(journeyId, chunkId, {
                  cards: validation.cards,
                  cardsRoot: validation.cardsRoot,
                  generationMs: Math.round(performance.now() - startedAt),
                });
                validated = true;
                result = {
                  valid: true,
                  cardCount: validation.cards.length,
                  cardsRoot: validation.cardsRoot,
                };
              }
            }
          } else if (call.name === "get_chunk_commitment") {
            EmptyArgumentsSchema.parse(call.arguments);
            const commitment = await this.registry.readChunk(journeyId, chunkId);
            result = commitment
              ? {
                  exists: true,
                  cardsRoot: commitment.cardsRoot,
                  cardCount: commitment.cardCount,
                  agent: commitment.agent,
                }
              : { exists: false };
          } else if (call.name === "submit_chunk_commitment") {
            const parsed = EmptyArgumentsSchema.safeParse(call.arguments);
            if (!parsed.success) {
              result = {
                submitted: false,
                error: "submit_chunk_commitment accepts no arguments",
              };
            } else if (!validated) {
              result = {
                submitted: false,
                error: "A validated persisted result is required before submission",
              };
            } else {
              await this.submitSaved(journeyId, chunkId, workerIndex);
              result = { submitted: true };
              transcript.push({ call, result });
              return;
            }
          } else {
            result = { error: `Unknown tool: ${call.name}` };
          }
          transcript.push({ call, result });
          bundle = await this.repository.getJourneyBundle(journeyId);
          chunk = findChunk(bundle.chunks, chunkId);
        }
        throw new Error("Worker exhausted its tool-call budget before submission");
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      try {
        await this.repository.markChunkRetryable(journeyId, chunkId, messageOf(error));
        await this.repository.recordAgentEvent({
          journeyId,
          chunkId,
          role,
          type: "worker_retryable",
          payload: { workerIndex },
        });
      } catch {
        // Preserve the original Worker error when recovery bookkeeping also fails.
      }
      throw error;
    }
  }

  private async recoverExisting(
    chunk: RunnerChunk,
    commitment: NonNullable<Awaited<ReturnType<RegistryGateway["readChunk"]>>>,
    workerIndex: number,
  ): Promise<void> {
    const expectedWorker = this.registry.workerAddress(workerIndex);
    const matches =
      chunk.cardsRoot !== null &&
      chunk.cardCount !== null &&
      commitment.sourceChunkHash === chunk.sourceChunkHash &&
      commitment.cardsRoot === chunk.cardsRoot &&
      commitment.cardCount === chunk.cardCount &&
      getAddress(commitment.agent) === getAddress(expectedWorker) &&
      verifyCommittedCards({
        journeyId: chunk.journeyId,
        chunkId: chunk.chunkId,
        cards: chunk.cards,
        expectedRoot: chunk.cardsRoot,
      });
    if (!matches) {
      throw new Error("Existing Monad chunk commitment does not match persisted validated data");
    }
    await this.repository.markChunkConfirmed(chunk.journeyId, chunk.chunkId, {
      txHash: chunk.commitTxHash,
      blockNumber: commitment.committedBlock,
      gasUsed: null,
      confirmationMs: 0,
    });
    await this.repository.recordAgentEvent({
      journeyId: chunk.journeyId,
      chunkId: chunk.chunkId,
      role: workerRole(workerIndex),
      type: "chunk_recovered_from_chain",
      payload: { recovered: true, workerIndex },
    });
  }

  private async submitSaved(
    journeyId: Hex,
    chunkId: number,
    workerIndex: number,
  ): Promise<void> {
    const bundle = await this.repository.getJourneyBundle(journeyId);
    const chunk = findChunk(bundle.chunks, chunkId);
    if (!chunk.cardsRoot || chunk.cardCount !== chunk.cards.length || chunk.cards.length === 0) {
      throw new Error("Persisted chunk result is incomplete");
    }
    if (
      !verifyCommittedCards({
        journeyId,
        chunkId,
        cards: chunk.cards,
        expectedRoot: chunk.cardsRoot,
      })
    ) {
      throw new Error("Persisted chunk cards no longer match cardsRoot");
    }
    const existing = await this.registry.readChunk(journeyId, chunkId);
    if (existing) {
      await this.recoverExisting(chunk, existing, workerIndex);
      return;
    }
    if (chunk.commitTxHash) {
      const transactionStatus = await this.registry.readTransactionStatus(chunk.commitTxHash);
      if (transactionStatus === "PENDING") {
        throw new Error("Existing chunk commitment transaction is still pending");
      }
      if (transactionStatus === "SUCCESS") {
        throw new Error("Confirmed transaction is not yet reflected by the Registry RPC");
      }
    }
    const receipt = await this.registry.commitChunk(
      workerIndex,
      {
        journeyId,
        chunkId,
        sourceChunkHash: chunk.sourceChunkHash,
        cardsRoot: chunk.cardsRoot,
        cardCount: chunk.cards.length,
        manifestProof: chunk.manifestProof,
      },
      (txHash) => this.repository.markChunkSubmitting(journeyId, chunkId, txHash),
    );
    await this.repository.markChunkConfirmed(journeyId, chunkId, {
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      confirmationMs: receipt.confirmationMs,
    });
    await this.repository.recordAgentEvent({
      journeyId,
      chunkId,
      role: workerRole(workerIndex),
      type: "chunk_confirmed",
      payload: {
        workerIndex,
        cardCount: chunk.cards.length,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        confirmationMs: receipt.confirmationMs,
      },
      txHash: receipt.txHash,
    });
  }
}
