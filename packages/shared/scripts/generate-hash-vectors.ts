import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hex } from "viem";
import {
  KnowledgeCardContentSchema,
  ReviewPlanSchema,
  SourcePageSchema,
  buildCardTree,
  buildChunkManifest,
  deriveCardId,
  hashGoal,
  hashInitialPlan,
  hashKnowledgeCard,
  hashSourceChunk,
  hashSourcePages,
  type KnowledgeCardContent,
  type SourceChunkContent,
} from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(packageRoot, "../..");
const pagesFixture = JSON.parse(
  await readFile(path.join(root, "fixtures/reentrancy-pages.json"), "utf8"),
) as unknown;
const parsedPagesFixture = SourcePageSchema.array().parse(
  (pagesFixture as { pages: unknown }).pages,
);
const goal = (pagesFixture as { goal: string }).goal;
const journeyId = `0x${"11".repeat(32)}` as Hex;

function quote(pageNumber: number, exactText: string): string {
  const page = parsedPagesFixture.find((item) => item.pageNumber === pageNumber);
  if (!page?.text.includes(exactText)) {
    throw new Error(`Golden-vector quote was not found on page ${pageNumber}`);
  }
  return exactText;
}

const cardInputs: Record<number, KnowledgeCardContent[]> = {
  0: [
    {
      type: "concept",
      question: "Why can an external Solidity call enable reentrancy?",
      answer:
        "The call transfers control to code that can invoke the original contract again before its first invocation has restored every invariant.",
      keyPoint: "Treat every external interaction as a transfer of control.",
      source: {
        page: 1,
        quote: quote(
          1,
          "When it calls an untrusted address, control moves to that address until the external call returns.",
        ),
      },
      tags: ["reentrancy", "control-flow"],
      importance: 5,
      initialDifficulty: 2,
    },
    {
      type: "qa",
      question: "Why is clearing a withdrawal balance after sending Ether unsafe?",
      answer:
        "The receiver can call withdraw again during the transfer while the vault still exposes the old balance.",
      keyPoint: "A callback can reuse stale accounting state.",
      source: {
        page: 2,
        quote: quote(
          2,
          "Because the vault still records the old balance, the fallback can call withdraw again and pass the same balance check a second time.",
        ),
      },
      tags: ["withdrawal", "stale-state"],
      importance: 5,
      initialDifficulty: 3,
    },
  ],
  1: [
    {
      type: "concept",
      question: "What order does Checks-Effects-Interactions require?",
      answer:
        "Validate first, commit all internal state changes second, and interact with external contracts only after the invariant is restored.",
      keyPoint: "Complete effects before interactions.",
      source: {
        page: 4,
        quote: quote(
          4,
          "Checks-Effects-Interactions changes the order: validate preconditions, commit all internal state changes, and perform external interactions last.",
        ),
      },
      tags: ["defense", "cei"],
      importance: 5,
      initialDifficulty: 2,
    },
    {
      type: "qa",
      question: "Why is a reentrancy guard not a complete defense by itself?",
      answer:
        "An unguarded entry point or incorrectly scoped locks can still expose an invariant shared by several functions.",
      keyPoint: "The lock scope must match the invariant boundary.",
      source: {
        page: 5,
        quote: quote(
          5,
          "A guard is defense in depth, not a substitute for sound state ordering.",
        ),
      },
      tags: ["defense", "reentrancy-guard"],
      importance: 4,
      initialDifficulty: 3,
    },
  ],
  2: [
    {
      type: "concept",
      question: "What problem do pull payments isolate?",
      answer:
        "They separate recording a liability from delivering the asset, so delivery occurs in a small protected withdrawal path.",
      keyPoint: "Separate accounting from external delivery.",
      source: {
        page: 7,
        quote: quote(
          7,
          "Pull payments separate accounting from delivery. The protocol records an amount owed, and the recipient later withdraws it through a small, carefully protected function.",
        ),
      },
      tags: ["defense", "pull-payment"],
      importance: 4,
      initialDifficulty: 2,
    },
    {
      type: "qa",
      question: "What should a reentrancy test assert besides the attacker balance?",
      answer:
        "It should assert storage invariants and asset conservation across the complete callback path.",
      keyPoint: "Verify both accounting and assets under adversarial callbacks.",
      source: {
        page: 8,
        quote: quote(
          8,
          "Use invariant tests to assert that total liabilities never exceed controlled assets and that a user's withdrawal cannot reduce another user's claim.",
        ),
      },
      tags: ["testing", "invariants"],
      importance: 5,
      initialDifficulty: 4,
    },
  ],
};

const chunkRanges = [
  { chunkId: 0, pageStart: 1, pageEnd: 3, title: "Mechanics and exploit trace" },
  { chunkId: 1, pageStart: 4, pageEnd: 6, title: "State ordering and guard boundaries" },
  { chunkId: 2, pageStart: 7, pageEnd: 8, title: "Safer delivery and adversarial testing" },
];

const chunkDrafts = chunkRanges.map((range) => {
  const text = parsedPagesFixture
    .filter(
      (page) => page.pageNumber >= range.pageStart && page.pageNumber <= range.pageEnd,
    )
    .map((page) => page.text)
    .join("\n\n");
  const sourceChunk: SourceChunkContent = { ...range, text };
  return { sourceChunk, sourceChunkHash: hashSourceChunk(sourceChunk) };
});

const manifest = buildChunkManifest(
  journeyId,
  chunkDrafts.map(({ sourceChunk, sourceChunkHash }) => ({
    chunkId: sourceChunk.chunkId,
    sourceChunkHash,
  })),
);

const chunks = chunkDrafts.map(({ sourceChunk, sourceChunkHash }) => {
  const inputs = KnowledgeCardContentSchema.array().parse(cardInputs[sourceChunk.chunkId]);
  const cardsWithIds = inputs.map((content) => {
    const cardHash = hashKnowledgeCard(content);
    const cardId = deriveCardId(journeyId, sourceChunk.chunkId, cardHash);
    return { content, cardHash, cardId };
  });
  const cardTree = buildCardTree(cardsWithIds.map((card) => card.cardId));
  const manifestEntry = manifest.chunks.find(
    (entry) => entry.chunkId === sourceChunk.chunkId,
  );
  if (!manifestEntry) throw new Error("Manifest entry missing");

  return {
    chunkId: sourceChunk.chunkId,
    sourceChunk,
    sourceChunkHash,
    manifestLeaf: manifestEntry.leaf,
    manifestProof: manifestEntry.proof,
    cardsRoot: cardTree.root,
    cards: cardsWithIds.map((card) => {
      const commitment = cardTree.cards.find((item) => item.cardId === card.cardId);
      if (!commitment) throw new Error("Card commitment missing");
      return {
        ...card,
        cardLeaf: commitment.leaf,
        cardProof: commitment.proof,
      };
    }),
  };
});

const selectedCardIds = chunks.flatMap((chunk) => chunk.cards.map((card) => card.cardId));
const deckTree = buildCardTree(selectedCardIds);
const initialPlan = ReviewPlanSchema.parse({
  version: 1,
  generatedAt: "2026-07-20T00:00:00.000Z",
  days: Array.from({ length: 7 }, (_, dayOffset) => ({
    dayOffset,
    newCardIds:
      dayOffset < 3
        ? selectedCardIds.slice(dayOffset * 2, dayOffset * 2 + 2)
        : [],
    reviewCardIds: [],
  })),
});

const vector = {
  specVersion: "mindmark-hash-v1",
  algorithms: {
    canonicalJson: "RFC 8785 compatible json-canonicalize@2.0.0",
    digest: "keccak256(utf8(canonicalJson))",
    abi: "abi.encode(bytes32 journeyId, uint16 chunkId, bytes32 digest)",
    merkle: "OpenZeppelin SimpleMerkleTree; explicit business sort; sortLeaves=false",
  },
  journeyId,
  goal,
  goalHash: hashGoal(goal),
  pages: parsedPagesFixture,
  sourceHash: hashSourcePages(parsedPagesFixture),
  chunkManifestRoot: manifest.root,
  chunks,
  selectedCardIds: [...selectedCardIds].sort(),
  deckRoot: deckTree.root,
  deckProofs: deckTree.cards.map(({ cardId, proof }) => ({ cardId, proof })),
  initialPlan,
  initialPlanHash: hashInitialPlan(initialPlan),
};

await writeFile(
  path.join(root, "fixtures/hash-vectors.json"),
  `${JSON.stringify(vector, null, 2)}\n`,
);

console.log("Generated fixtures/hash-vectors.json");

