import { type Hex } from "viem";
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
export declare function manifestLeaf(journeyId: Hex, chunkId: number, sourceChunkHash: Hex): Hex;
export declare function buildChunkManifest(journeyId: Hex, chunks: ManifestChunk[]): {
    root: Hex;
    chunks: ManifestCommitment[];
};
export declare function buildCardTree(cardIds: Hex[]): {
    root: Hex;
    cards: CardCommitment[];
};
export declare function verifyMerkleProof(root: Hex, leaf: Hex, proof: Hex[]): boolean;
//# sourceMappingURL=merkle.d.ts.map