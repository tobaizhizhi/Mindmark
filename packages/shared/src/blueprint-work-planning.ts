import type { Hex } from "viem";
import { hashWorkUnitSourceV2 } from "./hash-v2.js";
import { buildWorkUnitManifestV2 } from "./merkle-v2.js";
import { CardBlueprintSchema, type BlueprintSlotAssignment, type CardBlueprint } from "./card-blueprint.js";
import { validateChapterOutline } from "./chapter-planning.js";
import { filterExcludedSourceBlocks } from "./source-relevance.js";
import {
  MAX_PROJECT_CARDS,
  MAX_PROJECT_WORK_UNITS,
  SourceBlockSchema,
  WorkUnitSchema,
  type ChapterOutlineItem,
  type SourceBlock,
  type SourceExclusionRange,
  type WorkUnit,
} from "./project-v2.js";

export const MAX_BLUEPRINT_SLOTS_PER_WORK_UNIT = 8;

export type PlannedBlueprintWorkUnit = WorkUnit & {
  sourceBlocks: SourceBlock[];
  sourceText: string;
};

export type BlueprintWorkUnitPlan = {
  projectId: Hex;
  workUnitManifestRoot: Hex;
  workUnits: PlannedBlueprintWorkUnit[];
  slotAssignments: BlueprintSlotAssignment[];
};

/** Each Worker sees the full Chapter evidence but generates only a bounded Slot batch. */
export function planBlueprintWorkUnits(
  projectId: Hex,
  rawChapters: ChapterOutlineItem[],
  rawBlocks: SourceBlock[],
  rawBlueprints: CardBlueprint[],
  rawExcludedRanges: SourceExclusionRange[] = [],
): BlueprintWorkUnitPlan {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const chapters = validateChapterOutline(rawChapters, blocks, rawExcludedRanges);
  const blueprints = new Map(rawBlueprints.map((blueprint) => {
    const parsed = CardBlueprintSchema.parse(blueprint);
    return [parsed.chapterId, parsed] as const;
  }));
  if (blueprints.size !== chapters.length || chapters.some((chapter) => !blueprints.has(chapter.chapterId))) {
    throw new Error("Every Chapter needs exactly one Card Blueprint before Work Unit planning");
  }
  if (chapters.length > MAX_PROJECT_WORK_UNITS) {
    throw new RangeError(`Work Unit plan cannot exceed ${MAX_PROJECT_WORK_UNITS} entries`);
  }

  const drafts: Array<Omit<WorkUnit, "manifestProof"> & { sourceBlocks: SourceBlock[] }> = [];
  const slotAssignments: BlueprintSlotAssignment[] = [];
  let plannedCards = 0;
  let workUnitId = 0;
  for (const chapter of chapters) {
    const sourceBlocks = filterExcludedSourceBlocks(
      blocks.slice(chapter.startBlock, chapter.endBlock + 1),
      rawExcludedRanges,
    );
    const blueprint = blueprints.get(chapter.chapterId)!;
    const targetCards = Math.max(1, blueprint.slots.length);
    if (targetCards > 30) throw new RangeError("A Chapter Card Blueprint cannot exceed 30 slots");
    plannedCards += targetCards;
    for (let offset = 0; offset < blueprint.slots.length; offset += MAX_BLUEPRINT_SLOTS_PER_WORK_UNIT) {
      const slots = blueprint.slots.slice(offset, offset + MAX_BLUEPRINT_SLOTS_PER_WORK_UNIT);
      const unitIndex = Math.floor(offset / MAX_BLUEPRINT_SLOTS_PER_WORK_UNIT);
      drafts.push({
        projectId,
        workUnitId,
        chapterId: chapter.chapterId,
        unitIndex,
        startBlock: chapter.startBlock,
        endBlock: chapter.endBlock,
        sourceBlockIndexes: sourceBlocks.map((block) => block.blockIndex),
        sourceUnitHash: hashWorkUnitSourceV2(sourceBlocks),
        cardMinimum: slots.length,
        cardTarget: slots.length,
        cardBudget: slots.length,
        workerAddress: null,
        status: "QUEUED",
        sourceBlocks,
      });
      slotAssignments.push(...slots.map((slot) => ({ slotId: slot.slotId, workUnitId })));
      workUnitId += 1;
    }
  }
  if (plannedCards > MAX_PROJECT_CARDS) {
    throw new RangeError(`Knowledge Card plan cannot exceed ${MAX_PROJECT_CARDS} entries`);
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
    const parsed = WorkUnitSchema.parse({ ...workUnit, manifestProof: manifest.workUnits[index]!.proof });
    return {
      ...parsed,
      sourceBlocks,
      sourceText: sourceBlocks.map((block) => block.text).join("\n\n"),
    };
  });
  return { projectId, workUnitManifestRoot: manifest.root, workUnits, slotAssignments };
}
