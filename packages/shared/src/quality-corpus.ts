import { z } from "zod";
import { findDuplicateCandidates, evaluateCardRubric, CardRubricEvaluationSchema } from "./card-quality.js";
import { validateCitation } from "./citations.js";
import { KnowledgeCardContentSchema, SourcePageSchema } from "./schemas.js";

export const QualityCorpusFailureCodeSchema = z.enum([
  "CITATION_INVALID",
  "DUPLICATE_CANDIDATE",
  "CITATION_INSUFFICIENT",
  "FACTUALITY_BELOW_MINIMUM",
  "LEARNING_VALUE_BELOW_MINIMUM",
  "CLARITY_BELOW_MINIMUM",
  "COMPLETENESS_BELOW_MINIMUM",
  "CITATION_RELEVANCE_BELOW_MINIMUM",
  "DIFFICULTY_FIT_BELOW_MINIMUM",
  "EVALUATOR_REPAIR",
  "EVALUATOR_REJECT",
]);

export const QualityCorpusSourceSchema = z.object({
  fixtureId: z.string().regex(/^[a-z0-9-]+$/u),
  pages: z.array(SourcePageSchema).min(1).max(30),
}).strict();

export const QualityCorpusExpectedInventorySchema = z.object({
  fixtureId: z.string().regex(/^[a-z0-9-]+$/u),
  concepts: z.array(z.object({
    name: z.string().min(1).max(160),
    aliases: z.array(z.string().min(1).max(160)).max(8),
    importance: z.number().int().min(1).max(5),
    supportingBlockIndexes: z.array(z.number().int().nonnegative()).min(1),
  }).strict()).min(1),
}).strict();

export const QualityCorpusBlueprintRequirementsSchema = z.object({
  fixtureId: z.string().regex(/^[a-z0-9-]+$/u),
  requiredCardTypes: z.array(z.enum(["concept", "comparison", "process", "application", "misconception"])).min(1),
  maximumCardCount: z.number().int().min(1).max(30),
}).strict();

export const QualityCorpusEvaluationSlotSchema = z.object({
  conceptName: z.string().trim().min(1).max(160),
  type: z.enum(["concept", "comparison", "process", "application", "misconception"]),
  objective: z.string().trim().min(1).max(500),
  difficulty: z.number().int().min(1).max(5),
  evidenceBlockIndexes: z.array(z.number().int().nonnegative()).min(1).max(64),
}).strict();

export const QualityCorpusCandidateCasesSchema = z.object({
  fixtureId: z.string().regex(/^[a-z0-9-]+$/u),
  cases: z.array(z.object({
    caseId: z.string().regex(/^[a-z0-9-]+$/u),
    content: KnowledgeCardContentSchema,
    slot: QualityCorpusEvaluationSlotSchema,
    rubric: CardRubricEvaluationSchema,
    embedding: z.array(z.number().finite()).min(1).max(4096).optional(),
    expectedDecision: z.enum(["ACCEPT", "REPAIR"]),
    expectedFailureCodes: z.array(QualityCorpusFailureCodeSchema),
  }).strict()).min(1).max(30),
}).strict();

const MetricRangeSchema = z.object({
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
}).strict().refine((range) => range.min <= range.max, "Metric range min must not exceed max");

export const QualityCorpusExpectedMetricsSchema = z.object({
  fixtureId: z.string().regex(/^[a-z0-9-]+$/u),
  expectationAccuracy: MetricRangeSchema,
  violationDetectionRate: MetricRangeSchema,
}).strict();

export type QualityCorpusFixture = {
  source: z.infer<typeof QualityCorpusSourceSchema>;
  expectedInventory: z.infer<typeof QualityCorpusExpectedInventorySchema>;
  blueprintRequirements: z.infer<typeof QualityCorpusBlueprintRequirementsSchema>;
  candidateCases: z.infer<typeof QualityCorpusCandidateCasesSchema>;
  expectedMetrics: z.infer<typeof QualityCorpusExpectedMetricsSchema>;
};

export type QualityCorpusReplayReport = {
  fixtureId: string;
  caseCount: number;
  acceptedCaseCount: number;
  repairCaseCount: number;
  expectationAccuracy: number;
  violationDetectionRate: number;
  passesExpectedRanges: boolean;
  cases: Array<{
    caseId: string;
    predictedDecision: "ACCEPT" | "REPAIR";
    expectedDecision: "ACCEPT" | "REPAIR";
    detectedFailureCodes: string[];
  }>;
};

function within(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}

export function replayQualityCorpusFixture(rawFixture: QualityCorpusFixture): QualityCorpusReplayReport {
  const source = QualityCorpusSourceSchema.parse(rawFixture.source);
  const inventory = QualityCorpusExpectedInventorySchema.parse(rawFixture.expectedInventory);
  const blueprint = QualityCorpusBlueprintRequirementsSchema.parse(rawFixture.blueprintRequirements);
  const candidates = QualityCorpusCandidateCasesSchema.parse(rawFixture.candidateCases);
  const expectedMetrics = QualityCorpusExpectedMetricsSchema.parse(rawFixture.expectedMetrics);
  const fixtureIds = new Set([
    source.fixtureId,
    inventory.fixtureId,
    blueprint.fixtureId,
    candidates.fixtureId,
    expectedMetrics.fixtureId,
  ]);
  if (fixtureIds.size !== 1) throw new Error("Quality corpus files have inconsistent fixtureId values");

  const duplicateVictims = new Set(findDuplicateCandidates(candidates.cases.map((candidate) => ({
    candidateId: candidate.rubric.cardId,
    question: candidate.content.question,
    keyPoint: candidate.content.keyPoint,
    ...(candidate.embedding ? { embedding: candidate.embedding } : {}),
  }))).map((pair) => pair.rightCandidateId));

  let correctDecisions = 0;
  let expectedViolations = 0;
  let detectedViolations = 0;
  let acceptedCaseCount = 0;
  const cases = candidates.cases.map((candidate) => {
    const failures = new Set<string>();
    if (!validateCitation(candidate.content, source.pages).valid) failures.add("CITATION_INVALID");
    evaluateCardRubric({ evaluation: candidate.rubric }).failures.forEach((failure) => failures.add(failure));
    if (duplicateVictims.has(candidate.rubric.cardId)) failures.add("DUPLICATE_CANDIDATE");
    const predictedDecision = failures.size === 0 ? "ACCEPT" as const : "REPAIR" as const;
    if (predictedDecision === "ACCEPT") acceptedCaseCount += 1;
    if (predictedDecision === candidate.expectedDecision) correctDecisions += 1;
    for (const expectedFailure of candidate.expectedFailureCodes) {
      expectedViolations += 1;
      if (failures.has(expectedFailure)) detectedViolations += 1;
    }
    return {
      caseId: candidate.caseId,
      predictedDecision,
      expectedDecision: candidate.expectedDecision,
      detectedFailureCodes: [...failures].sort(),
    };
  });
  const expectationAccuracy = correctDecisions / cases.length;
  const violationDetectionRate = expectedViolations === 0 ? 1 : detectedViolations / expectedViolations;
  return {
    fixtureId: source.fixtureId,
    caseCount: cases.length,
    acceptedCaseCount,
    repairCaseCount: cases.length - acceptedCaseCount,
    expectationAccuracy,
    violationDetectionRate,
    passesExpectedRanges:
      within(expectationAccuracy, expectedMetrics.expectationAccuracy) &&
      within(violationDetectionRate, expectedMetrics.violationDetectionRate),
    cases,
  };
}
