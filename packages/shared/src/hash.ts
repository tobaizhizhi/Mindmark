import { canonicalize } from "json-canonicalize";
import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import {
  Bytes32Schema,
  KnowledgeCardContentSchema,
  ReviewPlanSchema,
  SourceChunkContentSchema,
  SourcePageSchema,
  type KnowledgeCardContent,
  type ReviewPlan,
  type SourceChunkContent,
  type SourcePage,
} from "./schemas.js";

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

export function hashSourcePages(pages: SourcePage[]): Hex {
  return hashCanonical(SourcePageSchema.array().min(1).max(10).parse(pages));
}

export function hashSourceChunk(chunk: SourceChunkContent): Hex {
  return hashCanonical(SourceChunkContentSchema.parse(chunk));
}

export function hashKnowledgeCard(card: KnowledgeCardContent): Hex {
  return hashCanonical(KnowledgeCardContentSchema.parse(card));
}

export function deriveCardId(
  journeyId: Hex,
  chunkId: number,
  cardHash: Hex,
): Hex {
  const parsedJourneyId = Bytes32Schema.parse(journeyId);
  const parsedCardHash = Bytes32Schema.parse(cardHash);
  if (!Number.isInteger(chunkId) || chunkId < 0 || chunkId > 65_535) {
    throw new RangeError("chunkId must fit uint16");
  }

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }],
      [parsedJourneyId, chunkId, parsedCardHash],
    ),
  );
}

export function hashInitialPlan(plan: ReviewPlan): Hex {
  return hashCanonical(ReviewPlanSchema.parse(plan));
}

export function hashGoal(goal: string): Hex {
  const normalized = goal.trim();
  return hashCanonical(normalized);
}
