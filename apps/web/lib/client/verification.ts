import {
  buildCardTree,
  deriveCardId,
  hashKnowledgeCard,
  verifyMerkleProof,
  type JourneyDetailResponse,
  type KnowledgeCardContent,
} from "@mindmark/shared";
import type { Hex } from "viem";

export type ChainJourneyVerification = {
  status: number;
  sourceHash: Hex;
  deckRoot: Hex;
  totalCardCount: number;
};

export type ChainChunkVerification = {
  chunkId: number;
  sourceChunkHash: Hex;
  cardsRoot: Hex;
  agent: `0x${string}`;
  cardCount: number;
};

export type DeckVerification = {
  result: "全部匹配" | "部分不匹配" | "无法验证：缺少数据";
  deckMatches: boolean;
  cardMatches: Record<Hex, boolean>;
  chunkMatches: Record<number, boolean>;
};

function contentOf(card: NonNullable<JourneyDetailResponse["deck"]>[number]): KnowledgeCardContent {
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

export function verifyDeckAgainstChain(input: {
  detail: JourneyDetailResponse;
  journey: ChainJourneyVerification | null;
  chunks: ChainChunkVerification[];
}): DeckVerification {
  const cardMatches: Record<Hex, boolean> = {};
  const chunkMatches: Record<number, boolean> = {};
  const { detail, journey } = input;
  if (!detail.deck || !detail.provenance || !detail.deckRoot || !journey) {
    return {
      result: "无法验证：缺少数据",
      deckMatches: false,
      cardMatches,
      chunkMatches,
    };
  }
  const chainChunks = new Map(input.chunks.map((chunk) => [chunk.chunkId, chunk]));
  for (const chunk of detail.chunks) {
    const chain = chainChunks.get(chunk.chunkId);
    chunkMatches[chunk.chunkId] = Boolean(
      chain &&
        chunk.cardsRoot &&
        chunk.workerAddress &&
        chain.cardsRoot === chunk.cardsRoot &&
        chain.sourceChunkHash === chunk.sourceChunkHash &&
        chain.agent.toLowerCase() === chunk.workerAddress.toLowerCase() &&
        chain.cardCount === chunk.cardCount,
    );
  }
  for (const card of detail.deck) {
    const provenance = detail.provenance[card.id];
    const chain = chainChunks.get(card.chunkId);
    const cardHash = hashKnowledgeCard(contentOf(card));
    cardMatches[card.id] = Boolean(
      provenance &&
        chain &&
        cardHash === card.cardHash &&
        deriveCardId(detail.journeyId, card.chunkId, cardHash) === card.id &&
        provenance.cardLeaf === card.id &&
        provenance.chunkId === card.chunkId &&
        JSON.stringify(provenance.chunkProof) === JSON.stringify(card.cardProof) &&
        verifyMerkleProof(chain.cardsRoot, card.id, provenance.chunkProof),
    );
  }
  let calculatedDeckRoot: Hex | null = null;
  try {
    calculatedDeckRoot = buildCardTree(detail.deck.map((card) => card.id)).root;
  } catch {
    calculatedDeckRoot = null;
  }
  const deckMatches =
    journey.status === 2 &&
    journey.sourceHash === detail.sourceHash &&
    journey.deckRoot === detail.deckRoot &&
    journey.totalCardCount === detail.deck.length &&
    calculatedDeckRoot === detail.deckRoot &&
    Object.values(cardMatches).every(Boolean) &&
    Object.values(chunkMatches).every(Boolean);
  return {
    result: deckMatches ? "全部匹配" : "部分不匹配",
    deckMatches,
    cardMatches,
    chunkMatches,
  };
}
