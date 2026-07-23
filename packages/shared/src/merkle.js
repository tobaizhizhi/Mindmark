import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256 } from "viem";
import { Bytes32Schema } from "./schemas.js";
function assertUint16(value, field) {
    if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new RangeError(`${field} must fit uint16`);
    }
}
function ensureUnique(values, field) {
    if (new Set(values).size !== values.length) {
        throw new Error(`${field} values must be unique`);
    }
}
export function manifestLeaf(journeyId, chunkId, sourceChunkHash) {
    assertUint16(chunkId, "chunkId");
    return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }], [Bytes32Schema.parse(journeyId), chunkId, Bytes32Schema.parse(sourceChunkHash)]));
}
export function buildChunkManifest(journeyId, chunks) {
    if (chunks.length < 2 || chunks.length > 4) {
        throw new RangeError("A chunk manifest must contain 2 to 4 chunks");
    }
    const sorted = [...chunks].sort((left, right) => left.chunkId - right.chunkId);
    ensureUnique(sorted.map((chunk) => chunk.chunkId.toString()), "chunkId");
    const leaves = sorted.map((chunk) => manifestLeaf(journeyId, chunk.chunkId, chunk.sourceChunkHash));
    const tree = SimpleMerkleTree.of(leaves, { sortLeaves: false });
    return {
        root: tree.root,
        chunks: sorted.map((chunk, index) => ({
            ...chunk,
            leaf: leaves[index],
            proof: tree.getProof(index),
        })),
    };
}
export function buildCardTree(cardIds) {
    if (cardIds.length === 0)
        throw new Error("A card tree cannot be empty");
    const sorted = cardIds.map((cardId) => Bytes32Schema.parse(cardId)).sort();
    ensureUnique(sorted, "cardId");
    const tree = SimpleMerkleTree.of(sorted, { sortLeaves: false });
    return {
        root: tree.root,
        cards: sorted.map((cardId, index) => ({
            cardId,
            leaf: cardId,
            proof: tree.getProof(index),
        })),
    };
}
export function verifyMerkleProof(root, leaf, proof) {
    return SimpleMerkleTree.verify(Bytes32Schema.parse(root), Bytes32Schema.parse(leaf), proof.map((item) => Bytes32Schema.parse(item)));
}
//# sourceMappingURL=merkle.js.map