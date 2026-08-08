import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findDuplicateCandidates,
  evaluateCardRubric,
  hashKnowledgeCard,
  intakeSource,
  QualityCorpusCandidateCasesSchema,
  validateCitation,
  type CardBlueprintSlot,
  type QualityCorpusFixture,
  type WorkerKnowledgeCardV2,
} from "../packages/shared/src/index.ts";
import { OpenAICompatibleToolModel } from "../apps/agent-runner/src/model.ts";
import { ModelCardQualityEvaluatorV3 } from "../apps/agent-runner/src/quality-evaluator-v3.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = path.join(root, "fixtures", "ai-quality");
const liveProjectId = `0x${"ab".repeat(32)}` as const;

type LiveConfiguration = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fallback?: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokensParameter: "max_tokens";
    providerOptions: { thinking: { type: "disabled" } };
  };
  timeoutMs: number;
  minimumAccuracy: number;
  minimumViolationDetection: number;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for quality:evaluator-live`);
  return value;
}

function boundedNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return parsed;
}

function timeoutMs(): number {
  const value = process.env.AI_TOOL_TIMEOUT_MS;
  if (!value) return 120_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 45_000 || parsed > 600_000) {
    throw new Error("AI_TOOL_TIMEOUT_MS must be an integer between 45000 and 600000");
  }
  return parsed;
}

function configuration(): LiveConfiguration {
  const baseUrl = process.env.AI_EVALUATION_BASE_URL?.trim() ?? process.env.AI_BASE_URL?.trim();
  if (baseUrl) new URL(baseUrl);
  const fallbackApiKey = process.env.AI_FALLBACK_API_KEY?.trim();
  const fallbackBaseUrl = process.env.AI_FALLBACK_BASE_URL?.trim() ?? "https://api.deepseek.com/v1";
  if (fallbackApiKey) new URL(fallbackBaseUrl);
  return {
    apiKey: process.env.AI_EVALUATION_API_KEY?.trim() ?? requiredEnvironment("AI_API_KEY"),
    model: process.env.AI_EVALUATION_MODEL?.trim() ?? requiredEnvironment("AI_MODEL"),
    ...(baseUrl ? { baseUrl } : {}),
    ...(fallbackApiKey ? {
      fallback: {
        apiKey: fallbackApiKey,
        model: process.env.AI_FALLBACK_MODEL?.trim() ?? "deepseek-chat",
        baseUrl: fallbackBaseUrl,
        maxTokensParameter: "max_tokens" as const,
        providerOptions: { thinking: { type: "disabled" } },
      },
    } : {}),
    timeoutMs: timeoutMs(),
    minimumAccuracy: boundedNumber("QUALITY_LIVE_MIN_ACCURACY", 0.9),
    minimumViolationDetection: boundedNumber("QUALITY_LIVE_MIN_VIOLATION_DETECTION", 0.9),
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function loadFixture(name: string): Promise<QualityCorpusFixture> {
  const directory = path.join(corpusRoot, name);
  const [source, expectedInventory, blueprintRequirements, candidateCases, expectedMetrics] = await Promise.all([
    readJson(path.join(directory, "source.json")),
    readJson(path.join(directory, "expected-inventory.json")),
    readJson(path.join(directory, "blueprint-requirements.json")),
    readJson(path.join(directory, "candidate-cases.json")),
    readJson(path.join(directory, "expected-metrics.json")),
  ]);
  return {
    source: source as QualityCorpusFixture["source"],
    expectedInventory: expectedInventory as QualityCorpusFixture["expectedInventory"],
    blueprintRequirements: blueprintRequirements as QualityCorpusFixture["blueprintRequirements"],
    candidateCases: candidateCases as QualityCorpusFixture["candidateCases"],
    expectedMetrics: expectedMetrics as QualityCorpusFixture["expectedMetrics"],
  };
}

function cardAndSlot(input: {
  fixture: QualityCorpusFixture;
  content: QualityCorpusFixture["candidateCases"]["cases"][number]["content"];
  rubricCardId: `0x${string}`;
  slot: QualityCorpusFixture["candidateCases"]["cases"][number]["slot"];
}) {
  const sourceBlocks = intakeSource(input.fixture.source.pages).blocks;
  const evidenceBlocks = sourceBlocks.filter((block) => input.slot.evidenceBlockIndexes.includes(block.blockIndex));
  if (evidenceBlocks.length !== input.slot.evidenceBlockIndexes.length) {
    throw new Error(`Fixture ${input.fixture.source.fixtureId} has a missing Slot evidence block`);
  }
  const card: WorkerKnowledgeCardV2 = {
    ...input.content,
    id: input.rubricCardId,
    cardHash: hashKnowledgeCard(input.content),
    projectId: liveProjectId,
    chapterId: 0,
    workUnitId: 0,
    workerProof: [],
  };
  const slot: CardBlueprintSlot = {
    slotId: input.rubricCardId,
    conceptId: input.rubricCardId,
    type: input.slot.type,
    objective: input.slot.objective,
    difficulty: input.slot.difficulty,
    sourceBlockIndexes: input.slot.evidenceBlockIndexes,
    required: true,
  };
  return { card, slot, evidenceBlocks };
}

async function main(): Promise<void> {
  const live = configuration();
  const fixtureNames = (await readdir(corpusRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const model = new OpenAICompatibleToolModel({
    apiKey: live.apiKey,
    model: live.model,
    ...(live.baseUrl ? { baseUrl: live.baseUrl } : {}),
    ...(live.fallback ? { fallback: live.fallback } : {}),
  });
  const evaluator = new ModelCardQualityEvaluatorV3(model, {
    modelId: live.model,
    promptVersion: "card-rubric-v3-live-corpus-1",
    timeoutMs: live.timeoutMs,
  });
  const reports = [] as Array<{
    fixtureId: string;
    cases: Array<{
      caseId: string;
      expectedDecision: "ACCEPT" | "REPAIR";
      predictedDecision: "ACCEPT" | "REPAIR";
      expectedFailureCodes: string[];
      detectedFailureCodes: string[];
    }>;
  }>;

  for (const name of fixtureNames) {
    const fixture = await loadFixture(name);
    const candidates = QualityCorpusCandidateCasesSchema.parse(fixture.candidateCases);
    const duplicateVictims = new Set(findDuplicateCandidates(candidates.cases.map((candidate) => ({
      candidateId: candidate.rubric.cardId,
      question: candidate.content.question,
      keyPoint: candidate.content.keyPoint,
      ...(candidate.embedding ? { embedding: candidate.embedding } : {}),
    }))).map((pair) => pair.rightCandidateId));
    const cases = [] as typeof reports[number]["cases"];

    for (const candidate of candidates.cases) {
      const { card, slot, evidenceBlocks } = cardAndSlot({
        fixture,
        content: candidate.content,
        rubricCardId: candidate.rubric.cardId,
        slot: candidate.slot,
      });
      const evaluation = await evaluator.evaluate({
        conceptName: candidate.slot.conceptName,
        slot,
        card,
        evidenceBlocks,
      });
      const failures = new Set<string>(evaluateCardRubric({ evaluation }).failures);
      if (!validateCitation(candidate.content, fixture.source.pages).valid) failures.add("CITATION_INVALID");
      if (duplicateVictims.has(candidate.rubric.cardId)) failures.add("DUPLICATE_CANDIDATE");
      const predictedDecision = failures.size === 0 ? "ACCEPT" as const : "REPAIR" as const;
      cases.push({
        caseId: candidate.caseId,
        expectedDecision: candidate.expectedDecision,
        predictedDecision,
        expectedFailureCodes: candidate.expectedFailureCodes,
        detectedFailureCodes: [...failures].sort(),
      });
    }
    reports.push({ fixtureId: fixture.source.fixtureId, cases });
  }

  const cases = reports.flatMap((report) => report.cases);
  const expectedViolations = cases.flatMap((item) => item.expectedFailureCodes);
  const detectedViolations = cases.reduce(
    (total, item) => total + item.expectedFailureCodes.filter((code) => item.detectedFailureCodes.includes(code)).length,
    0,
  );
  const expectationAccuracy = cases.filter((item) => item.predictedDecision === item.expectedDecision).length / cases.length;
  const violationDetectionRate = expectedViolations.length === 0 ? 1 : detectedViolations / expectedViolations.length;
  const report = {
    model: live.model,
    fixtureCount: reports.length,
    totalCases: cases.length,
    expectationAccuracy,
    violationDetectionRate,
    thresholds: {
      minimumAccuracy: live.minimumAccuracy,
      minimumViolationDetection: live.minimumViolationDetection,
    },
    fixtures: reports,
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    expectationAccuracy < live.minimumAccuracy ||
    violationDetectionRate < live.minimumViolationDetection
  ) process.exitCode = 1;
}

void main();
