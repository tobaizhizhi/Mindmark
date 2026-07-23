import type { Hex } from "viem";
import { buildChunkManifest } from "./merkle.js";
import {
  PrepareJourneyRequestSchema,
  SourcePageSchema,
  SourceChunkContentSchema,
  type PrepareJourneyRequest,
  type SourcePage,
  type SourceChunkContent,
} from "./schemas.js";
import { hashGoal, hashSourceChunk, hashSourcePages } from "./hash.js";
import { normalizeSourceText } from "./citations.js";

type SourceUnit = {
  pageNumber: number;
  text: string;
};

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

function selectChunkCount(pageCount: number, totalCharacters: number): number {
  if (pageCount >= 9 || totalCharacters >= 12_000) return 4;
  if (pageCount >= 6 || totalCharacters >= 4_500) return 3;
  return 2;
}

function splitIntoUnits(request: PrepareJourneyRequest, desiredCount: number): SourceUnit[] {
  if (request.pages.length >= desiredCount) {
    return request.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: normalizeSourceText(page.text),
    }));
  }

  return request.pages.flatMap((page) => {
    const paragraphs = page.text
      .split(/\n{2,}/u)
      .map(normalizeSourceText)
      .filter(Boolean);
    const candidates =
      paragraphs.length >= desiredCount
        ? paragraphs
        : normalizeSourceText(page.text)
            .split(/(?<=[.!?。！？])\s+/u)
            .map(normalizeSourceText)
            .filter(Boolean);
    return candidates.map((text) => ({ pageNumber: page.pageNumber, text }));
  });
}

function partitionUnits(units: SourceUnit[], count: number): SourceUnit[][] {
  if (units.length < count) {
    throw new Error("Source material is too short to create two meaningful chunks");
  }

  const groups: SourceUnit[][] = [];
  let cursor = 0;
  let remainingCharacters = units.reduce((total, unit) => total + unit.text.length, 0);

  for (let groupIndex = 0; groupIndex < count; groupIndex += 1) {
    const remainingGroups = count - groupIndex;
    const targetCharacters = remainingCharacters / remainingGroups;
    const group: SourceUnit[] = [];
    let groupCharacters = 0;

    while (cursor < units.length) {
      const unitsAfterCandidate = units.length - (cursor + 1);
      const groupsAfterCurrent = remainingGroups - 1;
      const unit = units[cursor]!;
      group.push(unit);
      groupCharacters += unit.text.length;
      cursor += 1;

      if (
        groupCharacters >= targetCharacters &&
        unitsAfterCandidate >= groupsAfterCurrent
      ) {
        break;
      }
      if (unitsAfterCandidate === groupsAfterCurrent) break;
    }

    groups.push(group);
    remainingCharacters -= groupCharacters;
  }

  return groups;
}

function titleFor(text: string, chunkId: number): string {
  const firstSentence = text.split(/(?<=[.!?。！？])\s+/u)[0] ?? text;
  const normalized = normalizeSourceText(firstSentence).replace(/^\d+[.)]\s*/u, "");
  const shortened = normalized.length > 72 ? `${normalized.slice(0, 69).trim()}...` : normalized;
  return shortened || `Knowledge section ${chunkId + 1}`;
}

function allocateCardBudgets(characterCounts: number[]): number[] {
  const totalCharacters = characterCounts.reduce((total, count) => total + count, 0);
  const desiredTotal = Math.max(
    4,
    Math.min(30, Math.round(totalCharacters / 420)),
  );
  const effectiveTotal = Math.max(desiredTotal, characterCounts.length);
  const raw = characterCounts.map((count) => (count / totalCharacters) * effectiveTotal);
  const budgets = raw.map((value) => Math.max(1, Math.floor(value)));

  let allocated = budgets.reduce((total, budget) => total + budget, 0);
  const priority = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

  while (allocated < effectiveTotal) {
    const target = priority[allocated % priority.length]!;
    budgets[target.index] = budgets[target.index]! + 1;
    allocated += 1;
  }
  while (allocated > effectiveTotal) {
    const target = [...priority].reverse().find((item) => budgets[item.index]! > 1);
    if (!target) break;
    budgets[target.index] = budgets[target.index]! - 1;
    allocated -= 1;
  }

  return budgets;
}

export function prepareJourney(
  rawRequest: PrepareJourneyRequest,
  journeyId: Hex,
): PreparedJourney {
  const request = PrepareJourneyRequestSchema.parse(rawRequest);
  const pages = request.pages.map((page) => ({
    ...page,
    text: normalizeSourceText(page.text),
  }));
  const totalCharacters = pages.reduce((total, page) => total + page.text.length, 0);
  const desiredCount = selectChunkCount(pages.length, totalCharacters);
  const units = splitIntoUnits({ ...request, pages }, desiredCount);
  const chunkCount = Math.min(desiredCount, units.length);
  const groups = partitionUnits(units, chunkCount);
  const contents = groups.map((group, chunkId) => {
    const text = group.map((unit) => unit.text).join("\n\n");
    return SourceChunkContentSchema.parse({
      chunkId,
      pageStart: Math.min(...group.map((unit) => unit.pageNumber)),
      pageEnd: Math.max(...group.map((unit) => unit.pageNumber)),
      title: titleFor(text, chunkId),
      text,
    });
  });
  const sourcePagesByChunk = groups.map((group) => {
    const pageNumbers = [...new Set(group.map((unit) => unit.pageNumber))];
    return SourcePageSchema.array().parse(
      pageNumbers.map((pageNumber) => ({
        pageNumber,
        text: group
          .filter((unit) => unit.pageNumber === pageNumber)
          .map((unit) => unit.text)
          .join(" "),
      })),
    );
  });
  const budgets = allocateCardBudgets(contents.map((content) => content.text.length));
  const hashes = contents.map((content) => hashSourceChunk(content));
  const manifest = buildChunkManifest(
    journeyId,
    contents.map((content, index) => ({
      chunkId: content.chunkId,
      sourceChunkHash: hashes[index]!,
    })),
  );

  return {
    journeyId,
    sourceHash: hashSourcePages(pages),
    goalHash: hashGoal(request.goal ?? ""),
    chunkManifestRoot: manifest.root,
    chunkCount,
    chunks: contents.map((content, index) => ({
      content,
      sourcePages: sourcePagesByChunk[index]!,
      sourceChunkHash: hashes[index]!,
      manifestProof: manifest.chunks[index]!.proof,
      cardBudget: budgets[index]!,
    })),
  };
}
