import type { Hex } from "viem";
import { hashChapterSourceV2 } from "./hash-v2.js";
import { buildOutlineCommitmentV2 } from "./merkle-v2.js";
import {
  ChapterOutlineDraftSchema,
  MAX_PROJECT_CHAPTERS,
  SourceBlockSchema,
  type ChapterOutlineItem,
  type ChapterProposal,
  type SourceBlock,
  type SourceExclusionRange,
} from "./project-v2.js";
import {
  classifySourceExclusions,
  excludedSourceBlockIndexes,
  filterExcludedSourceBlocks,
  validateSourceExclusionRanges,
} from "./source-relevance.js";

type ChapterRange = { start: number; end: number; heading: string | null };

export type ChapterCountBudget = {
  minChapters: number;
  targetChapters: number;
  maxChapters: number;
  learningCharacters: number;
  learningPages: number;
};

const MAX_RECOMMENDED_PROJECT_CHAPTERS = 12;

function cleanHeading(value: string): string {
  return value.replace(/^#{1,6}\s+/u, "").trim();
}

function rangeCharacters(blocks: SourceBlock[], range: ChapterRange): number {
  return blocks
    .slice(range.start, range.end + 1)
    .reduce((total, block) => total + block.text.length, 0);
}

function mergeRangesToCount(
  blocks: SourceBlock[],
  rawRanges: ChapterRange[],
  maxCount: number,
): ChapterRange[] {
  const ranges = rawRanges.map((range) => ({ ...range }));
  while (ranges.length > maxCount) {
    let mergeIndex = 0;
    let smallest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < ranges.length - 1; index += 1) {
      const size = rangeCharacters(blocks, ranges[index]!) + rangeCharacters(blocks, ranges[index + 1]!);
      if (size < smallest) {
        smallest = size;
        mergeIndex = index;
      }
    }
    const left = ranges[mergeIndex]!;
    const right = ranges[mergeIndex + 1]!;
    ranges.splice(mergeIndex, 2, { start: left.start, end: right.end, heading: left.heading });
  }
  return ranges;
}

function headingRanges(
  blocks: SourceBlock[],
  excluded: ReadonlySet<number>,
  maxCount: number,
): ChapterRange[] {
  const learningBlocks = blocks.filter((block) => !excluded.has(block.blockIndex));
  const levels = learningBlocks.flatMap((block) =>
    block.kind === "heading" && block.headingLevel !== null ? [block.headingLevel] : [],
  );
  const chapterLevel = levels.length > 0 ? Math.min(...levels) : null;
  const headingIndexes = blocks
    .map((block, index) =>
      !excluded.has(block.blockIndex) && block.kind === "heading" && block.headingLevel === chapterLevel ? index : -1,
    )
    .filter((index) => index >= 0);
  if (headingIndexes.length === 0) return [];

  const firstLearningIndex = blocks.findIndex((block) => !excluded.has(block.blockIndex));
  let lastLearningIndex = blocks.length - 1;
  while (lastLearningIndex >= 0 && excluded.has(blocks[lastLearningIndex]!.blockIndex)) {
    lastLearningIndex -= 1;
  }
  const ranges = headingIndexes.map((headingIndex, index) => ({
    start: index === 0 ? Math.min(firstLearningIndex, headingIndex) : headingIndex,
    end: index < headingIndexes.length - 1 ? headingIndexes[index + 1]! - 1 : lastLearningIndex,
    heading: blocks[headingIndex]?.text ?? null,
  }));
  return mergeRangesToCount(blocks, ranges, maxCount);
}

function partitionRanges(
  blocks: SourceBlock[],
  excluded: ReadonlySet<number>,
  targetCount: number,
): ChapterRange[] {
  const learningBlocks = blocks.filter((block) => !excluded.has(block.blockIndex));
  const totalCharacters = learningBlocks.reduce((total, block) => total + block.text.length, 0);
  const count = Math.min(learningBlocks.length, targetCount);
  const ranges: ChapterRange[] = [];
  let cursor = 0;
  let remainingCharacters = totalCharacters;

  for (let chapterIndex = 0; chapterIndex < count; chapterIndex += 1) {
    const remainingChapters = count - chapterIndex;
    const targetCharacters = remainingCharacters / remainingChapters;
    const start = cursor;
    let currentCharacters = 0;
    while (cursor < learningBlocks.length) {
      currentCharacters += learningBlocks[cursor]!.text.length;
      cursor += 1;
      const blocksLeft = learningBlocks.length - cursor;
      if (currentCharacters >= targetCharacters && blocksLeft >= remainingChapters - 1) break;
      if (blocksLeft === remainingChapters - 1) break;
    }
    ranges.push({
      start: learningBlocks[start]!.blockIndex,
      end: learningBlocks[cursor - 1]!.blockIndex,
      heading: null,
    });
    remainingCharacters -= currentCharacters;
  }
  return ranges;
}

export function planChapterCountBudget(
  rawBlocks: SourceBlock[],
  rawExcludedRanges: SourceExclusionRange[] = [],
): ChapterCountBudget {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const excludedRanges = validateSourceExclusionRanges(rawExcludedRanges, blocks.length);
  const learningBlocks = filterExcludedSourceBlocks(blocks, excludedRanges);
  if (learningBlocks.length === 0) throw new Error("Source material did not contain learning content");

  const bodyBlocks = learningBlocks.filter((block) => block.kind !== "heading");
  const learningCharacters = bodyBlocks.reduce((total, block) => total + block.text.length, 0);
  const pageBlocks = bodyBlocks.length > 0 ? bodyBlocks : learningBlocks;
  const learningPages = new Set(pageBlocks.map((block) => block.pageNumber)).size;
  const characterTarget = learningCharacters <= 4_000
    ? 1
    : learningCharacters <= 12_000
      ? 2
      : Math.ceil(learningCharacters / 6_000);
  const pageTarget = Math.ceil(learningPages / 8);
  const targetChapters = Math.min(
    MAX_RECOMMENDED_PROJECT_CHAPTERS,
    Math.max(1, characterTarget, pageTarget),
  );

  return {
    minChapters: Math.max(1, targetChapters - 1),
    targetChapters,
    maxChapters: Math.min(MAX_RECOMMENDED_PROJECT_CHAPTERS, targetChapters + 1),
    learningCharacters,
    learningPages,
  };
}

function sourceSnippet(blocks: SourceBlock[]): string {
  const source = blocks.find((block) => block.kind !== "heading") ?? blocks[0]!;
  const sentence = source.text.split(/(?<=[.!?。！？])\s*/u)[0] ?? source.text;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trim()}...` : sentence;
}

function summaryFor(blocks: SourceBlock[]): string {
  const pageStart = blocks[0]!.pageNumber;
  const pageEnd = blocks.at(-1)!.pageNumber;
  const chinese = blocks.some((block) => /[\u3400-\u9fff]/u.test(block.text));
  const pageRange = pageStart === pageEnd ? `${pageStart}` : `${pageStart}-${pageEnd}`;
  return chinese
    ? `本章覆盖第 ${pageRange} 页，重点梳理核心概念、关键关系与应用要点。`
    : `This chapter covers pages ${pageRange} and focuses on core concepts, relationships, and applications.`;
}

function titleFor(blocks: SourceBlock[], range: ChapterRange, index: number): string {
  if (range.heading) return cleanHeading(range.heading).slice(0, 200);
  const snippet = sourceSnippet(blocks.slice(range.start, range.end + 1));
  const compact = snippet.length > 64 ? `${snippet.slice(0, 61).trim()}...` : snippet;
  return /[\u3400-\u9fff]/u.test(compact)
    ? `第 ${index + 1} 章 · ${compact}`
    : `Chapter ${index + 1}: ${compact}`;
}

export function validateChapterOutline(
  rawChapters: ChapterOutlineItem[],
  rawBlocks: SourceBlock[],
  rawExcludedRanges: SourceExclusionRange[] = [],
): ChapterOutlineItem[] {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const excludedRanges = validateSourceExclusionRanges(rawExcludedRanges, blocks.length);
  const excluded = excludedSourceBlockIndexes(excludedRanges);
  const chapters = rawChapters.map((chapter) => ({ ...chapter }));
  if (chapters.length < 1 || chapters.length > MAX_PROJECT_CHAPTERS) {
    throw new RangeError(`An outline must contain 1 to ${MAX_PROJECT_CHAPTERS} chapters`);
  }
  for (const [index, chapter] of chapters.entries()) {
    if (chapter.chapterId !== index || chapter.position !== index) {
      throw new Error("chapterId and position must be contiguous and ordered from zero");
    }
    if (index > 0 && chapter.startBlock <= chapters[index - 1]!.endBlock) {
      throw new Error("Chapter ranges must be ordered and must not overlap");
    }
    if (chapter.endBlock < chapter.startBlock || chapter.endBlock >= blocks.length) {
      throw new Error("Chapter range is outside the Source Block collection");
    }
    const source = blocks.slice(chapter.startBlock, chapter.endBlock + 1);
    if (chapter.pageStart !== source[0]!.pageNumber || chapter.pageEnd !== source.at(-1)!.pageNumber) {
      throw new Error("Chapter pages must match its Source Block range");
    }
    if (chapter.sourceHash !== hashChapterSourceV2(source)) {
      throw new Error("Chapter sourceHash does not match its Source Block range");
    }
    if (source.every((block) => excluded.has(block.blockIndex))) {
      throw new Error("A Chapter must contain at least one learning Source Block");
    }
  }
  const coverage = blocks.map(() => 0);
  for (const chapter of chapters) {
    for (let index = chapter.startBlock; index <= chapter.endBlock; index += 1) {
      coverage[index] = (coverage[index] ?? 0) + 1;
    }
  }
  if (coverage.some((count, index) => !excluded.has(index) && count !== 1)) {
    throw new Error("Every learning Source Block must belong to exactly one Chapter");
  }
  return chapters;
}

export function planChaptersDeterministically(
  projectId: Hex,
  rawBlocks: SourceBlock[],
  outlineVersion = 1,
): import("./project-v2.js").ChapterOutlineDraft {
  if (!Number.isInteger(outlineVersion) || outlineVersion < 1) {
    throw new RangeError("outlineVersion must be a positive integer");
  }
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const excludedRanges = classifySourceExclusions(blocks);
  const excluded = excludedSourceBlockIndexes(excludedRanges);
  if (excluded.size === blocks.length) throw new Error("Source material did not contain learning content");
  const budget = planChapterCountBudget(blocks, excludedRanges);
  const ranges = headingRanges(blocks, excluded, budget.maxChapters);
  const selectedRanges = ranges.length > 0
    ? ranges
    : partitionRanges(blocks, excluded, budget.targetChapters);
  const proposals = selectedRanges.map((range, index) => {
    const source = filterExcludedSourceBlocks(blocks.slice(range.start, range.end + 1), excludedRanges);
    return {
      title: titleFor(blocks, range, index),
      summary: summaryFor(source),
      startBlock: range.start,
      endBlock: range.end,
      importance: 3,
    } satisfies ChapterProposal;
  });
  return materializeChapterOutline(projectId, blocks, proposals, outlineVersion, excludedRanges);
}

export function materializeChapterOutline(
  projectId: Hex,
  rawBlocks: SourceBlock[],
  proposals: ChapterProposal[],
  outlineVersion = 1,
  rawExcludedRanges: SourceExclusionRange[] = [],
): import("./project-v2.js").ChapterOutlineDraft {
  if (!Number.isInteger(outlineVersion) || outlineVersion < 1) {
    throw new RangeError("outlineVersion must be a positive integer");
  }
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const excludedRanges = validateSourceExclusionRanges(rawExcludedRanges, blocks.length);
  const chapters = proposals.map((proposal, index) => {
    const source = blocks.slice(proposal.startBlock, proposal.endBlock + 1);
    if (source.length === 0) throw new Error("Chapter range must contain Source Blocks");
    return {
      chapterId: index,
      position: index,
      title: proposal.title,
      summary: proposal.summary,
      startBlock: proposal.startBlock,
      endBlock: proposal.endBlock,
      pageStart: source[0]!.pageNumber,
      pageEnd: source.at(-1)!.pageNumber,
      sourceHash: hashChapterSourceV2(source),
      importance: proposal.importance,
    } satisfies ChapterOutlineItem;
  });
  const validated = validateChapterOutline(chapters, blocks, excludedRanges);
  const commitment = buildOutlineCommitmentV2(projectId, validated);
  return ChapterOutlineDraftSchema.parse({
    projectId,
    outlineVersion,
    outlineHash: commitment.root,
    chapters: validated,
    excludedRanges,
  });
}
