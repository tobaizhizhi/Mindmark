import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import { canonicalize } from "json-canonicalize";
import {
  SourceBlockContentSchema,
  SourceBlockSchema,
  type SourceBlock,
  type SourceBlockContent,
} from "./project-v2.js";
import {
  Bytes32Schema,
  KnowledgeCardContentSchema,
  ReviewPlanSchema,
  type KnowledgeCardContent,
  type ReviewPlan,
} from "./schemas.js";

export const V2_HASH_DOMAINS = {
  sourceBlock: "MINDMARK_SOURCE_BLOCK_V2",
  source: "MINDMARK_SOURCE_V2",
  chapterSource: "MINDMARK_CHAPTER_SOURCE_V2",
  workUnitSource: "MINDMARK_WORK_UNIT_SOURCE_V2",
  outline: "MINDMARK_OUTLINE_V2",
  workUnit: "MINDMARK_WORK_UNIT_V2",
  card: "MINDMARK_CARD_V2",
  chapter: "MINDMARK_CHAPTER_V2",
} as const;

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

export function hashKnowledgeCard(card: KnowledgeCardContent): Hex {
  return hashCanonical(KnowledgeCardContentSchema.parse(card));
}

export function hashInitialPlan(plan: ReviewPlan): Hex {
  return hashCanonical(ReviewPlanSchema.parse(plan));
}

export function hashGoal(goal: string): Hex {
  return hashCanonical(goal.trim());
}

function assertUint16(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError(`${field} must fit uint16`);
  }
}

function hashDomainValue(domain: string, value: unknown): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }],
      [domain, canonicalJson(value)],
    ),
  );
}

function hashBlockList(domain: string, blocks: SourceBlock[]): Hex {
  const parsed = SourceBlockSchema.array().min(1).parse(blocks);
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32[]" }],
      [domain, parsed.map((block) => block.blockHash)],
    ),
  );
}

export function hashSourceBlockV2(block: SourceBlockContent): Hex {
  return hashDomainValue(V2_HASH_DOMAINS.sourceBlock, SourceBlockContentSchema.parse(block));
}

export function hashSourceBlocksV2(blocks: SourceBlock[]): Hex {
  return hashBlockList(V2_HASH_DOMAINS.source, blocks);
}

export function hashChapterSourceV2(blocks: SourceBlock[]): Hex {
  return hashBlockList(V2_HASH_DOMAINS.chapterSource, blocks);
}

export function hashWorkUnitSourceV2(blocks: SourceBlock[]): Hex {
  return hashBlockList(V2_HASH_DOMAINS.workUnitSource, blocks);
}

export function hashTitleV2(title: string): Hex {
  const normalized = title.trim();
  if (!normalized) throw new Error("title cannot be empty");
  return keccak256(stringToHex(normalized));
}

export function outlineLeafV2(
  projectId: Hex,
  chapterId: number,
  titleHash: Hex,
  sourceHash: Hex,
): Hex {
  assertUint16(chapterId, "chapterId");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        V2_HASH_DOMAINS.outline,
        Bytes32Schema.parse(projectId),
        chapterId,
        Bytes32Schema.parse(titleHash),
        Bytes32Schema.parse(sourceHash),
      ],
    ),
  );
}

export function workUnitLeafV2(
  projectId: Hex,
  chapterId: number,
  workUnitId: number,
  sourceUnitHash: Hex,
): Hex {
  assertUint16(chapterId, "chapterId");
  assertUint16(workUnitId, "workUnitId");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "bytes32" },
      ],
      [
        V2_HASH_DOMAINS.workUnit,
        Bytes32Schema.parse(projectId),
        chapterId,
        workUnitId,
        Bytes32Schema.parse(sourceUnitHash),
      ],
    ),
  );
}

export function deriveCardIdV2(
  projectId: Hex,
  chapterId: number,
  workUnitId: number,
  cardHash: Hex,
): Hex {
  assertUint16(chapterId, "chapterId");
  assertUint16(workUnitId, "workUnitId");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "bytes32" },
      ],
      [
        V2_HASH_DOMAINS.card,
        Bytes32Schema.parse(projectId),
        chapterId,
        workUnitId,
        Bytes32Schema.parse(cardHash),
      ],
    ),
  );
}

export function chapterLeafV2(
  projectId: Hex,
  chapterId: number,
  chapterCardsRoot: Hex,
  cardCount: number,
): Hex {
  assertUint16(chapterId, "chapterId");
  assertUint16(cardCount, "cardCount");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "uint16" },
      ],
      [
        V2_HASH_DOMAINS.chapter,
        Bytes32Schema.parse(projectId),
        chapterId,
        Bytes32Schema.parse(chapterCardsRoot),
        cardCount,
      ],
    ),
  );
}
