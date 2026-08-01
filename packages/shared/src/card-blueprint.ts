import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";
import {
  LEARNING_DESIGN_POLICY_VERSION,
  ChapterConceptInventorySchema,
  type ChapterConceptInventory,
} from "./chapter-concepts.js";
import { ChapterCardPolicySchema, type ChapterCardPolicy } from "./card-policy.js";
import { Bytes32Schema } from "./schemas.js";
import type { ChapterOutlineItem, WorkUnit } from "./project-v2.js";

export const CardBlueprintSlotTypeSchema = z.enum([
  "concept",
  "comparison",
  "process",
  "application",
  "misconception",
]);

const SlotSourceBlockIndexesSchema = z
  .array(z.number().int().min(0).max(65_535))
  .min(1)
  .max(64)
  .superRefine((indexes, context) => {
    for (let index = 1; index < indexes.length; index += 1) {
      if (indexes[index]! <= indexes[index - 1]!) {
        context.addIssue({
          code: "custom",
          message: "sourceBlockIndexes must be ordered and unique",
          path: [index],
        });
      }
    }
  });

/** Model-supplied fields only. slotId is always derived by the server. */
export const CardBlueprintSlotProposalSchema = z
  .object({
    conceptId: Bytes32Schema,
    type: CardBlueprintSlotTypeSchema,
    objective: z.string().trim().min(1).max(500),
    difficulty: z.number().int().min(1).max(5),
    sourceBlockIndexes: SlotSourceBlockIndexesSchema,
    required: z.boolean(),
  })
  .strict();

export const CardBlueprintSlotSchema = CardBlueprintSlotProposalSchema.extend({
  slotId: Bytes32Schema,
}).strict();

export const CardBlueprintSchema = z
  .object({
    projectId: Bytes32Schema,
    chapterId: z.number().int().min(0).max(15),
    outlineVersion: z.number().int().positive(),
    inventoryHash: Bytes32Schema,
    policyVersion: z.literal(LEARNING_DESIGN_POLICY_VERSION),
    slots: z.array(CardBlueprintSlotSchema).min(1).max(30),
  })
  .strict();

export type CardBlueprintSlotType = z.infer<typeof CardBlueprintSlotTypeSchema>;
export type CardBlueprintSlotProposal = z.infer<typeof CardBlueprintSlotProposalSchema>;
export type CardBlueprintSlot = z.infer<typeof CardBlueprintSlotSchema>;
export type CardBlueprint = z.infer<typeof CardBlueprintSchema>;

export function deriveCardBlueprintSlotIdV3(input: {
  projectId: Hex;
  chapterId: number;
  inventoryHash: Hex;
  ordinal: number;
  conceptId: Hex;
  type: CardBlueprintSlotType;
}): Hex {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= 30) {
    throw new RangeError("ordinal must be a valid Blueprint Slot index");
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "string" },
      ],
      [
        "MINDMARK_CARD_BLUEPRINT_SLOT_V3",
        Bytes32Schema.parse(input.projectId),
        input.chapterId,
        Bytes32Schema.parse(input.inventoryHash),
        input.ordinal,
        Bytes32Schema.parse(input.conceptId),
        input.type,
      ],
    ),
  );
}

export function materializeCardBlueprint(input: {
  projectId: Hex;
  chapterId: number;
  outlineVersion: number;
  inventoryHash: Hex;
  slots: CardBlueprintSlotProposal[];
}): CardBlueprint {
  const proposals = CardBlueprintSlotProposalSchema.array().min(1).max(30).parse(input.slots);
  return CardBlueprintSchema.parse({
    projectId: input.projectId,
    chapterId: input.chapterId,
    outlineVersion: input.outlineVersion,
    inventoryHash: input.inventoryHash,
    policyVersion: LEARNING_DESIGN_POLICY_VERSION,
    slots: proposals.map((slot, ordinal) => ({
      ...slot,
      slotId: deriveCardBlueprintSlotIdV3({
        projectId: input.projectId,
        chapterId: input.chapterId,
        inventoryHash: input.inventoryHash,
        ordinal,
        conceptId: slot.conceptId,
        type: slot.type,
      }),
    })),
  });
}

export function hashCardBlueprintV3(rawBlueprint: CardBlueprint): Hex {
  const blueprint = CardBlueprintSchema.parse(rawBlueprint);
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }],
      ["MINDMARK_CARD_BLUEPRINT_V3", canonicalize(blueprint)],
    ),
  );
}

export function validateCardBlueprint(
  rawBlueprint: CardBlueprint,
  rawInventory: ChapterConceptInventory,
  chapter: ChapterOutlineItem,
  rawCardPolicy: ChapterCardPolicy,
): CardBlueprint {
  const blueprint = CardBlueprintSchema.parse(rawBlueprint);
  const inventory = ChapterConceptInventorySchema.parse(rawInventory);
  const cardPolicy = ChapterCardPolicySchema.parse(rawCardPolicy);
  if (blueprint.projectId !== inventory.projectId || blueprint.chapterId !== inventory.chapterId) {
    throw new Error("Card Blueprint does not belong to its Concept Inventory");
  }
  if (blueprint.chapterId !== chapter.chapterId) {
    throw new Error("Card Blueprint chapterId does not match the Chapter");
  }
  if (cardPolicy.chapterId !== chapter.chapterId) {
    throw new Error("Chapter Card Policy does not match the Card Blueprint");
  }
  const concepts = new Map(inventory.concepts.map((concept) => [concept.conceptId, concept]));
  const slotIds = new Set<string>();
  const requiredByConcept = new Set<string>();
  for (const slot of blueprint.slots) {
    if (slotIds.has(slot.slotId)) throw new Error("Card Blueprint contains duplicate slot IDs");
    slotIds.add(slot.slotId);
    if (!concepts.has(slot.conceptId)) {
      throw new Error("Card Blueprint Slot references a Concept outside the Inventory");
    }
    if (slot.sourceBlockIndexes.some(
      (index) => index < chapter.startBlock || index > chapter.endBlock,
    )) {
      throw new Error("Card Blueprint Slot cites Source Blocks outside its Chapter");
    }
    if (slot.required) requiredByConcept.add(slot.conceptId);
  }
  for (const concept of inventory.concepts) {
    if (concept.importance >= 4 && !requiredByConcept.has(concept.conceptId)) {
      throw new Error(`Important Concept has no required Blueprint Slot: ${concept.name}`);
    }
    if (concept.misconceptions.length > 0 && concept.importance >= 4) {
      const hasMisconceptionSlot = blueprint.slots.some(
        (slot) => slot.conceptId === concept.conceptId && slot.type === "misconception" && slot.required,
      );
      if (!hasMisconceptionSlot) {
        throw new Error(`Important Concept with misconceptions needs a required misconception Slot: ${concept.name}`);
      }
    }
  }
  if (blueprint.slots.length < cardPolicy.minCardCount) {
    throw new Error(
      `Card Blueprint has ${blueprint.slots.length} Slots but Chapter minimum is ${cardPolicy.minCardCount}`,
    );
  }
  if (blueprint.slots.length > cardPolicy.maxCardCount) {
    throw new Error(
      `Card Blueprint has ${blueprint.slots.length} Slots and exceeds Chapter maximum ${cardPolicy.maxCardCount}`,
    );
  }
  return blueprint;
}

export type BlueprintSlotAssignment = {
  slotId: Hex;
  workUnitId: number;
};

/**
 * Maps each Blueprint Slot to one contiguous Work Unit. This is intentionally
 * a hard check: a Worker can never cite material outside its assigned unit.
 */
export function assignBlueprintSlotsToWorkUnits(
  rawBlueprint: CardBlueprint,
  rawWorkUnits: WorkUnit[],
): BlueprintSlotAssignment[] {
  const blueprint = CardBlueprintSchema.parse(rawBlueprint);
  const workUnits = rawWorkUnits.filter((unit) => unit.chapterId === blueprint.chapterId);
  return blueprint.slots.map((slot) => {
    const first = slot.sourceBlockIndexes[0]!;
    const last = slot.sourceBlockIndexes.at(-1)!;
    const workUnit = workUnits.find(
      (unit) => unit.startBlock <= first && unit.endBlock >= last,
    );
    if (!workUnit) {
      throw new Error(`Blueprint Slot ${slot.slotId} cannot fit within one contiguous Work Unit`);
    }
    return { slotId: slot.slotId, workUnitId: workUnit.workUnitId };
  });
}
