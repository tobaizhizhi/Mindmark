import type { Hex } from "viem";
import { hashChapterSourceV2 } from "./hash-v2.js";
import { buildOutlineCommitmentV2 } from "./merkle-v2.js";
import {
  ChapterOutlineSchema,
  MAX_PROJECT_CHAPTERS,
  SourceBlockSchema,
  type ChapterOutline,
  type ChapterOutlineItem,
  type ChapterProposal,
  type SourceBlock,
} from "./project-v2.js";

type ChapterRange = { start: number; end: number; heading: string | null };

function cleanHeading(value: string): string {
  return value.replace(/^#{1,6}\s+/u, "").trim();
}

function rangeCharacters(blocks: SourceBlock[], range: ChapterRange): number {
  return blocks
    .slice(range.start, range.end + 1)
    .reduce((total, block) => total + block.text.length, 0);
}

function headingRanges(blocks: SourceBlock[]): ChapterRange[] {
  const levels = blocks.flatMap((block) =>
    block.kind === "heading" && block.headingLevel !== null ? [block.headingLevel] : [],
  );
  const chapterLevel = levels.length > 0 ? Math.min(...levels) : null;
  const headingIndexes = blocks
    .map((block, index) =>
      block.kind === "heading" && block.headingLevel === chapterLevel ? index : -1,
    )
    .filter((index) => index >= 0);
  if (headingIndexes.length === 0) return [];

  const ranges = headingIndexes.map((headingIndex, index) => ({
    start: index === 0 ? 0 : headingIndex,
    end: (headingIndexes[index + 1] ?? blocks.length) - 1,
    heading: blocks[headingIndex]?.text ?? null,
  }));
  while (ranges.length > MAX_PROJECT_CHAPTERS) {
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

function partitionRanges(blocks: SourceBlock[]): ChapterRange[] {
  const totalCharacters = blocks.reduce((total, block) => total + block.text.length, 0);
  const count = Math.min(MAX_PROJECT_CHAPTERS, Math.max(1, Math.ceil(totalCharacters / 12_000)));
  const ranges: ChapterRange[] = [];
  let cursor = 0;
  let remainingCharacters = totalCharacters;

  for (let chapterIndex = 0; chapterIndex < count; chapterIndex += 1) {
    const remainingChapters = count - chapterIndex;
    const targetCharacters = remainingCharacters / remainingChapters;
    const start = cursor;
    let currentCharacters = 0;
    while (cursor < blocks.length) {
      currentCharacters += blocks[cursor]!.text.length;
      cursor += 1;
      const blocksLeft = blocks.length - cursor;
      if (currentCharacters >= targetCharacters && blocksLeft >= remainingChapters - 1) break;
      if (blocksLeft === remainingChapters - 1) break;
    }
    ranges.push({ start, end: cursor - 1, heading: null });
    remainingCharacters -= currentCharacters;
  }
  return ranges;
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
): ChapterOutlineItem[] {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const chapters = rawChapters.map((chapter) => ({ ...chapter }));
  if (chapters.length < 1 || chapters.length > MAX_PROJECT_CHAPTERS) {
    throw new RangeError(`An outline must contain 1 to ${MAX_PROJECT_CHAPTERS} chapters`);
  }
  for (const [index, chapter] of chapters.entries()) {
    if (chapter.chapterId !== index || chapter.position !== index) {
      throw new Error("chapterId and position must be contiguous and ordered from zero");
    }
    const expectedStart = index === 0 ? 0 : chapters[index - 1]!.endBlock + 1;
    if (chapter.startBlock !== expectedStart) {
      throw new Error("Chapter ranges must cover every Source Block without gaps or overlap");
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
  }
  if (chapters.at(-1)!.endBlock !== blocks.length - 1) {
    throw new Error("Chapter ranges must cover the final Source Block");
  }
  return chapters;
}

export function planChaptersDeterministically(
  projectId: Hex,
  rawBlocks: SourceBlock[],
  outlineVersion = 1,
): ChapterOutline {
  if (!Number.isInteger(outlineVersion) || outlineVersion < 1) {
    throw new RangeError("outlineVersion must be a positive integer");
  }
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const ranges = headingRanges(blocks);
  const selectedRanges = ranges.length > 0 ? ranges : partitionRanges(blocks);
  const proposals = selectedRanges.map((range, index) => {
    const source = blocks.slice(range.start, range.end + 1);
    return {
      title: titleFor(blocks, range, index),
      summary: summaryFor(source),
      startBlock: range.start,
      endBlock: range.end,
      importance: 3,
    } satisfies ChapterProposal;
  });
  return materializeChapterOutline(projectId, blocks, proposals, outlineVersion);
}

export function materializeChapterOutline(
  projectId: Hex,
  rawBlocks: SourceBlock[],
  proposals: ChapterProposal[],
  outlineVersion = 1,
): ChapterOutline {
  if (!Number.isInteger(outlineVersion) || outlineVersion < 1) {
    throw new RangeError("outlineVersion must be a positive integer");
  }
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
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
  const validated = validateChapterOutline(chapters, blocks);
  const commitment = buildOutlineCommitmentV2(projectId, validated);
  return ChapterOutlineSchema.parse({
    projectId,
    outlineVersion,
    outlineHash: commitment.root,
    chapters: validated,
  });
}
