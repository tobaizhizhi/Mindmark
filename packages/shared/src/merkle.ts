import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { Bytes32Schema, MAX_SOURCE_CHUNKS } from "./schemas.js";

export type ManifestChunk = {
  chunkId: number;
  sourceChunkHash: Hex;
};

export type ManifestCommitment = ManifestChunk & {
  leaf: Hex;
  proof: Hex[];
};

export type CardCommitment = {
  cardId: Hex;
  leaf: Hex;
  proof: Hex[];
};

function assertUint16(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError(`${field} must fit uint16`);
  }
}

function ensureUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} values must be unique`);
  }
}

export function manifestLeaf(
  journeyId: Hex,
  chunkId: number,
  sourceChunkHash: Hex,
): Hex {
  assertUint16(chunkId, "chunkId");
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }],
      [Bytes32Schema.parse(journeyId), chunkId, Bytes32Schema.parse(sourceChunkHash)],
    ),
  );
}

export function buildChunkManifest(
  journeyId: Hex,
  chunks: ManifestChunk[],
): { root: Hex; chunks: ManifestCommitment[] } {
  if (chunks.length < 2 || chunks.length > MAX_SOURCE_CHUNKS) {
    throw new RangeError(`A chunk manifest must contain 2 to ${MAX_SOURCE_CHUNKS} chunks`);
  }

  const sorted = [...chunks].sort((left, right) => left.chunkId - right.chunkId);
  ensureUnique(
    sorted.map((chunk) => chunk.chunkId.toString()),
    "chunkId",
  );
  const leaves = sorted.map((chunk) =>
    manifestLeaf(journeyId, chunk.chunkId, chunk.sourceChunkHash),
  );
  const tree = SimpleMerkleTree.of(leaves, { sortLeaves: false });

  return {
    root: tree.root as Hex,
    chunks: sorted.map((chunk, index) => ({
      ...chunk,
      leaf: leaves[index] as Hex,
      proof: tree.getProof(index) as Hex[],
    })),
  };
}

export function buildCardTree(cardIds: Hex[]): {
  root: Hex;
  cards: CardCommitment[];
} {
  if (cardIds.length === 0) throw new Error("A card tree cannot be empty");

  const sorted = cardIds.map((cardId) => Bytes32Schema.parse(cardId)).sort();
  ensureUnique(sorted, "cardId");
  const tree = SimpleMerkleTree.of(sorted, { sortLeaves: false });

  return {
    root: tree.root as Hex,
    cards: sorted.map((cardId, index) => ({
      cardId,
      leaf: cardId,
      proof: tree.getProof(index) as Hex[],
    })),
  };
}

export function verifyMerkleProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  return SimpleMerkleTree.verify(
    Bytes32Schema.parse(root),
    Bytes32Schema.parse(leaf),
    proof.map((item) => Bytes32Schema.parse(item)),
  );
}
