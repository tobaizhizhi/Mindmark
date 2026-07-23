import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hex } from "viem";
import { zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import {
  KnowledgeCardContentSchema,
  ReviewPlanSchema,
  SourceChunkContentSchema,
  SourcePageSchema,
  buildCardTree,
  buildChunkManifest,
  deriveCardId,
  hashGoal,
  hashInitialPlan,
  hashKnowledgeCard,
  hashSourceChunk,
  hashSourcePages,
  verifyMerkleProof,
} from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const vector = JSON.parse(
  await readFile(path.join(root, "fixtures/hash-vectors.json"), "utf8"),
) as {
  journeyId: Hex;
  goal: string;
  goalHash: Hex;
  pages: unknown;
  sourceHash: Hex;
  chunkManifestRoot: Hex;
  chunks: Array<{
    chunkId: number;
    sourceChunk: unknown;
    sourceChunkHash: Hex;
    manifestLeaf: Hex;
    manifestProof: Hex[];
    cardsRoot: Hex;
    cards: Array<{
      content: unknown;
      cardHash: Hex;
      cardId: Hex;
      cardLeaf: Hex;
      cardProof: Hex[];
    }>;
  }>;
  selectedCardIds: Hex[];
  deckRoot: Hex;
  deckProofs: Array<{ cardId: Hex; proof: Hex[] }>;
  initialPlan: unknown;
  initialPlanHash: Hex;
};

describe("golden hash and Merkle vectors", () => {
  it("recomputes every canonical hash and ABI-derived card id", () => {
    const pages = SourcePageSchema.array().parse(vector.pages);
    expect(hashSourcePages(pages)).toBe(vector.sourceHash);
    expect(hashSourcePages(pages)).toBe(hashSourcePages(structuredClone(pages)));
    expect(hashGoal(vector.goal)).toBe(vector.goalHash);
    expect(hashInitialPlan(ReviewPlanSchema.parse(vector.initialPlan))).toBe(
      vector.initialPlanHash,
    );

    for (const chunk of vector.chunks) {
      expect(hashSourceChunk(SourceChunkContentSchema.parse(chunk.sourceChunk))).toBe(
        chunk.sourceChunkHash,
      );
      for (const card of chunk.cards) {
        const content = KnowledgeCardContentSchema.parse(card.content);
        expect(hashKnowledgeCard(content)).toBe(card.cardHash);
        expect(deriveCardId(vector.journeyId, chunk.chunkId, card.cardHash)).toBe(
          card.cardId,
        );
        expect(card.cardLeaf).toBe(card.cardId);
      }
    }
  });

  it("recomputes roots and verifies every proof", () => {
    const manifest = buildChunkManifest(
      vector.journeyId,
      vector.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        sourceChunkHash: chunk.sourceChunkHash,
      })),
    );
    expect(manifest.root).toBe(vector.chunkManifestRoot);

    for (const chunk of vector.chunks) {
      expect(
        verifyMerkleProof(vector.chunkManifestRoot, chunk.manifestLeaf, chunk.manifestProof),
      ).toBe(true);
      const cardTree = buildCardTree(chunk.cards.map((card) => card.cardId));
      expect(cardTree.root).toBe(chunk.cardsRoot);
      for (const card of chunk.cards) {
        expect(verifyMerkleProof(chunk.cardsRoot, card.cardLeaf, card.cardProof)).toBe(true);
      }
    }

    const deckTree = buildCardTree(vector.selectedCardIds);
    expect(deckTree.root).toBe(vector.deckRoot);
    for (const item of vector.deckProofs) {
      expect(verifyMerkleProof(vector.deckRoot, item.cardId, item.proof)).toBe(true);
    }
  });

  it("changes commitments when card content, citation, or chunk id changes", () => {
    const firstChunk = vector.chunks[0];
    const firstCard = firstChunk?.cards[0];
    if (!firstChunk || !firstCard) throw new Error("Golden vector is incomplete");
    const content = KnowledgeCardContentSchema.parse(firstCard.content);

    const changedAnswerHash = hashKnowledgeCard({ ...content, answer: `${content.answer} Changed.` });
    const changedQuoteHash = hashKnowledgeCard({
      ...content,
      source: { ...content.source, quote: `${content.source.quote} Extra context.` },
    });
    expect(changedAnswerHash).not.toBe(firstCard.cardHash);
    expect(changedQuoteHash).not.toBe(firstCard.cardHash);

    const originalRoot = buildCardTree([firstCard.cardId, firstChunk.cards[1]!.cardId]).root;
    const changedCardId = deriveCardId(vector.journeyId, firstChunk.chunkId, changedAnswerHash);
    expect(buildCardTree([changedCardId, firstChunk.cards[1]!.cardId]).root).not.toBe(
      originalRoot,
    );

    const changedChunkManifest = buildChunkManifest(
      vector.journeyId,
      vector.chunks.map((chunk) => ({
        chunkId: chunk.chunkId === 0 ? 9 : chunk.chunkId,
        sourceChunkHash: chunk.sourceChunkHash,
      })),
    );
    expect(changedChunkManifest.root).not.toBe(vector.chunkManifestRoot);
  });

  it("rejects a wrong proof", () => {
    const chunk = vector.chunks[0];
    if (!chunk) throw new Error("Golden vector is incomplete");
    const wrongProof = [...chunk.manifestProof];
    wrongProof[0] = zeroHash;
    expect(verifyMerkleProof(vector.chunkManifestRoot, chunk.manifestLeaf, wrongProof)).toBe(
      false,
    );
  });
});

