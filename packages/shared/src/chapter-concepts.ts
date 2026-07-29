import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { z } from "zod";
import { canonicalize } from "json-canonicalize";
import { Bytes32Schema } from "./schemas.js";
import {
  MAX_PROJECT_CHAPTERS,
  SourceBlockSchema,
  type ChapterOutlineItem,
  type SourceBlock,
} from "./project-v2.js";

export const LEARNING_DESIGN_POLICY_VERSION = 3;
export const MAX_CHAPTER_CONCEPTS = 40;

const SourceBlockIndexesSchema = z
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

export const ConceptImportanceSchema = z.number().int().min(1).max(5);

/** Model-supplied fields only. IDs and hashes are derived by the server. */
export const ChapterConceptProposalSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    importance: ConceptImportanceSchema,
    learningObjective: z.string().trim().min(1).max(500),
    sourceBlockIndexes: SourceBlockIndexesSchema,
    prerequisites: z.array(z.string().trim().min(1).max(160)).max(12).default([]),
    misconceptions: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
  })
  .strict();

export const ChapterConceptProposalListSchema = z
  .array(ChapterConceptProposalSchema)
  .min(1)
  .max(MAX_CHAPTER_CONCEPTS);

export const ChapterConceptSchema = ChapterConceptProposalSchema.extend({
  conceptId: Bytes32Schema,
}).strict();

export const ChapterConceptInventorySchema = z
  .object({
    projectId: Bytes32Schema,
    chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
    outlineVersion: z.number().int().positive(),
    sourceHash: Bytes32Schema,
    policyVersion: z.literal(LEARNING_DESIGN_POLICY_VERSION),
    concepts: z.array(ChapterConceptSchema).min(1).max(MAX_CHAPTER_CONCEPTS),
  })
  .strict();

export type ChapterConceptProposal = z.infer<typeof ChapterConceptProposalSchema>;
export type ChapterConcept = z.infer<typeof ChapterConceptSchema>;
export type ChapterConceptInventory = z.infer<typeof ChapterConceptInventorySchema>;

function normaliseName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function deriveConceptIdV3(input: {
  projectId: Hex;
  chapterId: number;
  sourceHash: Hex;
  ordinal: number;
  name: string;
}): Hex {
  if (!Number.isInteger(input.chapterId) || input.chapterId < 0 || input.chapterId >= MAX_PROJECT_CHAPTERS) {
    throw new RangeError("chapterId must be a valid Chapter index");
  }
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= MAX_CHAPTER_CONCEPTS) {
    throw new RangeError("ordinal must be a valid Concept index");
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "string" },
      ],
      [
        "MINDMARK_CHAPTER_CONCEPT_V3",
        Bytes32Schema.parse(input.projectId),
        input.chapterId,
        Bytes32Schema.parse(input.sourceHash),
        input.ordinal,
        normaliseName(input.name),
      ],
    ),
  );
}

export function materializeChapterConceptInventory(input: {
  projectId: Hex;
  chapterId: number;
  outlineVersion: number;
  sourceHash: Hex;
  concepts: ChapterConceptProposal[];
}): ChapterConceptInventory {
  const proposals = ChapterConceptProposalListSchema.parse(input.concepts);
  return ChapterConceptInventorySchema.parse({
    projectId: input.projectId,
    chapterId: input.chapterId,
    outlineVersion: input.outlineVersion,
    sourceHash: input.sourceHash,
    policyVersion: LEARNING_DESIGN_POLICY_VERSION,
    concepts: proposals.map((concept, ordinal) => ({
      ...concept,
      conceptId: deriveConceptIdV3({
        projectId: input.projectId,
        chapterId: input.chapterId,
        sourceHash: input.sourceHash,
        ordinal,
        name: concept.name,
      }),
    })),
  });
}

export function hashChapterConceptInventoryV3(rawInventory: ChapterConceptInventory): Hex {
  const inventory = ChapterConceptInventorySchema.parse(rawInventory);
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }],
      ["MINDMARK_CHAPTER_CONCEPT_INVENTORY_V3", canonicalize(inventory)],
    ),
  );
}

/**
 * Validates source grounding and local semantic uniqueness. The caller passes
 * the Chapter source range, so concepts can never cite adjacent Chapters.
 */
export function validateChapterConceptInventory(
  rawInventory: ChapterConceptInventory,
  rawChapter: ChapterOutlineItem,
  rawBlocks: SourceBlock[],
): ChapterConceptInventory {
  const inventory = ChapterConceptInventorySchema.parse(rawInventory);
  const chapter = rawChapter;
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  if (inventory.chapterId !== chapter.chapterId) {
    throw new Error("Concept Inventory chapterId does not match the Chapter");
  }
  if (inventory.sourceHash !== chapter.sourceHash) {
    throw new Error("Concept Inventory sourceHash does not match the Chapter");
  }

  const availableIndexes = new Set(
    blocks
      .filter((block) => block.blockIndex >= chapter.startBlock && block.blockIndex <= chapter.endBlock)
      .map((block) => block.blockIndex),
  );
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const concept of inventory.concepts) {
    const name = normaliseName(concept.name);
    if (names.has(name)) throw new Error(`Concept Inventory repeats concept name: ${concept.name}`);
    names.add(name);
    if (ids.has(concept.conceptId)) throw new Error("Concept Inventory contains duplicate concept IDs");
    ids.add(concept.conceptId);
    if (concept.sourceBlockIndexes.some((index) => !availableIndexes.has(index))) {
      throw new Error(`Concept ${concept.name} cites Source Blocks outside its Chapter`);
    }
  }
  return inventory;
}
