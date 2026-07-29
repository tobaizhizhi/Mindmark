import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  DEFAULT_GENERATION_POLICY_V3,
  assignBlueprintSlotsToWorkUnits,
  evaluateBlueprintCoverage,
  findDuplicateCandidates,
  hashChapterSourceV2,
  hashCardBlueprintV3,
  hashChapterConceptInventoryV3,
  intakeSource,
  materializeCardBlueprint,
  materializeChapterConceptInventory,
  planBlueprintWorkUnits,
  validateCardBlueprint,
  validateChapterConceptInventory,
  type ChapterOutlineItem,
  type WorkUnit,
} from "../src/index.js";

const projectId = `0x${"ab".repeat(32)}` as Hex;

function fixture() {
  const source = intakeSource([
    {
      pageNumber: 1,
      text: "# 重入原理\n\n重入发生在外部调用把控制权转移给未知代码时。\n\n状态必须在外部调用前更新。",
    },
  ]);
  const chapter: ChapterOutlineItem = {
    chapterId: 0,
    position: 0,
    title: "重入原理",
    summary: "理解重入条件与防御顺序",
    startBlock: 0,
    endBlock: source.blocks.length - 1,
    pageStart: 1,
    pageEnd: 1,
    sourceHash: hashChapterSourceV2(source.blocks),
    importance: 5,
  };
  const inventory = materializeChapterConceptInventory({
    projectId,
    chapterId: chapter.chapterId,
    outlineVersion: 1,
    sourceHash: chapter.sourceHash,
    concepts: [
      {
        name: "重入条件",
        importance: 5,
        learningObjective: "说明外部调用为何会产生重入风险。",
        sourceBlockIndexes: [1],
        prerequisites: [],
        misconceptions: ["任何外部调用都会自动造成重入。"],
      },
      {
        name: "检查-更新-交互",
        importance: 4,
        learningObjective: "按正确顺序执行状态更新与外部交互。",
        sourceBlockIndexes: [2],
        prerequisites: ["重入条件"],
        misconceptions: [],
      },
    ],
  });
  return { source, chapter, inventory };
}

describe("V3 learning design domain", () => {
  it("materializes stable source-grounded concept and Blueprint IDs", () => {
    const { source, chapter, inventory } = fixture();
    expect(validateChapterConceptInventory(inventory, chapter, source.blocks)).toEqual(inventory);

    const blueprint = materializeCardBlueprint({
      projectId,
      chapterId: chapter.chapterId,
      outlineVersion: 1,
      inventoryHash: `0x${"cd".repeat(32)}` as Hex,
      slots: [
        {
          conceptId: inventory.concepts[0]!.conceptId,
          type: "concept",
          objective: "解释重入发生的条件。",
          difficulty: 2,
          sourceBlockIndexes: [1],
          required: true,
        },
        {
          conceptId: inventory.concepts[0]!.conceptId,
          type: "misconception",
          objective: "纠正对外部调用与重入关系的误解。",
          difficulty: 3,
          sourceBlockIndexes: [1],
          required: true,
        },
        {
          conceptId: inventory.concepts[1]!.conceptId,
          type: "process",
          objective: "说明状态更新与外部交互的先后顺序。",
          difficulty: 3,
          sourceBlockIndexes: [2],
          required: true,
        },
      ],
    });
    expect(validateCardBlueprint(blueprint, inventory, chapter)).toEqual(blueprint);
    expect(new Set(blueprint.slots.map((slot) => slot.slotId)).size).toBe(3);
    expect(hashChapterConceptInventoryV3(inventory)).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(hashCardBlueprintV3(blueprint)).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it("rejects ungrounded Concepts and missing required high-importance Slots", () => {
    const { source, chapter, inventory } = fixture();
    expect(() => validateChapterConceptInventory({
      ...inventory,
      concepts: [{ ...inventory.concepts[0]!, sourceBlockIndexes: [99] }],
    }, chapter, source.blocks)).toThrow(/outside its Chapter/u);

    const incomplete = materializeCardBlueprint({
      projectId,
      chapterId: chapter.chapterId,
      outlineVersion: 1,
      inventoryHash: `0x${"ef".repeat(32)}` as Hex,
      slots: [{
        conceptId: inventory.concepts[0]!.conceptId,
        type: "concept",
        objective: "解释重入条件。",
        difficulty: 2,
        sourceBlockIndexes: [1],
        required: true,
      }],
    });
    expect(() => validateCardBlueprint(incomplete, inventory, chapter)).toThrow(
      /misconception Slot/u,
    );
  });

  it("computes coverage and maps Slots only to Work Units containing all evidence", () => {
    const { source, chapter, inventory } = fixture();
    const blueprint = materializeCardBlueprint({
      projectId,
      chapterId: chapter.chapterId,
      outlineVersion: 1,
      inventoryHash: `0x${"cd".repeat(32)}` as Hex,
      slots: [
        {
          conceptId: inventory.concepts[0]!.conceptId,
          type: "concept",
          objective: "解释重入条件。",
          difficulty: 2,
          sourceBlockIndexes: [1],
          required: true,
        },
        {
          conceptId: inventory.concepts[0]!.conceptId,
          type: "misconception",
          objective: "纠正重入误解。",
          difficulty: 3,
          sourceBlockIndexes: [1],
          required: true,
        },
        {
          conceptId: inventory.concepts[1]!.conceptId,
          type: "process",
          objective: "说明正确防御顺序。",
          difficulty: 3,
          sourceBlockIndexes: [2],
          required: true,
        },
      ],
    });
    const coverage = evaluateBlueprintCoverage({
      inventory,
      blueprint,
      acceptedSlotIds: blueprint.slots.map((slot) => slot.slotId),
    });
    expect(coverage).toMatchObject({ passes: true, weightedCoverage: 1 });

    const units: WorkUnit[] = [{
      projectId,
      workUnitId: 0,
      chapterId: 0,
      unitIndex: 0,
      startBlock: 0,
      endBlock: 2,
      sourceBlockIndexes: [0, 1, 2],
      sourceUnitHash: `0x${"11".repeat(32)}` as Hex,
      manifestProof: [],
      cardMinimum: 1,
      cardTarget: 3,
      cardBudget: 3,
      workerAddress: null,
      status: "QUEUED",
    }];
    expect(assignBlueprintSlotsToWorkUnits(blueprint, units)).toEqual(
      blueprint.slots.map((slot) => ({ slotId: slot.slotId, workUnitId: 0 })),
    );
    const plan = planBlueprintWorkUnits(projectId, [chapter], source.blocks, [blueprint]);
    expect(plan.workUnits).toHaveLength(1);
    expect(plan.workUnits[0]).toMatchObject({ cardMinimum: 3, cardTarget: 3, cardBudget: 3 });
    expect(plan.slotAssignments).toHaveLength(3);
  });

  it("finds normalized and embedding-based duplicate candidates deterministically", () => {
    expect(findDuplicateCandidates([
      {
        candidateId: "one",
        question: "什么是重入？",
        keyPoint: "外部调用转移控制权",
        embedding: [1, 0],
      },
      {
        candidateId: "two",
        question: "什么是重入？ ",
        keyPoint: "外部调用转移控制权",
        embedding: [0, 1],
      },
      {
        candidateId: "three",
        question: "如何防止重入？",
        keyPoint: "先更新状态",
        embedding: [0.99, 0.01],
      },
    ])).toEqual([
      { leftCandidateId: "one", rightCandidateId: "two", reason: "EXACT_NORMALIZED", similarity: 1 },
      { leftCandidateId: "one", rightCandidateId: "three", reason: "SEMANTIC", similarity: expect.any(Number) },
    ]);
    expect(DEFAULT_GENERATION_POLICY_V3.weightedCoverageMinimum).toBe(0.95);
  });
});
