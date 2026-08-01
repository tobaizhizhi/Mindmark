import { z } from "zod";
import type { ChapterOutlineItem, SourceBlock } from "./project-v2.js";

export const CHAPTER_CARD_POLICY_VERSION = 3;
export const MIN_CHAPTER_CARD_COUNT = 2;
export const DEFAULT_CHAPTER_CARD_COUNT = 3;
export const MAX_CHAPTER_CARD_COUNT = 30;

export const ChapterCardPolicySchema = z.object({
  chapterId: z.number().int().min(0),
  minCardCount: z.number().int().min(MIN_CHAPTER_CARD_COUNT).max(MAX_CHAPTER_CARD_COUNT),
  targetCardCount: z.number().int().min(MIN_CHAPTER_CARD_COUNT).max(MAX_CHAPTER_CARD_COUNT),
  maxCardCount: z.number().int().min(MIN_CHAPTER_CARD_COUNT).max(MAX_CHAPTER_CARD_COUNT),
  policyVersion: z.literal(CHAPTER_CARD_POLICY_VERSION),
}).strict().superRefine((policy, context) => {
  if (policy.minCardCount > policy.targetCardCount) {
    context.addIssue({ code: "custom", message: "minCardCount cannot exceed targetCardCount" });
  }
  if (policy.targetCardCount > policy.maxCardCount) {
    context.addIssue({ code: "custom", message: "targetCardCount cannot exceed maxCardCount" });
  }
});

export type ChapterCardPolicy = z.infer<typeof ChapterCardPolicySchema>;

export function planChapterCardPolicy(
  chapter: ChapterOutlineItem,
  blocks: SourceBlock[],
): ChapterCardPolicy {
  const characters = blocks
    .filter((block) => block.kind !== "heading")
    .reduce((total, block) => total + block.text.length, 0);
  const targetCardCount = Math.min(
    20,
    Math.max(DEFAULT_CHAPTER_CARD_COUNT, Math.round(characters / 800) + chapter.importance),
  );
  const maxCardCount = Math.min(
    MAX_CHAPTER_CARD_COUNT,
    targetCardCount + Math.max(2, Math.ceil(targetCardCount * 0.25)),
  );
  return ChapterCardPolicySchema.parse({
    chapterId: chapter.chapterId,
    minCardCount: Math.min(DEFAULT_CHAPTER_CARD_COUNT, targetCardCount),
    targetCardCount,
    maxCardCount,
    policyVersion: CHAPTER_CARD_POLICY_VERSION,
  });
}
