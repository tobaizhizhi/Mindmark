import type { Hex } from "viem";
import { hashChapterSourceV2 } from "./hash-v2.js";
import { buildOutlineCommitmentV2 } from "./merkle-v2.js";
import {
  chapterTitleQualityIssues,
  isUsableChapterTitle,
  normalizeChapterTitle,
} from "./chapter-title.js";
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
  classifyStandaloneSourceText,
  classifySourceExclusions,
  excludedSourceBlockIndexes,
  filterExcludedSourceBlocks,
  validateSourceExclusionRanges,
} from "./source-relevance.js";

type HeadingMarker = "explicit" | "numeric-top" | "numeric-sub" | "generic";

type InferredHeading = {
  index: number;
  blockIndex: number;
  title: string;
  inferredLevel: number;
  marker: HeadingMarker;
  ordinal: number | null;
};

type ChapterRange = {
  start: number;
  end: number;
  headingIndexes: number[];
  headings: string[];
};

export type ChapterStructureAnalysis = {
  headings: Array<{
    blockIndex: number;
    title: string;
    inferredLevel: number;
    marker: HeadingMarker;
    ordinal: number | null;
  }>;
  naturalGroups: Array<{
    startBlock: number;
    endBlock: number;
    headingTitles: string[];
    suggestedTitle: string;
  }>;
};

export type ChapterCountBudget = {
  minChapters: number;
  targetChapters: number;
  maxChapters: number;
  learningCharacters: number;
  learningPages: number;
};

const MAX_RECOMMENDED_PROJECT_CHAPTERS = 12;

function rangeCharacters(blocks: SourceBlock[], range: ChapterRange): number {
  return blocks
    .slice(range.start, range.end + 1)
    .reduce((total, block) => total + block.text.length, 0);
}

function trimRange(
  blocks: SourceBlock[],
  excluded: ReadonlySet<number>,
  start: number,
  end: number,
): { start: number; end: number } | null {
  while (start <= end && excluded.has(blocks[start]!.blockIndex)) start += 1;
  while (end >= start && excluded.has(blocks[end]!.blockIndex)) end -= 1;
  return start <= end ? { start, end } : null;
}

function inferHeadingMarker(block: SourceBlock): {
  level: number;
  marker: HeadingMarker;
  ordinal: number | null;
} | null {
  if (block.kind !== "heading" || block.headingLevel === null || !isUsableChapterTitle(block.text)) {
    return null;
  }
  const text = block.text.normalize("NFKC").trim();
  const markdown = /^(#{1,6})\s+/u.exec(text);
  if (markdown) return { level: markdown[1]!.length, marker: "explicit", ordinal: null };
  if (/^第\s*[0-9一二三四五六七八九十百千万两]+\s*(?:章|篇|部|单元)\b/u.test(text)) {
    return { level: 1, marker: "explicit", ordinal: null };
  }
  if (/^第\s*[0-9一二三四五六七八九十百千万两]+\s*节\b/u.test(text)) {
    return { level: 2, marker: "explicit", ordinal: null };
  }
  if (/^(?:chapter|unit|part)\s+[0-9ivxlcdm]+\b/iu.test(text)) {
    return { level: 1, marker: "explicit", ordinal: null };
  }
  if (/^section\s+[0-9ivxlcdm]+\b/iu.test(text)) {
    return { level: 2, marker: "explicit", ordinal: null };
  }
  const decimal = /^\s*(\d+)\.(\d+(?:\.\d+)*)\s+/u.exec(text);
  if (decimal) return { level: 2, marker: "numeric-sub", ordinal: Number(decimal[1]) };
  const parenthesized = /^\s*(\d+)\s*[)）、]\s*/u.exec(text);
  if (parenthesized) return { level: 2, marker: "numeric-sub", ordinal: Number(parenthesized[1]) };
  const dotted = /^\s*(\d+)\.\s+/u.exec(text);
  if (dotted) return { level: 1, marker: "numeric-top", ordinal: Number(dotted[1]) };
  const bare = /^\s*(\d+)\s+(?=[\p{L}\p{Script=Han}])/u.exec(text);
  if (bare) return { level: 1, marker: "numeric-top", ordinal: Number(bare[1]) };
  return { level: block.headingLevel, marker: "generic", ordinal: null };
}

function inferHeadings(blocks: SourceBlock[], excluded: ReadonlySet<number>): InferredHeading[] {
  const candidates = blocks.flatMap((block, index) => {
    if (excluded.has(block.blockIndex)) return [];
    const inferred = inferHeadingMarker(block);
    if (!inferred) return [];
    return [{
      index,
      blockIndex: block.blockIndex,
      title: normalizeChapterTitle(block.text),
      inferredLevel: inferred.level,
      marker: inferred.marker,
      ordinal: inferred.ordinal,
    }];
  });
  const hasExplicitTopLevel = candidates.some((heading) =>
    heading.marker === "explicit" && heading.inferredLevel === 1,
  );
  return candidates.map((heading) => {
    if (
      heading.marker === "numeric-top"
      && (hasExplicitTopLevel || /^(?:假定|假设|若|如果|采用|例如|例|示例|案例|情况|步骤|分析|说明|结果)/u.test(heading.title)
        || /任务\s*[A-ZＡ-Ｚ]/u.test(heading.title) && /(?:优先级|截止|运行)/u.test(heading.title))
    ) {
      return { ...heading, inferredLevel: 2, marker: "numeric-sub" as const };
    }
    return heading;
  });
}

function naturalHeadingRanges(
  blocks: SourceBlock[],
  excluded: ReadonlySet<number>,
): { ranges: ChapterRange[]; headings: InferredHeading[] } {
  const headings = inferHeadings(blocks, excluded);
  if (headings.length === 0) return { ranges: [], headings };
  const chapterLevel = Math.min(...headings.map((heading) => heading.inferredLevel));
  const boundaries = headings.filter((heading) => heading.inferredLevel === chapterLevel);
  if (boundaries.length === 0) return { ranges: [], headings };
  const firstLearningIndex = blocks.findIndex((block) => !excluded.has(block.blockIndex));
  let lastLearningIndex = blocks.length - 1;
  while (lastLearningIndex >= 0 && excluded.has(blocks[lastLearningIndex]!.blockIndex)) lastLearningIndex -= 1;

  const groups: InferredHeading[][] = [];
  let current: InferredHeading[] | null = null;
  for (const heading of boundaries) {
    const continuesNumericSequence = current
      && (
        (heading.marker === "numeric-top"
          && current[0]?.marker === "numeric-top"
          && heading.ordinal !== 1)
        || (heading.marker === "generic" && current.some((item) => item.marker === "numeric-top"))
      );
    if (!current || !continuesNumericSequence) {
      current = [heading];
      groups.push(current);
    } else {
      current.push(heading);
    }
  }

  const firstBoundaryIndex = boundaries[0]!.index;
  const preambleHeadings = headings.filter((heading) =>
    heading.index >= firstLearningIndex && heading.index < firstBoundaryIndex,
  );
  const rangeGroups: InferredHeading[][] = preambleHeadings.length > 0
    ? [preambleHeadings, ...groups]
    : groups;
  const ranges = rangeGroups.flatMap((group, groupIndex) => {
    const start = groupIndex === 0 && preambleHeadings.length === 0
      ? firstLearningIndex
      : group[0]!.index;
    const nextGroup = rangeGroups[groupIndex + 1];
    const end = nextGroup ? nextGroup[0]!.index - 1 : lastLearningIndex;
    const trimmed = trimRange(blocks, excluded, start, end);
    if (!trimmed) return [];
    return [{
      ...trimmed,
      headingIndexes: group.map((heading) => heading.index),
      headings: group.map((heading) => heading.title),
    }];
  });
  return { ranges, headings };
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
    ranges.splice(mergeIndex, 2, {
      start: left.start,
      end: right.end,
      headingIndexes: [...left.headingIndexes, ...right.headingIndexes],
      headings: [...left.headings, ...right.headings],
    });
  }
  return ranges;
}

function splitLargestRange(
  blocks: SourceBlock[],
  excluded: ReadonlySet<number>,
  ranges: ChapterRange[],
): boolean {
  let selectedIndex = -1;
  let selectedSize = -1;
  for (const [index, range] of ranges.entries()) {
    if (range.headingIndexes.length < 2) continue;
    const size = rangeCharacters(blocks, range);
    if (size > selectedSize) {
      selectedIndex = index;
      selectedSize = size;
    }
  }
  if (selectedIndex < 0) return false;
  const range = ranges[selectedIndex]!;
  let splitAt = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  const total = rangeCharacters(blocks, range);
  for (let offset = 1; offset < range.headingIndexes.length; offset += 1) {
    const candidate = range.headingIndexes[offset]!;
    const left = trimRange(blocks, excluded, range.start, candidate - 1);
    const right = trimRange(blocks, excluded, candidate, range.end);
    if (!left || !right) continue;
    const distance = Math.abs(rangeCharacters(blocks, { ...range, ...left }) - total / 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      splitAt = offset;
    }
  }
  const candidate = range.headingIndexes[splitAt]!;
  const left = trimRange(blocks, excluded, range.start, candidate - 1);
  const right = trimRange(blocks, excluded, candidate, range.end);
  if (!left || !right) return false;
  ranges.splice(selectedIndex, 1,
    { ...left, headingIndexes: range.headingIndexes.slice(0, splitAt), headings: range.headings.slice(0, splitAt) },
    { ...right, headingIndexes: range.headingIndexes.slice(splitAt), headings: range.headings.slice(splitAt) },
  );
  return true;
}

function headingRanges(
  blocks: SourceBlock[],
  excluded: ReadonlySet<number>,
  targetCount: number,
  maxCount: number,
): ChapterRange[] {
  const natural = naturalHeadingRanges(blocks, excluded).ranges;
  if (natural.length === 0) return [];
  const ranges = natural.map((range) => ({ ...range, headingIndexes: [...range.headingIndexes], headings: [...range.headings] }));
  while (ranges.length < targetCount && splitLargestRange(blocks, excluded, ranges)) {
    // Split only at headings that were already identified as real topic boundaries.
  }
  return mergeRangesToCount(blocks, ranges, maxCount);
}

function compositeChapterTitle(headings: string[]): string {
  const titles = headings
    .map((heading) => normalizeChapterTitle(heading)
      .replace(/[（(][^（）()]{1,24}[）)]/gu, "")
      .replace(/(?:的概念|的定义|的介绍)$/u, "")
      .trim())
    .filter(Boolean);
  if (titles.length === 0) return "";
  if (titles.length === 1) return titles[0]!;
  const first = titles[0]!;
  const last = titles.at(-1)!;
  const combine = (left: string, right: string) =>
    `${left}${/^[A-Za-z]/u.test(right) ? "与 " : "与"}${right}`;
  if (first.startsWith(last)) return first;
  if (last.startsWith(first)) return combine(first, last.slice(first.length).replace(/^的/u, ""));
  let suffix = "";
  while (suffix.length < Math.min(first.length, last.length)
    && first.at(-(suffix.length + 1)) === last.at(-(suffix.length + 1))) {
    suffix = first.at(-(suffix.length + 1))! + suffix;
  }
  if (suffix.length >= 2) {
    const left = first.slice(0, -suffix.length).replace(/的$/u, "").replace(/^基于/u, "");
    const right = last.slice(0, -suffix.length).replace(/^的/u, "");
    if (left && right) return combine(left, `${right}${suffix}`);
  }
  const combined = combine(first, last);
  if (combined.length <= 64) return combined;
  return combine(first.slice(0, 30), last.slice(-30));
}

export function analyzeChapterStructure(
  rawBlocks: SourceBlock[],
  rawExcludedRanges: SourceExclusionRange[] = [],
): ChapterStructureAnalysis {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const excludedRanges = rawExcludedRanges.length > 0
    ? validateSourceExclusionRanges(rawExcludedRanges, blocks.length)
    : classifySourceExclusions(blocks);
  const excluded = excludedSourceBlockIndexes(excludedRanges);
  const natural = naturalHeadingRanges(blocks, excluded);
  return {
    headings: natural.headings.map((heading) => ({
      blockIndex: heading.blockIndex,
      title: heading.title,
      inferredLevel: heading.inferredLevel,
      marker: heading.marker,
      ordinal: heading.ordinal,
    })),
    naturalGroups: natural.ranges.map((range) => ({
      startBlock: blocks[range.start]!.blockIndex,
      endBlock: blocks[range.end]!.blockIndex,
      headingTitles: range.headings,
      suggestedTitle: compositeChapterTitle(range.headings),
    })),
  };
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
      headingIndexes: [],
      headings: [],
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
  if (range.headings.length > 0) {
    const composite = compositeChapterTitle(range.headings);
    if (composite && isUsableChapterTitle(composite)) return composite;
  }
  const source = blocks.slice(range.start, range.end + 1);
  const heading = source.find((block) => block.kind === "heading" && isUsableChapterTitle(block.text));
  if (heading) return normalizeChapterTitle(heading.text);
  return source.some((block) => /[\u3400-\u9fff]/u.test(block.text))
    ? `核心知识 ${index + 1}`
    : `Core Concepts ${index + 1}`;
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
  const chapterTitles = new Set<string>();
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
    if (excluded.has(chapter.startBlock) || excluded.has(chapter.endBlock)) {
      throw new Error("A Chapter must start and end on learning Source Block boundaries");
    }
    if (classifyStandaloneSourceText(chapter.title)) {
      throw new Error("A Chapter title must describe learning knowledge, not an excluded source notice");
    }
    const titleIssues = chapterTitleQualityIssues(chapter.title);
    if (titleIssues.length > 0) {
      throw new Error(`Chapter title is invalid: ${titleIssues.join("; ")}`);
    }
    const normalizedTitle = normalizeChapterTitle(chapter.title).toLocaleLowerCase();
    if (chapterTitles.has(normalizedTitle)) throw new Error("Chapter titles must be unique");
    chapterTitles.add(normalizedTitle);
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
  const ranges = headingRanges(blocks, excluded, budget.targetChapters, budget.maxChapters);
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
      title: normalizeChapterTitle(proposal.title),
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
