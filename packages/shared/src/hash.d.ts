import { type Hex } from "viem";
import { type KnowledgeCardContent, type ReviewPlan, type SourceChunkContent, type SourcePage } from "./schemas.js";
export declare function canonicalJson(value: unknown): string;
export declare function hashCanonical(value: unknown): Hex;
export declare function hashSourcePages(pages: SourcePage[]): Hex;
export declare function hashSourceChunk(chunk: SourceChunkContent): Hex;
export declare function hashKnowledgeCard(card: KnowledgeCardContent): Hex;
export declare function deriveCardId(journeyId: Hex, chunkId: number, cardHash: Hex): Hex;
export declare function hashInitialPlan(plan: ReviewPlan): Hex;
export declare function hashGoal(goal: string): Hex;
//# sourceMappingURL=hash.d.ts.map