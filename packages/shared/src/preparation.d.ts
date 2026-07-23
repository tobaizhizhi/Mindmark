import type { Hex } from "viem";
import { type PrepareJourneyRequest, type SourcePage, type SourceChunkContent } from "./schemas.js";
export type PreparedChunk = {
    content: SourceChunkContent;
    sourcePages: SourcePage[];
    sourceChunkHash: Hex;
    manifestProof: Hex[];
    cardBudget: number;
};
export type PreparedJourney = {
    journeyId: Hex;
    sourceHash: Hex;
    goalHash: Hex;
    chunkManifestRoot: Hex;
    chunkCount: number;
    chunks: PreparedChunk[];
};
export declare function prepareJourney(rawRequest: PrepareJourneyRequest, journeyId: Hex): PreparedJourney;
