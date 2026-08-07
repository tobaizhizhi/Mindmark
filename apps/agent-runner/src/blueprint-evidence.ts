import {
  normalizeSourceText,
  type CardBlueprintSlot,
  type SourceBlock,
} from "@mindmark/shared";

const MIN_CITATION_LENGTH = 20;
const TARGET_EVIDENCE_LENGTH = 240;
const MAX_NEARBY_BLOCKS = 4;

function normalizedLength(block: SourceBlock): number {
  return normalizeSourceText(block.text).length;
}

function isSubstantive(block: SourceBlock): boolean {
  return block.kind !== "heading" && normalizedLength(block) >= MIN_CITATION_LENGTH;
}

/**
 * Old deterministic Blueprints sometimes cited only a short section heading.
 * Extend such evidence through the section body while keeping it inside the
 * already assigned Chapter/Work Unit source.
 */
export function expandBlueprintEvidenceBlockIndexes(
  rawIndexes: readonly number[],
  sourceBlocks: readonly SourceBlock[],
): number[] {
  const blocks = [...sourceBlocks].sort((left, right) => left.blockIndex - right.blockIndex);
  const positions = new Map(blocks.map((block, index) => [block.blockIndex, index]));
  const explicit = rawIndexes
    .map((blockIndex) => blocks[positions.get(blockIndex) ?? -1])
    .filter((block): block is SourceBlock => Boolean(block));
  if (explicit.length === 0) return [...rawIndexes];
  if (explicit.some(isSubstantive)) return [...new Set(rawIndexes)].sort((left, right) => left - right);

  const selected = new Set(explicit.map((block) => block.blockIndex));
  let evidenceLength = explicit.reduce((total, block) => total + normalizedLength(block), 0);
  let addedBlocks = 0;

  for (const anchor of explicit) {
    const anchorPosition = positions.get(anchor.blockIndex);
    if (anchorPosition === undefined) continue;
    const anchorLevel = anchor.headingLevel ?? 6;
    for (let index = anchorPosition + 1; index < blocks.length; index += 1) {
      const candidate = blocks[index]!;
      if (
        candidate.kind === "heading"
        && (candidate.headingLevel ?? 6) <= anchorLevel
      ) break;
      if (!isSubstantive(candidate) || selected.has(candidate.blockIndex)) continue;
      selected.add(candidate.blockIndex);
      evidenceLength += normalizedLength(candidate);
      addedBlocks += 1;
      if (evidenceLength >= TARGET_EVIDENCE_LENGTH || addedBlocks >= MAX_NEARBY_BLOCKS) break;
    }
    if (evidenceLength >= TARGET_EVIDENCE_LENGTH || addedBlocks >= MAX_NEARBY_BLOCKS) break;
  }

  if (addedBlocks === 0) {
    const anchorPositions = explicit
      .map((block) => positions.get(block.blockIndex))
      .filter((position): position is number => position !== undefined);
    const nearby = blocks
      .filter(isSubstantive)
      .sort((left, right) => {
        const leftPosition = positions.get(left.blockIndex)!;
        const rightPosition = positions.get(right.blockIndex)!;
        const leftDistance = Math.min(...anchorPositions.map((position) => Math.abs(position - leftPosition)));
        const rightDistance = Math.min(...anchorPositions.map((position) => Math.abs(position - rightPosition)));
        return leftDistance - rightDistance || left.blockIndex - right.blockIndex;
      })
      .slice(0, MAX_NEARBY_BLOCKS);
    nearby.forEach((block) => selected.add(block.blockIndex));
  }

  return [...selected].sort((left, right) => left - right);
}

export function expandBlueprintSlotEvidence(
  slot: CardBlueprintSlot,
  sourceBlocks: readonly SourceBlock[],
): CardBlueprintSlot {
  return {
    ...slot,
    sourceBlockIndexes: expandBlueprintEvidenceBlockIndexes(slot.sourceBlockIndexes, sourceBlocks),
  };
}

export function blueprintCitationForSlot(
  slot: CardBlueprintSlot,
  sourceBlocks: readonly SourceBlock[],
): { page: number; quote: string } | null {
  const evidenceIndexes = new Set(slot.sourceBlockIndexes);
  const evidence = sourceBlocks
    .filter((block) => evidenceIndexes.has(block.blockIndex))
    .sort((left, right) => left.blockIndex - right.blockIndex);
  const strongestBlock = [...evidence]
    .filter((block) => normalizedLength(block) >= MIN_CITATION_LENGTH)
    .sort((left, right) => {
      const kindDifference = Number(right.kind !== "heading") - Number(left.kind !== "heading");
      return kindDifference || normalizedLength(right) - normalizedLength(left);
    })[0];
  if (strongestBlock) {
    return {
      page: strongestBlock.pageNumber,
      quote: normalizeSourceText(strongestBlock.text).slice(0, 400).trim(),
    };
  }

  const byPage = new Map<number, string[]>();
  for (const block of evidence) {
    const current = byPage.get(block.pageNumber) ?? [];
    current.push(normalizeSourceText(block.text));
    byPage.set(block.pageNumber, current);
  }
  const combined = [...byPage.entries()]
    .map(([page, texts]) => ({ page, quote: texts.filter(Boolean).join(" ").slice(0, 400).trim() }))
    .filter((citation) => citation.quote.length >= MIN_CITATION_LENGTH)
    .sort((left, right) => right.quote.length - left.quote.length)[0];
  return combined ?? null;
}

export function citationIsWithinSlotEvidence(
  citation: { page: number; quote: string },
  slot: CardBlueprintSlot,
  sourceBlocks: readonly SourceBlock[],
): boolean {
  const quote = normalizeSourceText(citation.quote);
  if (quote.length < MIN_CITATION_LENGTH || quote.length > 400) return false;
  const evidenceIndexes = new Set(slot.sourceBlockIndexes);
  const pageText = sourceBlocks
    .filter((block) => evidenceIndexes.has(block.blockIndex) && block.pageNumber === citation.page)
    .sort((left, right) => left.blockIndex - right.blockIndex)
    .map((block) => block.text)
    .join("\n\n");
  return normalizeSourceText(pageText).includes(quote);
}
