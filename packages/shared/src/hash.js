import { canonicalize } from "json-canonicalize";
import { encodeAbiParameters, keccak256, stringToHex, } from "viem";
import { Bytes32Schema, KnowledgeCardContentSchema, MAX_SOURCE_PAGES, ReviewPlanSchema, SourceChunkContentSchema, SourcePageSchema, } from "./schemas.js";
export function canonicalJson(value) {
    return canonicalize(value);
}
export function hashCanonical(value) {
    return keccak256(stringToHex(canonicalJson(value)));
}
export function hashSourcePages(pages) {
    return hashCanonical(SourcePageSchema.array().min(1).max(MAX_SOURCE_PAGES).parse(pages));
}
export function hashSourceChunk(chunk) {
    return hashCanonical(SourceChunkContentSchema.parse(chunk));
}
export function hashKnowledgeCard(card) {
    return hashCanonical(KnowledgeCardContentSchema.parse(card));
}
export function deriveCardId(journeyId, chunkId, cardHash) {
    const parsedJourneyId = Bytes32Schema.parse(journeyId);
    const parsedCardHash = Bytes32Schema.parse(cardHash);
    if (!Number.isInteger(chunkId) || chunkId < 0 || chunkId > 65_535) {
        throw new RangeError("chunkId must fit uint16");
    }
    return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }], [parsedJourneyId, chunkId, parsedCardHash]));
}
export function hashInitialPlan(plan) {
    return hashCanonical(ReviewPlanSchema.parse(plan));
}
export function hashGoal(goal) {
    const normalized = goal.trim();
    return hashCanonical(normalized);
}
//# sourceMappingURL=hash.js.map