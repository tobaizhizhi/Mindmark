import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import type { Hex } from "viem";
import {
  chapterLeafV2,
  hashTitleV2,
  outlineLeafV2,
  workUnitLeafV2,
} from "./hash-v2.js";
import {
  MAX_PROJECT_CHAPTERS,
  MAX_PROJECT_WORK_UNITS,
  type ChapterOutlineItem,
} from "./project-v2.js";
import { Bytes32Schema } from "./schemas.js";

function ensureUnique(values: readonly number[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} values must be unique`);
}

function buildTree(leaves: Hex[]): SimpleMerkleTree {
  if (leaves.length === 0) throw new Error("A V2 commitment tree cannot be empty");
  return SimpleMerkleTree.of(leaves, { sortLeaves: false });
}

export type CardCommitmentV2 = {
  cardId: Hex;
  leaf: Hex;
  proof: Hex[];
};

export function buildCardTree(cardIds: Hex[]): { root: Hex; cards: CardCommitmentV2[] } {
  if (cardIds.length === 0) throw new Error("A Knowledge Card tree cannot be empty");
  const cards = cardIds.map((cardId) => Bytes32Schema.parse(cardId)).sort();
  if (new Set(cards).size !== cards.length) throw new Error("cardId values must be unique");
  const tree = buildTree(cards);
  return {
    root: Bytes32Schema.parse(tree.root),
    cards: cards.map((cardId, index) => ({
      cardId,
      leaf: cardId,
      proof: tree.getProof(index) as Hex[],
    })),
  };
}

export function verifyMerkleProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  return SimpleMerkleTree.verify(
    Bytes32Schema.parse(root),
    Bytes32Schema.parse(leaf),
    proof.map((item) => Bytes32Schema.parse(item)),
  );
}

export function buildOutlineCommitmentV2(
  projectId: Hex,
  chapters: ChapterOutlineItem[],
): { root: Hex; chapters: Array<ChapterOutlineItem & { leaf: Hex; proof: Hex[] }> } {
  if (chapters.length < 1 || chapters.length > MAX_PROJECT_CHAPTERS) {
    throw new RangeError(`An outline must contain 1 to ${MAX_PROJECT_CHAPTERS} chapters`);
  }
  ensureUnique(chapters.map((chapter) => chapter.chapterId), "chapterId");
  const leaves = chapters.map((chapter) =>
    outlineLeafV2(
      projectId,
      chapter.chapterId,
      hashTitleV2(chapter.title),
      chapter.sourceHash,
    ),
  );
  const tree = buildTree(leaves);
  return {
    root: tree.root as Hex,
    chapters: chapters.map((chapter, index) => ({
      ...chapter,
      leaf: leaves[index]!,
      proof: tree.getProof(index) as Hex[],
    })),
  };
}

export type WorkUnitManifestItemV2 = {
  chapterId: number;
  workUnitId: number;
  sourceUnitHash: Hex;
};

export function buildWorkUnitManifestV2(
  projectId: Hex,
  workUnits: WorkUnitManifestItemV2[],
): {
  root: Hex;
  workUnits: Array<WorkUnitManifestItemV2 & { leaf: Hex; proof: Hex[] }>;
} {
  if (workUnits.length < 1 || workUnits.length > MAX_PROJECT_WORK_UNITS) {
    throw new RangeError(
      `A Work Unit manifest must contain 1 to ${MAX_PROJECT_WORK_UNITS} entries`,
    );
  }
  ensureUnique(workUnits.map((workUnit) => workUnit.workUnitId), "workUnitId");
  const leaves = workUnits.map((workUnit) =>
    workUnitLeafV2(
      projectId,
      workUnit.chapterId,
      workUnit.workUnitId,
      workUnit.sourceUnitHash,
    ),
  );
  const tree = buildTree(leaves);
  return {
    root: tree.root as Hex,
    workUnits: workUnits.map((workUnit, index) => ({
      ...workUnit,
      leaf: leaves[index]!,
      proof: tree.getProof(index) as Hex[],
    })),
  };
}

export type ChapterCommitmentItemV2 = {
  chapterId: number;
  cardsRoot: Hex;
  cardCount: number;
};

export function buildProjectDeckCommitmentV2(
  projectId: Hex,
  chapters: ChapterCommitmentItemV2[],
): {
  root: Hex;
  chapters: Array<ChapterCommitmentItemV2 & { leaf: Hex; proof: Hex[] }>;
} {
  if (chapters.length < 1 || chapters.length > MAX_PROJECT_CHAPTERS) {
    throw new RangeError(`A project deck must contain 1 to ${MAX_PROJECT_CHAPTERS} chapters`);
  }
  ensureUnique(chapters.map((chapter) => chapter.chapterId), "chapterId");
  const leaves = chapters.map((chapter) =>
    chapterLeafV2(projectId, chapter.chapterId, chapter.cardsRoot, chapter.cardCount),
  );
  const tree = buildTree(leaves);
  return {
    root: Bytes32Schema.parse(tree.root),
    chapters: chapters.map((chapter, index) => ({
      ...chapter,
      leaf: leaves[index]!,
      proof: tree.getProof(index) as Hex[],
    })),
  };
}
