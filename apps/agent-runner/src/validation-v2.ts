import {
  KnowledgeCardContentSchema,
  Bytes32Schema,
  WorkerKnowledgeCardV2Schema,
  buildCardTree,
  deriveCardIdV2,
  hashKnowledgeCard,
  normalizeSourceText,
  validateCitation,
  verifyMerkleProof,
  type KnowledgeCardContent,
  type CardBlueprintSlot,
  type SourceBlock,
  type SourcePage,
  type WorkerKnowledgeCardV2,
} from "@mindmark/shared";
import type { Hex } from "viem";

export type CardValidationV2 =
  | { valid: false; errors: string[] }
  | { valid: true; cards: WorkerKnowledgeCardV2[]; cardsRoot: Hex };

const BlueprintCardDraftSchema = KnowledgeCardContentSchema.extend({
  blueprintSlotId: Bytes32Schema,
}).strict();

export type CardValidationV3 =
  | { valid: false; errors: string[] }
  | {
      valid: true;
      cards: WorkerKnowledgeCardV2[];
      cardsRoot: Hex;
      slotCandidates: Array<{ slotId: Hex; cardId: Hex }>;
    };

const contextDependentPattern =
  /(?:根据上文|如上所述|前文提到|this section|the text above|as described above)/iu;

function pagesFromBlocks(blocks: SourceBlock[]): SourcePage[] {
  const pages = new Map<number, string[]>();
  for (const block of blocks) {
    const current = pages.get(block.pageNumber) ?? [];
    current.push(block.text);
    pages.set(block.pageNumber, current);
  }
  return [...pages.entries()].map(([pageNumber, texts]) => ({
    pageNumber,
    text: texts.join("\n\n"),
  }));
}

function contentOf(card: WorkerKnowledgeCardV2): KnowledgeCardContent {
  return {
    type: card.type,
    question: card.question,
    answer: card.answer,
    keyPoint: card.keyPoint,
    source: card.source,
    tags: card.tags,
    importance: card.importance,
    initialDifficulty: card.initialDifficulty,
  };
}

export function validateAndCommitCardsV2(input: {
  rawCards: unknown;
  projectId: Hex;
  chapterId: number;
  workUnitId: number;
  cardMinimum: number;
  cardTarget: number;
  cardBudget: number;
  sourceBlocks: SourceBlock[];
}): CardValidationV2 {
  const parsed = KnowledgeCardContentSchema.array().min(1).safeParse(input.rawCards);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "cards"}: ${issue.message}`),
    };
  }
  if (parsed.data.length > input.cardBudget) {
    return { valid: false, errors: [`Generated ${parsed.data.length} cards but budget is ${input.cardBudget}`] };
  }
  if (parsed.data.length < input.cardMinimum) {
    return {
      valid: false,
      errors: [
        `Generated ${parsed.data.length} cards but the minimum is ${input.cardMinimum}; target ${input.cardTarget}`,
      ],
    };
  }
  const pages = pagesFromBlocks(input.sourceBlocks);
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, card] of parsed.data.entries()) {
    const citation = validateCitation(card, pages);
    if (!citation.valid) errors.push(`cards.${index}.source: ${citation.error}`);
    const duplicateKey = `${normalizeSourceText(card.question).toLowerCase()}|${normalizeSourceText(card.keyPoint).toLowerCase()}`;
    if (seen.has(duplicateKey)) errors.push(`cards.${index}: exact duplicate`);
    seen.add(duplicateKey);
    if (contextDependentPattern.test(card.question) || contextDependentPattern.test(card.answer)) {
      errors.push(`cards.${index}: depends on missing context`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  const drafts = parsed.data.map((content) => {
    const cardHash = hashKnowledgeCard(content);
    return {
      content,
      cardHash,
      id: deriveCardIdV2(input.projectId, input.chapterId, input.workUnitId, cardHash),
    };
  });
  const tree = buildCardTree(drafts.map((card) => card.id));
  const cards = drafts.map(({ content, cardHash, id }) => {
    const proof = tree.cards.find((candidate) => candidate.cardId === id)?.proof;
    if (!proof) throw new Error("Worker card proof was not generated");
    return WorkerKnowledgeCardV2Schema.parse({
      ...content,
      id,
      cardHash,
      projectId: input.projectId,
      chapterId: input.chapterId,
      workUnitId: input.workUnitId,
      workerProof: proof,
    });
  });
  return { valid: true, cards, cardsRoot: tree.root };
}

export function verifyCommittedCardsV2(input: {
  projectId: Hex;
  chapterId: number;
  workUnitId: number;
  cards: WorkerKnowledgeCardV2[];
  expectedRoot: Hex;
}): boolean {
  const cards = WorkerKnowledgeCardV2Schema.array().min(1).parse(input.cards);
  for (const card of cards) {
    if (
      card.projectId !== input.projectId ||
      card.chapterId !== input.chapterId ||
      card.workUnitId !== input.workUnitId
    ) return false;
    const cardHash = hashKnowledgeCard(contentOf(card));
    if (cardHash !== card.cardHash) return false;
    if (deriveCardIdV2(input.projectId, input.chapterId, input.workUnitId, cardHash) !== card.id) return false;
    if (!verifyMerkleProof(input.expectedRoot, card.id, card.workerProof)) return false;
  }
  return buildCardTree(cards.map((card) => card.id)).root === input.expectedRoot;
}

export function validateAndCommitBlueprintCardsV3(input: {
  rawCards: unknown;
  projectId: Hex;
  chapterId: number;
  workUnitId: number;
  slots: CardBlueprintSlot[];
  sourceBlocks: SourceBlock[];
}): CardValidationV3 {
  const parsed = BlueprintCardDraftSchema.array().min(1).safeParse(input.rawCards);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "cards"}: ${issue.message}`),
    };
  }
  const expectedSlots = new Map(input.slots.map((slot) => [slot.slotId, slot]));
  const seenSlots = new Set<string>();
  const errors: string[] = [];
  if (parsed.data.length !== input.slots.length) {
    errors.push(`Generated ${parsed.data.length} cards but exactly ${input.slots.length} Blueprint Slots are assigned`);
  }
  for (const [index, draft] of parsed.data.entries()) {
    const slot = expectedSlots.get(draft.blueprintSlotId);
    if (!slot) {
      errors.push(`cards.${index}.blueprintSlotId: Slot is not assigned to this Work Unit`);
      continue;
    }
    if (seenSlots.has(slot.slotId)) errors.push(`cards.${index}.blueprintSlotId: duplicate Slot`);
    seenSlots.add(slot.slotId);
    const expectedType = slot.type === "concept" ? "concept" : "qa";
    if (draft.type !== expectedType) {
      errors.push(`cards.${index}.type: ${slot.type} Slot requires ${expectedType} card content`);
    }
    if (draft.initialDifficulty !== slot.difficulty) {
      errors.push(`cards.${index}.initialDifficulty: must match Blueprint difficulty ${slot.difficulty}`);
    }
    const evidenceBlocks = input.sourceBlocks.filter((block) =>
      slot.sourceBlockIndexes.includes(block.blockIndex),
    );
    const citation = validateCitation(draft, pagesFromBlocks(evidenceBlocks));
    if (!citation.valid) {
      errors.push(`cards.${index}.source: citation is outside the Blueprint Slot evidence`);
    }
  }
  for (const slot of input.slots) {
    if (!seenSlots.has(slot.slotId)) errors.push(`Blueprint Slot ${slot.slotId} has no candidate`);
  }
  if (errors.length > 0) return { valid: false, errors };

  const contents = parsed.data.map(({ blueprintSlotId: _slotId, ...content }) => content);
  const committed = validateAndCommitCardsV2({
    rawCards: contents,
    projectId: input.projectId,
    chapterId: input.chapterId,
    workUnitId: input.workUnitId,
    cardMinimum: input.slots.length,
    cardTarget: input.slots.length,
    cardBudget: input.slots.length,
    sourceBlocks: input.sourceBlocks,
  });
  if (!committed.valid) return committed;
  return {
    ...committed,
    slotCandidates: parsed.data.map((draft, index) => ({
      slotId: draft.blueprintSlotId,
      cardId: committed.cards[index]!.id,
    })),
  };
}

export function freezeWorkerCandidatesV2(
  rawCards: WorkerKnowledgeCardV2[],
): { cards: WorkerKnowledgeCardV2[]; cardsRoot: Hex } {
  const cards = WorkerKnowledgeCardV2Schema.array().min(1).parse(rawCards);
  const tree = buildCardTree(cards.map((card) => card.id));
  return {
    cards: cards.map((card) => {
      const proof = tree.cards.find((candidate) => candidate.cardId === card.id)?.proof;
      if (!proof) throw new Error("Approved Worker card proof was not generated");
      return WorkerKnowledgeCardV2Schema.parse({ ...card, workerProof: proof });
    }),
    cardsRoot: tree.root,
  };
}

export { contentOf as contentFromWorkerCardV2 };
