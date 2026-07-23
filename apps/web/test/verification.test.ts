import {
  buildCardTree,
  deriveCardId,
  hashKnowledgeCard,
  type CommittedKnowledgeCard,
} from "@mindmark/shared";
import { JourneyDetailResponseSchema } from "@mindmark/shared/schemas";
import { describe, expect, it } from "vitest";
import { verifyDeckAgainstChain } from "@/lib/client/verification";

const hex = (nibble: string) => `0x${nibble.repeat(64)}` as `0x${string}`;
const address = (nibble: string) => `0x${nibble.repeat(40)}` as `0x${string}`;
const journeyId = hex("1");

function fixture() {
  const cards: CommittedKnowledgeCard[] = [];
  const chunkRoots: `0x${string}`[] = [];
  for (let chunkId = 0; chunkId < 2; chunkId += 1) {
    const chunkCards = Array.from({ length: 2 }, (_, index) => {
      const content = {
        type: "qa" as const,
        question: `Question ${chunkId}-${index}`,
        answer: `Answer ${chunkId}-${index}`,
        keyPoint: `Point ${chunkId}-${index}`,
        source: {
          page: chunkId + 1,
          quote: `This is an exact source quotation for chunk ${chunkId} card ${index}.`,
        },
        tags: ["security"],
        importance: 4,
        initialDifficulty: 3,
      };
      const cardHash = hashKnowledgeCard(content);
      return {
        ...content,
        cardHash,
        id: deriveCardId(journeyId, chunkId, cardHash),
        chunkId,
      };
    });
    const tree = buildCardTree(chunkCards.map((card) => card.id));
    chunkRoots.push(tree.root);
    cards.push(
      ...chunkCards.map((card) => ({
        ...card,
        cardProof: tree.cards.find((item) => item.cardId === card.id)!.proof,
      })),
    );
  }
  const deckRoot = buildCardTree(cards.map((card) => card.id)).root;
  const detail = JourneyDetailResponseSchema.parse({
    journeyId,
    status: "READY",
    sourceHash: hex("2"),
    chunkManifestRoot: hex("3"),
    createTxHash: hex("4"),
    finalizeTxHash: hex("5"),
    deckRoot,
    planHash: hex("6"),
    planVersion: 1,
    deck: cards,
    provenance: Object.fromEntries(
      cards.map((card) => [
        card.id,
        { chunkId: card.chunkId, cardLeaf: card.id, chunkProof: card.cardProof },
      ]),
    ),
    plan: null,
    chunks: [0, 1].map((chunkId) => ({
      chunkId,
      pageStart: chunkId + 1,
      pageEnd: chunkId + 1,
      title: `Chunk ${chunkId}`,
      sourceChunkHash: hex(String(7 + chunkId)),
      cardsRoot: chunkRoots[chunkId],
      workerAddress: address(String(2 + chunkId)),
      status: "MERGED",
      cardCount: 2,
      commitTxHash: hex(chunkId === 0 ? "9" : "a"),
      confirmedBlock: "100",
      gasUsed: "80000",
      generationMs: 200,
      confirmationMs: 30,
    })),
    studyQueue: { dueCount: 0, newCount: 4, queue: cards.map((card) => ({ reason: "planned", card })) },
  });
  const chain = {
    journey: { status: 2, sourceHash: detail.sourceHash, deckRoot, totalCardCount: 4 },
    chunks: detail.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      sourceChunkHash: chunk.sourceChunkHash,
      cardsRoot: chunk.cardsRoot!,
      agent: chunk.workerAddress!,
      cardCount: chunk.cardCount!,
    })),
  };
  return { detail, chain };
}

describe("Step 9 browser deck verification", () => {
  it("matches an intact deck and detects a changed answer", () => {
    const { detail, chain } = fixture();
    expect(verifyDeckAgainstChain({ detail, ...chain }).result).toBe("全部匹配");

    const changed = structuredClone(detail);
    changed.deck![0]!.answer = "Tampered answer";
    const result = verifyDeckAgainstChain({ detail: changed, ...chain });
    expect(result.result).toBe("部分不匹配");
    expect(result.cardMatches[changed.deck![0]!.id]).toBe(false);
  });

  it("reports missing data separately from a mismatch", () => {
    const { detail, chain } = fixture();
    expect(verifyDeckAgainstChain({ detail: { ...detail, deck: null }, ...chain }).result).toBe(
      "无法验证：缺少数据",
    );
  });
});
