import {
  Bytes32Schema,
  ReviewPlanSchema,
  buildCardTree,
  hashInitialPlan,
  type CommittedKnowledgeCard,
  type ReviewPlan,
} from "@mindmark/shared";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import type {
  AgentToolDefinition,
  AgentTranscriptEntry,
  FinalizationRecord,
  JourneyBundle,
  RegistryGateway,
  RunnerRepository,
  ToolCallingModel,
} from "./types.js";
import { verifyCommittedCards } from "./validation.js";

const EmptyArgumentsSchema = z.object({}).strict();
const PrerequisiteSchema = z
  .object({ beforeCardId: Bytes32Schema, afterCardId: Bytes32Schema })
  .strict();
const SelectionSchema = z
  .object({
    selectedCardIds: z.array(Bytes32Schema).min(4).max(30),
    prerequisites: z.array(PrerequisiteSchema).max(100).default([]),
  })
  .strict();

export type PrerequisiteEdge = z.infer<typeof PrerequisiteSchema>;

const finalizerTools: AgentToolDefinition[] = [
  {
    name: "read_committed_cards",
    description: "Read the immutable Worker cards available for selection.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "select_final_cards",
    description:
      "Select existing card IDs and optional prerequisite edges. Card content cannot be supplied or rewritten.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["selectedCardIds", "prerequisites"],
      properties: {
        selectedCardIds: {
          type: "array",
          minItems: 4,
          maxItems: 30,
          items: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
        },
        prerequisites: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["beforeCardId", "afterCardId"],
            properties: {
              beforeCardId: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
              afterCardId: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
            },
          },
        },
      },
    },
  },
];

function cardPriority(left: CommittedKnowledgeCard, right: CommittedKnowledgeCard): number {
  return (
    right.importance - left.importance ||
    right.initialDifficulty - left.initialDifficulty ||
    left.id.localeCompare(right.id)
  );
}

function orderByPrerequisites(
  cards: CommittedKnowledgeCard[],
  edges: PrerequisiteEdge[],
): CommittedKnowledgeCard[] {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const indegree = new Map(cards.map((card) => [card.id, 0]));
  const outgoing = new Map(cards.map((card) => [card.id, new Set<Hex>()]));
  for (const edge of edges) {
    if (!cardsById.has(edge.beforeCardId) || !cardsById.has(edge.afterCardId)) {
      throw new Error("Prerequisite edges must reference selected card IDs");
    }
    if (edge.beforeCardId === edge.afterCardId) {
      throw new Error("A card cannot be its own prerequisite");
    }
    const targets = outgoing.get(edge.beforeCardId)!;
    if (!targets.has(edge.afterCardId)) {
      targets.add(edge.afterCardId);
      indegree.set(edge.afterCardId, indegree.get(edge.afterCardId)! + 1);
    }
  }

  const available = cards.filter((card) => indegree.get(card.id) === 0).sort(cardPriority);
  const ordered: CommittedKnowledgeCard[] = [];
  while (available.length > 0) {
    const card = available.shift()!;
    ordered.push(card);
    for (const target of outgoing.get(card.id)!) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) {
        available.push(cardsById.get(target)!);
        available.sort(cardPriority);
      }
    }
  }
  if (ordered.length !== cards.length) throw new Error("Prerequisite edges contain a cycle");
  return ordered;
}

export function buildInitialPlan(input: {
  cards: CommittedKnowledgeCard[];
  prerequisites?: PrerequisiteEdge[];
  generatedAt?: string;
}): ReviewPlan {
  if (input.cards.length < 4 || input.cards.length > 30) {
    throw new RangeError("The initial deck must contain 4 to 30 cards");
  }
  const ordered = orderByPrerequisites(input.cards, input.prerequisites ?? []);
  const perDay = Math.min(8, Math.max(3, Math.ceil(ordered.length / 7)));
  const days = Array.from({ length: 7 }, (_, dayOffset) => ({
    dayOffset,
    newCardIds: [] as Hex[],
    reviewCardIds: [] as Hex[],
  }));
  const introducedOn = new Map<Hex, number>();
  for (const [index, card] of ordered.entries()) {
    const dayOffset = Math.min(6, Math.floor(index / perDay));
    days[dayOffset]!.newCardIds.push(card.id);
    introducedOn.set(card.id, dayOffset);
  }

  for (const card of ordered) {
    const introduced = introducedOn.get(card.id)!;
    const dueDays = [introduced + 2];
    if (card.importance === 5) dueDays.push(introduced + 5);
    for (const dueDay of dueDays) {
      const day = days[dueDay];
      if (
        day &&
        (card.importance >= 4 || card.initialDifficulty >= 4) &&
        day.newCardIds.length + day.reviewCardIds.length < 15
      ) {
        day.reviewCardIds.push(card.id);
      }
    }
  }

  return ReviewPlanSchema.parse({
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    days,
  });
}

function validateSavedFinalization(bundle: JourneyBundle): FinalizationRecord | null {
  const { journey } = bundle;
  if (
    !journey.deck ||
    !journey.provenance ||
    !journey.deckRoot ||
    !journey.plan ||
    !journey.planHash
  ) {
    return null;
  }
  if (journey.deck.length < 4 || journey.deck.length > 30) {
    throw new Error("Persisted final deck has an invalid card count");
  }
  if (buildCardTree(journey.deck.map((card) => card.id)).root !== journey.deckRoot) {
    throw new Error("Persisted final deck no longer matches deckRoot");
  }
  if (hashInitialPlan(journey.plan) !== journey.planHash) {
    throw new Error("Persisted initial plan no longer matches planHash");
  }
  for (const card of journey.deck) {
    const provenance = journey.provenance[card.id];
    if (
      !provenance ||
      provenance.chunkId !== card.chunkId ||
      provenance.cardLeaf !== card.id ||
      JSON.stringify(provenance.chunkProof) !== JSON.stringify(card.cardProof)
    ) {
      throw new Error(`Persisted provenance is invalid for card ${card.id}`);
    }
  }
  return {
    deck: journey.deck,
    provenance: journey.provenance,
    deckRoot: journey.deckRoot,
    plan: journey.plan,
    planHash: journey.planHash,
  };
}

export class FinalizerAgent {
  constructor(
    private readonly repository: RunnerRepository,
    private readonly registry: RegistryGateway,
    private readonly model: ToolCallingModel,
    private readonly options: {
      maxToolCalls?: number;
      timeoutMs?: number;
      now?: () => Date;
    } = {},
  ) {}

  async prepare(journeyId: Hex): Promise<FinalizationRecord> {
    const bundle = await this.repository.getJourneyBundle(journeyId);
    const saved = validateSavedFinalization(bundle);
    if (saved) return saved;

    const allCards: CommittedKnowledgeCard[] = [];
    for (const chunk of bundle.chunks) {
      if (chunk.status !== "CONFIRMED" || !chunk.cardsRoot || !chunk.cardCount) {
        throw new Error(`Chunk ${chunk.chunkId} is not ready for finalization`);
      }
      const chain = await this.registry.readChunk(journeyId, chunk.chunkId);
      const expectedWorker = this.registry.workerAddress(chunk.chunkId % 3);
      if (
        !chain ||
        chain.sourceChunkHash !== chunk.sourceChunkHash ||
        chain.cardsRoot !== chunk.cardsRoot ||
        chain.cardCount !== chunk.cardCount ||
        getAddress(chain.agent) !== getAddress(expectedWorker) ||
        !verifyCommittedCards({
          journeyId,
          chunkId: chunk.chunkId,
          cards: chunk.cards,
          expectedRoot: chunk.cardsRoot,
        })
      ) {
        throw new Error(`Chunk ${chunk.chunkId} does not match its Monad commitment`);
      }
      allCards.push(...chunk.cards);
    }
    if (allCards.length < 4) throw new Error("Workers produced fewer than four valid cards");

    const cardsById = new Map(allCards.map((card) => [card.id, card]));
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Finalizer tool loop timed out")),
      this.options.timeoutMs ?? 30_000,
    );
    timeout.unref();
    const transcript: AgentTranscriptEntry[] = [];
    let hasRead = false;
    let selectionRepairCount = 0;

    try {
      for (let callIndex = 0; callIndex < (this.options.maxToolCalls ?? 6); callIndex += 1) {
        const call = await this.model.nextTool({
          system:
            "You are the Mindmark Finalizer. You may only select or delete immutable committed cards and declare prerequisite edges. Never rewrite card content.",
          task: `Select a coherent 4-30 card deck for Journey ${journeyId}.`,
          tools: finalizerTools,
          transcript,
          signal: controller.signal,
        });
        let result: unknown;
        if (call.name === "read_committed_cards") {
          EmptyArgumentsSchema.parse(call.arguments);
          hasRead = true;
          result = {
            cards: allCards.map((card) => ({
              id: card.id,
              chunkId: card.chunkId,
              type: card.type,
              question: card.question,
              answer: card.answer,
              keyPoint: card.keyPoint,
              source: card.source,
              tags: card.tags,
              importance: card.importance,
              initialDifficulty: card.initialDifficulty,
            })),
          };
        } else if (call.name === "select_final_cards") {
          if (!hasRead) {
            result = { accepted: false, errors: ["read_committed_cards must be called first"] };
          } else {
            const parsed = SelectionSchema.safeParse(call.arguments);
            const errors: string[] = [];
            if (!parsed.success) {
              errors.push(...parsed.error.issues.map((issue) => issue.message));
            } else {
              if (new Set(parsed.data.selectedCardIds).size !== parsed.data.selectedCardIds.length) {
                errors.push("selectedCardIds must be unique");
              }
              if (parsed.data.selectedCardIds.some((id) => !cardsById.has(id))) {
                errors.push("selectedCardIds contains a card that was not committed by a Worker");
              }
              const selected = parsed.data.selectedCardIds.flatMap((id) => {
                const card = cardsById.get(id);
                return card ? [card] : [];
              });
              if (errors.length === 0) {
                try {
                  const plan = buildInitialPlan({
                    cards: selected,
                    prerequisites: parsed.data.prerequisites,
                    generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
                  });
                  const deckRoot = buildCardTree(selected.map((card) => card.id)).root;
                  const provenance = Object.fromEntries(
                    selected.map((card) => [
                      card.id,
                      {
                        chunkId: card.chunkId,
                        cardLeaf: card.id,
                        chunkProof: card.cardProof,
                      },
                    ]),
                  ) as Record<Hex, { chunkId: number; cardLeaf: Hex; chunkProof: Hex[] }>;
                  const record: FinalizationRecord = {
                    deck: selected,
                    provenance,
                    deckRoot,
                    plan,
                    planHash: hashInitialPlan(plan),
                  };
                  await this.repository.saveFinalization(journeyId, record);
                  await this.repository.recordAgentEvent({
                    journeyId,
                    role: "finalizer",
                    type: "finalization_saved",
                    payload: { selectedCount: selected.length },
                  });
                  return record;
                } catch (error) {
                  errors.push(error instanceof Error ? error.message : "Invalid selection");
                }
              }
            }
            selectionRepairCount += 1;
            if (selectionRepairCount > 1) {
              throw new Error("Finalizer exceeded the single selection repair");
            }
            result = { accepted: false, errors };
          }
        } else {
          result = { error: `Unknown tool: ${call.name}` };
        }
        transcript.push({ call, result });
      }
      throw new Error("Finalizer exhausted its tool-call budget before selecting a deck");
    } finally {
      clearTimeout(timeout);
    }
  }
}
