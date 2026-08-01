import {
  hashChapterSourceV2,
  intakeSource,
  materializeCardBlueprint,
  materializeChapterConceptInventory,
  type ChapterOutlineItem,
} from "@mindmark/shared";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { ChapterDesignWorkflowAgent } from "../src/chapter-design-agent.js";
import { ProjectDesignFreezer } from "../src/project-design-freezer.js";
import type {
  ChapterDesignRepositoryV3,
  ChapterDesignRunV3,
  ChapterDesignSourceV3,
  ProjectDesignFreezeRepositoryV3,
} from "../src/types-v2.js";
import { ScriptedModel } from "./fakes.js";

const projectId = `0x${"35".repeat(32)}` as Hex;
const designRunId = "123e4567-e89b-42d3-a456-426614174099";

function fixture() {
  const source = intakeSource([
    {
      pageNumber: 1,
      text: "# 重入防御\n\n外部调用会把控制权交给未知代码。\n\n在外部交互前更新状态可以降低重入风险。",
    },
  ]);
  const chapter: ChapterOutlineItem = {
    chapterId: 0,
    position: 0,
    title: "重入防御",
    summary: "理解风险与状态更新顺序",
    startBlock: 0,
    endBlock: source.blocks.length - 1,
    pageStart: 1,
    pageEnd: 1,
    sourceHash: hashChapterSourceV2(source.blocks),
    importance: 5,
  };
  return { source, chapter };
}

function cardPolicy() {
  return {
    chapterId: 0,
    minCardCount: 2,
    targetCardCount: 2,
    maxCardCount: 4,
    policyVersion: 3 as const,
  };
}

class InMemoryDesignRepository implements ChapterDesignRepositoryV3 {
  readonly fixture = fixture();
  completed: Parameters<ChapterDesignRepositoryV3["completeChapterDesign"]>[0] | null = null;
  failed: string | null = null;
  run: ChapterDesignRunV3 = {
    designRunId,
    projectId,
    chapterId: 0,
    outlineVersion: 1,
    policyVersion: 3,
    status: "RUNNING",
    attempt: 1,
  };

  async loadChapterDesignSource(): Promise<ChapterDesignSourceV3> {
    return {
      projectId,
      goal: "理解重入防御",
      outlineVersion: 1,
      chapter: this.fixture.chapter,
      cardPolicy: cardPolicy(),
      sourceBlocks: this.fixture.source.blocks,
    };
  }

  async startChapterDesign() { return structuredClone(this.run); }

  async completeChapterDesign(input: Parameters<ChapterDesignRepositoryV3["completeChapterDesign"]>[0]) {
    this.completed = structuredClone(input);
    this.run.status = "COMPLETED";
  }

  async failChapterDesign(_designRunId: string, message: string) {
    this.failed = message;
    this.run.status = "FAILED";
  }
}

class InMemoryFreezerRepository implements ProjectDesignFreezeRepositoryV3 {
  readonly fixture = fixture();
  frozen: Parameters<ProjectDesignFreezeRepositoryV3["freezeProjectDesign"]>[0] | null = null;

  async loadProjectDesignFreezeSource() {
    const inventory = materializeChapterConceptInventory({
      projectId,
      chapterId: 0,
      outlineVersion: 1,
      sourceHash: this.fixture.chapter.sourceHash,
      concepts: [{
        name: "重入风险",
        importance: 5,
        learningObjective: "解释外部调用如何引入重入风险。",
        sourceBlockIndexes: [1],
        prerequisites: [],
        misconceptions: ["外部调用本身一定不安全。"],
      }],
    });
    const blueprint = materializeCardBlueprint({
      projectId,
      chapterId: 0,
      outlineVersion: 1,
      inventoryHash: `0x${"45".repeat(32)}` as Hex,
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
          objective: "纠正对外部调用风险的误解。",
          difficulty: 3,
          sourceBlockIndexes: [1],
          required: true,
        },
      ],
    });
    return {
      projectId,
      sourceHash: this.fixture.source.sourceHash,
      goalHash: `0x${"55".repeat(32)}` as Hex,
      outlineHash: `0x${"65".repeat(32)}` as Hex,
      outlineVersion: 1,
      chapters: [this.fixture.chapter],
      chapterPolicies: [cardPolicy()],
      sourceBlocks: this.fixture.source.blocks,
      excludedRanges: [],
      designs: [{
        chapterId: 0,
        inventory,
        blueprint,
        inventoryHash: `0x${"45".repeat(32)}` as Hex,
        blueprintHash: `0x${"75".repeat(32)}` as Hex,
      }],
    };
  }

  async freezeProjectDesign(input: Parameters<ProjectDesignFreezeRepositoryV3["freezeProjectDesign"]>[0]) {
    this.frozen = structuredClone(input);
  }
}

describe("ChapterDesignWorkflowAgent", () => {
  it("persists a validated Inventory and Blueprint with server-derived IDs", async () => {
    const repository = new InMemoryDesignRepository();
    const concepts = [{
      name: "重入风险",
      importance: 5 as const,
      learningObjective: "解释外部调用如何引入重入风险。",
      sourceBlockIndexes: [1],
      prerequisites: [],
      misconceptions: ["外部调用本身一定不安全。"],
    }];
    const conceptId = materializeChapterConceptInventory({
      projectId,
      chapterId: 0,
      outlineVersion: 1,
      sourceHash: repository.fixture.chapter.sourceHash,
      concepts,
    }).concepts[0]!.conceptId;
    const agent = new ChapterDesignWorkflowAgent(repository, new ScriptedModel([
      { id: "read", name: "read_chapter_design_context", arguments: {} },
      {
        id: "concepts",
        name: "propose_chapter_concepts",
        arguments: { concepts },
      },
      {
        id: "blueprint",
        name: "propose_card_blueprint",
        arguments: {
          slots: [
            {
              conceptId,
              type: "concept",
              objective: "解释重入发生的条件。",
              difficulty: 2,
              sourceBlockIndexes: [1],
              required: true,
            },
            {
              conceptId,
              type: "misconception",
              objective: "纠正对外部调用风险的误解。",
              difficulty: 3,
              sourceBlockIndexes: [1],
              required: true,
            },
          ],
        },
      },
    ]));

    await expect(agent.runClaimed({ projectId, chapterId: 0 })).resolves.toEqual({
      state: "DESIGNED",
      designRunId,
    });
    expect(repository.failed).toBeNull();
    expect(repository.completed).toMatchObject({
      designRunId,
      promptVersion: "chapter-design-v3.1.0",
      modelId: "configured-model",
      metrics: { conceptCount: 1, slotCount: 2 },
    });
    expect(repository.completed?.inventory.concepts[0]?.conceptId).toBe(conceptId);
    expect(repository.completed?.blueprint.slots.map((slot) => slot.conceptId)).toEqual([conceptId, conceptId]);
  });

  it("repairs English Inventory and Blueprint text for a Chinese Chapter", async () => {
    const repository = new InMemoryDesignRepository();
    const chineseConcepts = [{
      name: "重入风险",
      importance: 5 as const,
      learningObjective: "解释外部调用如何引入重入风险。",
      sourceBlockIndexes: [1],
      prerequisites: [],
      misconceptions: ["外部调用本身一定不安全。"],
    }];
    const conceptId = materializeChapterConceptInventory({
      projectId,
      chapterId: 0,
      outlineVersion: 1,
      sourceHash: repository.fixture.chapter.sourceHash,
      concepts: chineseConcepts,
    }).concepts[0]!.conceptId;
    const model = new ScriptedModel([
      { id: "read", name: "read_chapter_design_context", arguments: {} },
      {
        id: "english-concepts",
        name: "propose_chapter_concepts",
        arguments: {
          concepts: [{
            name: "Reentrancy Risk",
            importance: 5,
            learningObjective: "Explain how external calls introduce reentrancy risk.",
            sourceBlockIndexes: [1],
            prerequisites: [],
            misconceptions: ["Every external call is unsafe."],
          }],
        },
      },
      { id: "chinese-concepts", name: "propose_chapter_concepts", arguments: { concepts: chineseConcepts } },
      {
        id: "english-blueprint",
        name: "propose_card_blueprint",
        arguments: {
          slots: [
            {
              conceptId,
              type: "concept",
              objective: "Explain the conditions for reentrancy.",
              difficulty: 2,
              sourceBlockIndexes: [1],
              required: true,
            },
            {
              conceptId,
              type: "misconception",
              objective: "Correct misconceptions about external calls.",
              difficulty: 3,
              sourceBlockIndexes: [1],
              required: true,
            },
          ],
        },
      },
      {
        id: "chinese-blueprint",
        name: "propose_card_blueprint",
        arguments: {
          slots: [
            {
              conceptId,
              type: "concept",
              objective: "解释重入发生的条件。",
              difficulty: 2,
              sourceBlockIndexes: [1],
              required: true,
            },
            {
              conceptId,
              type: "misconception",
              objective: "纠正对外部调用风险的误解。",
              difficulty: 3,
              sourceBlockIndexes: [1],
              required: true,
            },
          ],
        },
      },
    ]);
    const agent = new ChapterDesignWorkflowAgent(repository, model);

    await expect(agent.runClaimed({ projectId, chapterId: 0 })).resolves.toMatchObject({
      state: "DESIGNED",
    });

    expect(model.calls).toBe(5);
    expect(repository.completed?.inventory.concepts[0]?.name).toBe("重入风险");
    expect(repository.completed?.blueprint.slots[0]?.objective).toBe("解释重入发生的条件。");
  });

  it("freezes a complete Chapter design into a Blueprint-safe Monad manifest", async () => {
    const repository = new InMemoryFreezerRepository();
    const freezer = new ProjectDesignFreezer(repository);

    await expect(freezer.runClaimed(projectId)).resolves.toMatchObject({
      state: "FROZEN",
      workUnitCount: 1,
    });
    expect(repository.frozen).toMatchObject({
      projectId,
      outlineVersion: 1,
      workUnits: [expect.objectContaining({
        work_unit_id: 0,
        card_minimum: 2,
        card_target: 2,
        card_budget: 2,
      })],
      slotAssignments: [
        expect.objectContaining({ work_unit_id: 0 }),
        expect.objectContaining({ work_unit_id: 0 }),
      ],
    });
  });
});
