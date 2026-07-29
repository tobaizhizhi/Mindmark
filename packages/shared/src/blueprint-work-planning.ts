import type { Hex } from "viem";
import { hashWorkUnitSourceV2 } from "./hash-v2.js";
import { buildWorkUnitManifestV2 } from "./merkle-v2.js";
import { assignBlueprintSlotsToWorkUnits, CardBlueprintSchema, type BlueprintSlotAssignment, type CardBlueprint } from "./card-blueprint.js";
import { validateChapterOutline } from "./chapter-planning.js";
import {
  MAX_PROJECT_CARDS,
  MAX_PROJECT_WORK_UNITS,
  SourceBlockSchema,
  WorkUnitSchema,
  type ChapterOutlineItem,
  type SourceBlock,
  type WorkUnit,
} from "./project-v2.js";

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

/**
 * Policy v3 starts with one Work Unit per Chapter. It is deliberately
 * conservative: every Blueprint Slot's evidence stays in one Worker context.
 * Future packing may split a Chapter only at Blueprint-safe boundaries.
 */
export function planBlueprintWorkUnits(
  projectId: Hex,
  rawChapters: ChapterOutlineItem[],
  rawBlocks: SourceBlock[],
  rawBlueprints: CardBlueprint[],
): BlueprintWorkUnitPlan {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const chapters = validateChapterOutline(rawChapters, blocks);
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
  let plannedCards = 0;
  for (const [workUnitId, chapter] of chapters.entries()) {
    const sourceBlocks = blocks.slice(chapter.startBlock, chapter.endBlock + 1);
    const blueprint = blueprints.get(chapter.chapterId)!;
    const requiredCards = blueprint.slots.filter((slot) => slot.required).length;
    const targetCards = Math.max(1, blueprint.slots.length);
    if (targetCards > 30) throw new RangeError("A Chapter Card Blueprint cannot exceed 30 slots");
    plannedCards += targetCards;
    drafts.push({
      projectId,
      workUnitId,
      chapterId: chapter.chapterId,
      unitIndex: 0,
      startBlock: chapter.startBlock,
      endBlock: chapter.endBlock,
      sourceBlockIndexes: sourceBlocks.map((block) => block.blockIndex),
      sourceUnitHash: hashWorkUnitSourceV2(sourceBlocks),
      cardMinimum: Math.max(1, requiredCards),
      cardTarget: targetCards,
      cardBudget: targetCards,
      workerAddress: null,
      status: "QUEUED",
      sourceBlocks,
    });
  }
  if (plannedCards > MAX_PROJECT_CARDS) {
    throw new RangeError(`Knowledge Card plan cannot exceed ${MAX_PROJECT_CARDS} entries`);
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
  const slotAssignments = [...blueprints.values()].flatMap((blueprint) =>
    assignBlueprintSlotsToWorkUnits(blueprint, workUnits),
  );
  return { projectId, workUnitManifestRoot: manifest.root, workUnits, slotAssignments };
}
