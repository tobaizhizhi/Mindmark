import { z } from "zod";
import {
  LEARNING_DESIGN_POLICY_VERSION,
  ChapterConceptInventorySchema,
  type ChapterConceptInventory,
} from "./chapter-concepts.js";
import { CardBlueprintSchema, type CardBlueprint } from "./card-blueprint.js";
import { Bytes32Schema } from "./schemas.js";

export const GenerationPolicyV3Schema = z
  .object({
    version: z.literal(LEARNING_DESIGN_POLICY_VERSION),
    weightedCoverageMinimum: z.number().min(0).max(1),
    semanticDuplicateMaximum: z.number().min(0).max(1),
    semanticDuplicateThreshold: z.number().min(0).max(1),
    rubricMinimum: z.number().int().min(0).max(5),
    inventoryRepairLimit: z.number().int().min(0).max(3),
    blueprintRepairLimit: z.number().int().min(0).max(3),
    candidateRepairLimit: z.number().int().min(0).max(5),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.semanticDuplicateThreshold <= policy.semanticDuplicateMaximum) {
      context.addIssue({
        code: "custom",
        message: "semanticDuplicateThreshold must exceed semanticDuplicateMaximum",
        path: ["semanticDuplicateThreshold"],
      });
    }
  });

export const DEFAULT_GENERATION_POLICY_V3 = GenerationPolicyV3Schema.parse({
  version: LEARNING_DESIGN_POLICY_VERSION,
  weightedCoverageMinimum: 0.95,
  semanticDuplicateMaximum: 0.05,
  semanticDuplicateThreshold: 0.92,
  rubricMinimum: 3,
  inventoryRepairLimit: 1,
  blueprintRepairLimit: 1,
  candidateRepairLimit: 2,
});

export type GenerationPolicyV3 = z.infer<typeof GenerationPolicyV3Schema>;

export type BlueprintCoverage = {
  acceptedSlotIds: `0x${string}`[];
  missingRequiredSlotIds: `0x${string}`[];
  uncoveredImportantConceptIds: `0x${string}`[];
  weightedCoverage: number;
  passes: boolean;
};

export function evaluateBlueprintCoverage(input: {
  inventory: ChapterConceptInventory;
  blueprint: CardBlueprint;
  acceptedSlotIds: string[];
  policy?: GenerationPolicyV3;
}): BlueprintCoverage {
  const inventory = ChapterConceptInventorySchema.parse(input.inventory);
  const blueprint = CardBlueprintSchema.parse(input.blueprint);
  const policy = GenerationPolicyV3Schema.parse(input.policy ?? DEFAULT_GENERATION_POLICY_V3);
  const accepted = new Set(input.acceptedSlotIds.map((slotId) => Bytes32Schema.parse(slotId)));
  const requiredSlots = blueprint.slots.filter((slot) => slot.required);
  const missingRequiredSlotIds = requiredSlots
    .filter((slot) => !accepted.has(slot.slotId))
    .map((slot) => slot.slotId);
  const coveredConceptIds = new Set(
    blueprint.slots.filter((slot) => accepted.has(slot.slotId)).map((slot) => slot.conceptId),
  );
  const importantConcepts = inventory.concepts.filter((concept) => concept.importance >= 4);
  const uncoveredImportantConceptIds = importantConcepts
    .filter((concept) => !coveredConceptIds.has(concept.conceptId))
    .map((concept) => concept.conceptId);
  const requiredConcepts = inventory.concepts.filter((concept) =>
    requiredSlots.some((slot) => slot.conceptId === concept.conceptId),
  );
  const requiredWeight = requiredConcepts.reduce((total, concept) => total + concept.importance, 0);
  const coveredWeight = requiredConcepts
    .filter((concept) => coveredConceptIds.has(concept.conceptId))
    .reduce((total, concept) => total + concept.importance, 0);
  const weightedCoverage = requiredWeight === 0 ? 0 : coveredWeight / requiredWeight;
  return {
    acceptedSlotIds: [...accepted],
    missingRequiredSlotIds,
    uncoveredImportantConceptIds,
    weightedCoverage,
    passes:
      missingRequiredSlotIds.length === 0 &&
      uncoveredImportantConceptIds.length === 0 &&
      weightedCoverage >= policy.weightedCoverageMinimum,
  };
}

export type DuplicateCandidate = {
  candidateId: string;
  question: string;
  keyPoint: string;
  embedding?: number[];
};

export type DuplicatePair = {
  leftCandidateId: string;
  rightCandidateId: string;
  reason: "EXACT_NORMALIZED" | "SEMANTIC";
  similarity: number;
};

function normaliseText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new Error("Embedding vectors must be non-empty and have equal dimensions");
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Embedding vectors must be finite");
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function findDuplicateCandidates(
  candidates: DuplicateCandidate[],
  semanticThreshold = DEFAULT_GENERATION_POLICY_V3.semanticDuplicateThreshold,
): DuplicatePair[] {
  if (semanticThreshold < 0 || semanticThreshold > 1) {
    throw new RangeError("semanticThreshold must be between zero and one");
  }
  const duplicates: DuplicatePair[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!;
    const leftText = `${normaliseText(left.question)}\n${normaliseText(left.keyPoint)}`;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]!;
      const rightText = `${normaliseText(right.question)}\n${normaliseText(right.keyPoint)}`;
      if (leftText === rightText) {
        duplicates.push({
          leftCandidateId: left.candidateId,
          rightCandidateId: right.candidateId,
          reason: "EXACT_NORMALIZED",
          similarity: 1,
        });
        continue;
      }
      if (left.embedding && right.embedding) {
        const similarity = cosineSimilarity(left.embedding, right.embedding);
        if (similarity >= semanticThreshold) {
          duplicates.push({
            leftCandidateId: left.candidateId,
            rightCandidateId: right.candidateId,
            reason: "SEMANTIC",
            similarity,
          });
        }
      }
    }
  }
  return duplicates;
}
