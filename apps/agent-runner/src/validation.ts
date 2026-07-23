import {
  CommittedKnowledgeCardSchema,
  KnowledgeCardContentSchema,
  buildCardTree,
  deriveCardId,
  hashKnowledgeCard,
  normalizeSourceText,
  validateCitation,
  verifyMerkleProof,
  type CommittedKnowledgeCard,
  type KnowledgeCardContent,
  type SourcePage,
} from "@mindmark/shared";
import type { Hex } from "viem";

export type CardValidation =
  | { valid: false; errors: string[] }
  | { valid: true; cards: CommittedKnowledgeCard[]; cardsRoot: Hex };

const contextDependentPattern =
  /(?:根据上文|如上所述|前文提到|this section|the text above|as described above)/iu;

function contentFromCommitted(card: CommittedKnowledgeCard): KnowledgeCardContent {
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

export function validateAndCommitCards(input: {
  rawCards: unknown;
  journeyId: Hex;
  chunkId: number;
  cardBudget: number;
  sourcePages: SourcePage[];
}): CardValidation {
  const parsed = KnowledgeCardContentSchema.array().min(1).safeParse(input.rawCards);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "cards"}: ${issue.message}`,
      ),
    };
  }
  if (parsed.data.length > input.cardBudget) {
    return {
      valid: false,
      errors: [`Generated ${parsed.data.length} cards but budget is ${input.cardBudget}`],
    };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, card] of parsed.data.entries()) {
    const citation = validateCitation(card, input.sourcePages);
    if (!citation.valid) errors.push(`cards.${index}.source: ${citation.error}`);
    const duplicateKey = `${normalizeSourceText(card.question).toLowerCase()}|${normalizeSourceText(
      card.keyPoint,
    ).toLowerCase()}`;
    if (seen.has(duplicateKey)) errors.push(`cards.${index}: exact duplicate`);
    seen.add(duplicateKey);
    if (
      contextDependentPattern.test(card.question) ||
      contextDependentPattern.test(card.answer)
    ) {
      errors.push(`cards.${index}: depends on missing context`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  const cardsWithIds = parsed.data.map((content) => {
    const cardHash = hashKnowledgeCard(content);
    return {
      content,
      cardHash,
      id: deriveCardId(input.journeyId, input.chunkId, cardHash),
    };
  });
  const tree = buildCardTree(cardsWithIds.map((card) => card.id));
  const cards = cardsWithIds.map(({ content, cardHash, id }) => {
    const commitment = tree.cards.find((item) => item.cardId === id);
    if (!commitment) throw new Error("Card proof was not generated");
    return CommittedKnowledgeCardSchema.parse({
      ...content,
      id,
      cardHash,
      chunkId: input.chunkId,
      cardProof: commitment.proof,
    });
  });
  return { valid: true, cards, cardsRoot: tree.root };
}

export function verifyCommittedCards(input: {
  journeyId: Hex;
  chunkId: number;
  cards: CommittedKnowledgeCard[];
  expectedRoot: Hex;
}): boolean {
  const cards = CommittedKnowledgeCardSchema.array().min(1).parse(input.cards);
  for (const card of cards) {
    if (card.chunkId !== input.chunkId) return false;
    const content = contentFromCommitted(card);
    const cardHash = hashKnowledgeCard(content);
    if (cardHash !== card.cardHash) return false;
    if (deriveCardId(input.journeyId, input.chunkId, cardHash) !== card.id) return false;
    if (!verifyMerkleProof(input.expectedRoot, card.id, card.cardProof)) return false;
  }
  return buildCardTree(cards.map((card) => card.id)).root === input.expectedRoot;
}

export { contentFromCommitted };

