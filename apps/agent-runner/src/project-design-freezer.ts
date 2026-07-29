import {
  hashFrozenProjectDesignV3,
  planBlueprintWorkUnits,
  validateCardBlueprint,
  validateChapterConceptInventory,
} from "@mindmark/shared";
import type { ProjectDesignFreezeRepositoryV3 } from "./types-v2.js";

/** Freezes the V3 teaching design before Monad sees a Work Unit manifest. */
export class ProjectDesignFreezer {
  constructor(private readonly repository: ProjectDesignFreezeRepositoryV3) {}

  async runClaimed(projectId: `0x${string}`): Promise<{
    state: "FROZEN";
    workUnitCount: number;
    workUnitManifestRoot: `0x${string}`;
  }> {
    const source = await this.repository.loadProjectDesignFreezeSource(projectId);
    if (source.designs.length !== source.chapters.length) {
      throw new Error("Project Design is incomplete; not every Chapter has a completed Design Run");
    }
    for (const chapter of source.chapters) {
      const design = source.designs.find((candidate) => candidate.chapterId === chapter.chapterId);
      if (!design) throw new Error(`Chapter ${chapter.chapterId} has no completed Design Run`);
      validateChapterConceptInventory(design.inventory, chapter, source.sourceBlocks);
      validateCardBlueprint(design.blueprint, design.inventory, chapter);
    }
    const plan = planBlueprintWorkUnits(
      source.projectId,
      source.chapters,
      source.sourceBlocks,
      source.designs.map((design) => design.blueprint),
    );
    const frozenDesignHash = hashFrozenProjectDesignV3({
      projectId: source.projectId,
      outlineVersion: source.outlineVersion,
      designs: source.designs.map((design) => ({
        chapterId: design.chapterId,
        inventoryHash: design.inventoryHash,
        blueprintHash: design.blueprintHash,
      })),
    });
    const creationIntent = {
      projectId: source.projectId,
      sourceHash: source.sourceHash,
      goalHash: source.goalHash,
      outlineHash: source.outlineHash,
      workUnitManifestRoot: plan.workUnitManifestRoot,
      chapters: source.chapters.map((chapter) => {
        const chapterUnits = plan.workUnits.filter((unit) => unit.chapterId === chapter.chapterId);
        return {
          sourceHash: chapter.sourceHash,
          firstWorkUnitId: chapterUnits[0]!.workUnitId,
          workUnitCount: chapterUnits.length,
        };
      }),
    };
    await this.repository.freezeProjectDesign({
      projectId: source.projectId,
      outlineVersion: source.outlineVersion,
      workUnitManifestRoot: plan.workUnitManifestRoot,
      workUnits: plan.workUnits.map((unit) => ({
        work_unit_id: unit.workUnitId,
        chapter_id: unit.chapterId,
        unit_index: unit.unitIndex,
        start_block: unit.startBlock,
        end_block: unit.endBlock,
        source_text: unit.sourceText,
        source_blocks: unit.sourceBlocks,
        source_unit_hash: unit.sourceUnitHash,
        manifest_proof: unit.manifestProof,
        card_minimum: unit.cardMinimum,
        card_target: unit.cardTarget,
        card_budget: unit.cardBudget,
      })),
      slotAssignments: plan.slotAssignments.map((assignment) => ({
        slot_id: assignment.slotId,
        work_unit_id: assignment.workUnitId,
      })),
      frozenDesignHash,
      creationIntent,
    });
    return {
      state: "FROZEN",
      workUnitCount: plan.workUnits.length,
      workUnitManifestRoot: plan.workUnitManifestRoot,
    };
  }
}
