import type { Hex } from "viem";
import { hashWorkUnitSourceV2 } from "./hash-v2.js";
import { buildWorkUnitManifestV2 } from "./merkle-v2.js";
import {
  MAX_CHAPTER_WORK_UNITS,
  MAX_PROJECT_CARDS,
  MAX_PROJECT_WORK_UNITS,
  SourceBlockSchema,
  WorkUnitSchema,
  type ChapterOutlineItem,
  type SourceBlock,
  type WorkUnit,
} from "./project-v2.js";
import { validateChapterOutline } from "./chapter-planning.js";
import { planChapterCardPolicy, type ChapterCardPolicy } from "./card-policy.js";

export type PlannedWorkUnit = WorkUnit & {
  sourceBlocks: SourceBlock[];
  sourceText: string;
};

export type WorkUnitPlan = {
  projectId: Hex;
  workUnitManifestRoot: Hex;
  chapterPolicies: ChapterCardPolicy[];
  workUnits: PlannedWorkUnit[];
};

function partitionBlocks(blocks: SourceBlock[], count: number): SourceBlock[][] {
  const groups: SourceBlock[][] = [];
  let cursor = 0;
  let remainingCharacters = blocks.reduce((total, block) => total + block.text.length, 0);
  for (let index = 0; index < count; index += 1) {
    const remainingGroups = count - index;
    const target = remainingCharacters / remainingGroups;
    const group: SourceBlock[] = [];
    let characters = 0;
    while (cursor < blocks.length) {
      const block = blocks[cursor]!;
      group.push(block);
      characters += block.text.length;
      cursor += 1;
      const blocksLeft = blocks.length - cursor;
      if (characters >= target && blocksLeft >= remainingGroups - 1) break;
      if (blocksLeft === remainingGroups - 1) break;
    }
    groups.push(group);
    remainingCharacters -= characters;
  }
  return groups;
}

function allocateBudgets(characterCounts: number[], totalBudget: number, minimum: number): number[] {
  const totalCharacters = characterCounts.reduce((sum, count) => sum + count, 0);
  const budgets = characterCounts.map(() => minimum);
  let remaining = totalBudget - minimum * characterCounts.length;
  const shares = characterCounts.map((count, index) => ({
    index,
    share: totalCharacters === 0 ? 0 : (count / totalCharacters) * remaining,
  }));
  for (const item of shares) {
    const addition = Math.floor(item.share);
    budgets[item.index] = Math.min(30, budgets[item.index]! + addition);
  }
  remaining = totalBudget - budgets.reduce((sum, value) => sum + value, 0);
  const priority = [...shares].sort(
    (left, right) => right.share - Math.floor(right.share) - (left.share - Math.floor(left.share)),
  );
  while (remaining > 0) {
    const target = priority.find((item) => budgets[item.index]! < 30);
    if (!target) break;
    budgets[target.index] = budgets[target.index]! + 1;
    remaining -= 1;
    priority.push(priority.shift()!);
  }
  return budgets;
}

export function planWorkUnits(
  projectId: Hex,
  rawChapters: ChapterOutlineItem[],
  rawBlocks: SourceBlock[],
): WorkUnitPlan {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const chapters = validateChapterOutline(rawChapters, blocks);
  const chapterBlocks = chapters.map((chapter) =>
    blocks.slice(chapter.startBlock, chapter.endBlock + 1),
  );
  const chapterCharacters = chapterBlocks.map((source) =>
    source.reduce((total, block) => total + block.text.length, 0),
  );
  const chapterPolicies = chapters.map((chapter, index) =>
    planChapterCardPolicy(chapter, chapterBlocks[index]!),
  );
  const desiredCards = chapterPolicies.reduce((total, policy) => total + policy.targetCardCount, 0);
  if (desiredCards > MAX_PROJECT_CARDS) {
    throw new RangeError(`Knowledge Card plan cannot exceed ${MAX_PROJECT_CARDS} entries`);
  }
  const drafts: Array<Omit<WorkUnit, "manifestProof"> & { sourceBlocks: SourceBlock[] }> = [];
  let workUnitId = 0;

  for (const [chapterIndex, chapter] of chapters.entries()) {
    const source = chapterBlocks[chapterIndex]!;
    const unitCount = Math.min(
      MAX_CHAPTER_WORK_UNITS,
      source.length,
      Math.max(1, Math.ceil(chapterCharacters[chapterIndex]! / 6_000)),
    );
    const groups = partitionBlocks(source, unitCount);
    const groupCharacters = groups.map((group) =>
      group.reduce((total, block) => total + block.text.length, 0),
    );
    const policy = chapterPolicies[chapterIndex]!;
    const unitMinimums = allocateBudgets(
      groupCharacters,
      Math.max(policy.minCardCount, groups.length),
      1,
    );
    const unitTargets = allocateBudgets(
      groupCharacters,
      Math.max(policy.targetCardCount, groups.length),
      1,
    );
    const unitBudgets = allocateBudgets(
      groupCharacters,
      Math.max(policy.maxCardCount, groups.length),
      1,
    );
    for (const [unitIndex, group] of groups.entries()) {
      drafts.push({
        projectId,
        workUnitId,
        chapterId: chapter.chapterId,
        unitIndex,
        startBlock: group[0]!.blockIndex,
        endBlock: group.at(-1)!.blockIndex,
        sourceBlockIndexes: group.map((block) => block.blockIndex),
        sourceUnitHash: hashWorkUnitSourceV2(group),
        cardMinimum: unitMinimums[unitIndex]!,
        cardTarget: unitTargets[unitIndex]!,
        cardBudget: unitBudgets[unitIndex]!,
        workerAddress: null,
        status: "QUEUED",
        sourceBlocks: group,
      });
      workUnitId += 1;
    }
  }
  if (drafts.length > MAX_PROJECT_WORK_UNITS) {
    throw new RangeError(`Work Unit plan cannot exceed ${MAX_PROJECT_WORK_UNITS} entries`);
  }
  const manifest = buildWorkUnitManifestV2(
    projectId,
    drafts.map((draft) => ({
      chapterId: draft.chapterId,
      workUnitId: draft.workUnitId,
      sourceUnitHash: draft.sourceUnitHash,
    })),
  );
  const workUnits = drafts.map((draft, index) => {
    const { sourceBlocks, ...workUnit } = draft;
    const parsed = WorkUnitSchema.parse({
      ...workUnit,
      manifestProof: manifest.workUnits[index]!.proof,
    });
    return {
      ...parsed,
      sourceBlocks,
      sourceText: sourceBlocks.map((block) => block.text).join("\n\n"),
    };
  });
  return { projectId, workUnitManifestRoot: manifest.root, chapterPolicies, workUnits };
}
