import {
  DEFAULT_GENERATION_POLICY_V3,
  GenerationPolicyV3Schema,
  evaluateBlueprintCoverage,
  evaluateCardRubric,
  findDuplicateCandidates,
  normalizeSourceText,
  type GenerationPolicyV3,
} from "@mindmark/shared";
import { DeterministicCardEmbeddingGatewayV3, type CardEmbeddingGatewayV3 } from "./embedding-v3.js";
import {
  DeterministicCardQualityEvaluatorV3,
  type CardQualityEvaluatorV3,
} from "./quality-evaluator-v3.js";
import { expandBlueprintSlotEvidence } from "./blueprint-evidence.js";
import type {
  BlueprintQualityDecisionV3,
  BlueprintQualityRepositoryV3,
  BlueprintSlotCandidateV3,
  ChapterQualityRepositoryV2,
} from "./types-v2.js";
import { freezeWorkerCandidatesV2, verifyCommittedCardsV2 } from "./validation-v2.js";

class ChapterRepairRequestedError extends Error {}

function duplicateKey(card: { question: string; keyPoint: string }): string {
  return `${normalizeSourceText(card.question).toLowerCase()}|${normalizeSourceText(card.keyPoint).toLowerCase()}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Chapter quality failure";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

export class ChapterQualityGate {
  private readonly policy: GenerationPolicyV3;

  constructor(
    private readonly repository: ChapterQualityRepositoryV2,
    private readonly embeddings: CardEmbeddingGatewayV3 = new DeterministicCardEmbeddingGatewayV3(),
    private readonly qualityEvaluator: CardQualityEvaluatorV3 = new DeterministicCardQualityEvaluatorV3(),
    policy: GenerationPolicyV3 = DEFAULT_GENERATION_POLICY_V3,
  ) {
    this.policy = GenerationPolicyV3Schema.parse(policy);
  }

  async runClaimed(claimed: { projectId: `0x${string}`; chapterId: number }): Promise<"APPROVED" | "REPAIR_REQUESTED"> {
    try {
      const bundle = await this.repository.getChapterBundle(claimed.projectId, claimed.chapterId);
      if (bundle.project.generationPolicyVersion === 3) {
        return await this.runBlueprintQualityGate(claimed, bundle);
      }
      const candidates = [];
      for (const unit of bundle.workUnits) {
        if (
          unit.status !== "CANDIDATE_READY" ||
          !unit.cardsRoot ||
          unit.cardCount !== unit.workerCards.length ||
          !verifyCommittedCardsV2({
            projectId: unit.projectId,
            chapterId: unit.chapterId,
            workUnitId: unit.workUnitId,
            cards: unit.workerCards,
            expectedRoot: unit.cardsRoot,
          })
        ) {
          throw new Error(`Work Unit ${unit.workUnitId} candidates are not ready for Chapter quality review`);
        }
        candidates.push(...unit.workerCards);
      }

      const seen = new Set<string>();
      const selected = candidates.filter((card) => {
        const key = duplicateKey(card);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, bundle.chapter.maxCardCount);

      if (selected.length < bundle.chapter.minCardCount) {
        const message =
          `Chapter has ${selected.length} unique cards after cross-Work-Unit deduplication, ` +
          `but the minimum is ${bundle.chapter.minCardCount}`;
        await this.requestRepair(claimed.projectId, claimed.chapterId, message, candidates.length - selected.length);
        throw new ChapterRepairRequestedError(message);
      }

      const approvedWorkUnits = [];
      for (const unit of bundle.workUnits) {
        const cards = selected.filter((card) => card.workUnitId === unit.workUnitId);
        if (cards.length === 0) {
          const message = `Work Unit ${unit.workUnitId} has no unique cards after Chapter deduplication`;
          await this.requestRepair(
            claimed.projectId,
            claimed.chapterId,
            message,
            candidates.length - selected.length,
          );
          throw new ChapterRepairRequestedError(message);
        }
        approvedWorkUnits.push({ workUnitId: unit.workUnitId, ...freezeWorkerCandidatesV2(cards) });
      }
      await this.repository.approveChapterCandidates(
        claimed.projectId,
        claimed.chapterId,
        approvedWorkUnits,
      );
      await this.repository.recordProjectAgentEvent({
        projectId: claimed.projectId,
        chapterId: claimed.chapterId,
        role: "chapter-quality-gate",
        type: "CHAPTER_CANDIDATES_APPROVED",
        payload: {
          candidateCount: candidates.length,
          approvedCount: selected.length,
          duplicateCount: candidates.length - selected.length,
        },
      });
      return "APPROVED";
    } catch (error) {
      if (!(error instanceof ChapterRepairRequestedError)) {
        await this.repository.markChapterRetryable(
          claimed.projectId,
          claimed.chapterId,
          messageOf(error),
        );
        throw error;
      }
      return "REPAIR_REQUESTED";
    }
  }

  private async runBlueprintQualityGate(
    claimed: { projectId: `0x${string}`; chapterId: number },
    bundle: Awaited<ReturnType<ChapterQualityRepositoryV2["getChapterBundle"]>>,
  ): Promise<"APPROVED" | "REPAIR_REQUESTED"> {
    const repository = this.repository as ChapterQualityRepositoryV2 & Partial<BlueprintQualityRepositoryV3>;
    if (
      !repository.getChapterBlueprintQualityContext ||
      !repository.approveChapterBlueprintCandidates ||
      !repository.requestChapterBlueprintRepairs
    ) throw new Error("V3 Chapter repository does not support Blueprint quality evaluation");

    const context = await repository.getChapterBlueprintQualityContext(claimed.projectId, claimed.chapterId);
    const slotCount = context.blueprint.slots.length;
    if (slotCount < bundle.chapter.minCardCount) {
      throw new Error(
        `Frozen V3 Blueprint has ${slotCount} Slots but Chapter minimum is ${bundle.chapter.minCardCount}`,
      );
    }
    if (slotCount > bundle.chapter.maxCardCount) {
      throw new Error(
        `Frozen V3 Blueprint has ${slotCount} Slots but Chapter maximum is ${bundle.chapter.maxCardCount}`,
      );
    }
    const currentCards = new Set<string>();
    for (const unit of bundle.workUnits) {
      if (
        unit.status !== "CANDIDATE_READY" ||
        !unit.cardsRoot ||
        unit.cardCount !== unit.workerCards.length ||
        !verifyCommittedCardsV2({
          projectId: unit.projectId,
          chapterId: unit.chapterId,
          workUnitId: unit.workUnitId,
          cards: unit.workerCards,
          expectedRoot: unit.cardsRoot,
        })
      ) throw new Error(`Work Unit ${unit.workUnitId} candidates are not ready for V3 Chapter quality review`);
      unit.workerCards.forEach((card) => currentCards.add(card.id));
    }

    const latestBySlot = new Map<string, BlueprintSlotCandidateV3>();
    for (const candidate of context.candidates) {
      const current = latestBySlot.get(candidate.slotId);
      if (!current || candidate.candidateRevision > current.candidateRevision) {
        latestBySlot.set(candidate.slotId, candidate);
      }
    }
    const reviewCandidates = context.blueprint.slots
      .map((slot) => latestBySlot.get(slot.slotId))
      .filter((candidate): candidate is BlueprintSlotCandidateV3 => Boolean(candidate));
    const pendingCandidates = reviewCandidates.filter((candidate) => candidate.status === "CANDIDATE_READY");
    if (pendingCandidates.some((candidate) => !currentCards.has(candidate.card.id))) {
      throw new Error("Latest V3 Slot candidates do not match the validating Work Unit revision");
    }

    const sourceBlocks = bundle.workUnits.flatMap((unit) => unit.sourceBlocks ?? []);
    const deterministicQualityFallback = new DeterministicCardQualityEvaluatorV3();
    let qualityFallbackUsed = false;
    const pendingRubricResults = await mapWithConcurrency(pendingCandidates, 1, async (candidate) => {
      const frozenSlot = context.blueprint.slots.find((candidateSlot) => candidateSlot.slotId === candidate.slotId);
      if (!frozenSlot) throw new Error(`V3 candidate ${candidate.card.id} references an unknown Blueprint Slot`);
      const slot = expandBlueprintSlotEvidence(frozenSlot, sourceBlocks);
      const concept = context.inventory.concepts.find((item) => item.conceptId === slot.conceptId);
      if (!concept) throw new Error(`V3 Blueprint Slot ${slot.slotId} references an unknown Concept`);
      const evaluationInput = {
        conceptName: concept.name,
        slot,
        card: candidate.card,
        evidenceBlocks: sourceBlocks.filter((block) => slot.sourceBlockIndexes.includes(block.blockIndex)),
      };
      const rubric = await this.qualityEvaluator.evaluate(evaluationInput).catch(async () => {
        qualityFallbackUsed = true;
        return deterministicQualityFallback.evaluate(evaluationInput);
      });
      return { candidate, rubric, result: evaluateCardRubric({ evaluation: rubric, policy: this.policy }) };
    });
    const acceptedRubricResults = reviewCandidates
      .filter((candidate) => candidate.status === "ACCEPTED")
      .map((candidate) => {
        if (!candidate.acceptedEvaluation) {
          throw new Error(`Accepted V3 Slot ${candidate.slotId} has no persisted Rubric evaluation`);
        }
        return {
          candidate,
          rubric: candidate.acceptedEvaluation,
          result: { passes: true, failures: [], minimumScore: 0 },
        };
      });
    const rubricResults = [...acceptedRubricResults, ...pendingRubricResults];
    const rubricByCardId = new Map(rubricResults.map((item) => [item.candidate.card.id, item]));
    const rubricRepairCardIds = new Set(
      rubricResults.filter((item) => !item.result.passes).map((item) => item.candidate.card.id),
    );
    const repairReasonsBySlot = new Map<string, string>();
    for (const item of rubricResults.filter((item) => !item.result.passes)) {
      const reasons = item.rubric.reasons.length > 0
        ? item.rubric.reasons
        : item.result.failures;
      repairReasonsBySlot.set(
        item.candidate.slotId,
        `Replace the rejected card and fix: ${reasons.join("; ")}`.slice(0, 500),
      );
    }
    const dedupCandidates = reviewCandidates.filter((candidate) => !rubricRepairCardIds.has(candidate.card.id));
    const embeddingInputs = dedupCandidates.map(
      (candidate) => `${candidate.card.question}\n${candidate.card.keyPoint}`,
    );
    let embeddingModel = this.embeddings.modelId;
    const vectors = await this.embeddings.embed(embeddingInputs).catch(async () => {
      const fallback = new DeterministicCardEmbeddingGatewayV3();
      embeddingModel = fallback.modelId;
      return fallback.embed(embeddingInputs);
    });
    if (vectors.length !== dedupCandidates.length) {
      throw new Error("Embedding gateway returned the wrong number of vectors");
    }
    const duplicates = findDuplicateCandidates(
      dedupCandidates.map((candidate, index) => ({
        candidateId: candidate.card.id,
        question: candidate.card.question,
        keyPoint: candidate.card.keyPoint,
        embedding: vectors[index],
      })),
      this.policy.semanticDuplicateThreshold,
    );
    const candidatesByCardId = new Map<string, BlueprintSlotCandidateV3>(
      reviewCandidates.map((candidate) => [candidate.card.id, candidate]),
    );
    const repairCardIds = new Set<string>(rubricRepairCardIds);
    const duplicateCardIds = new Set<string>();
    const actionableDuplicates = duplicates.filter((pair) => {
      const left = candidatesByCardId.get(pair.leftCandidateId);
      const right = candidatesByCardId.get(pair.rightCandidateId);
      return left?.status === "CANDIDATE_READY" || right?.status === "CANDIDATE_READY";
    });
    actionableDuplicates.forEach((pair) => {
      const left = candidatesByCardId.get(pair.leftCandidateId)!;
      const right = candidatesByCardId.get(pair.rightCandidateId)!;
      const repairCardId = left.status === "CANDIDATE_READY" && right.status === "ACCEPTED"
        ? pair.leftCandidateId
        : pair.rightCandidateId;
      repairCardIds.add(repairCardId);
      duplicateCardIds.add(repairCardId);
      const repairCandidate = candidatesByCardId.get(repairCardId);
      if (repairCandidate) {
        repairReasonsBySlot.set(
          repairCandidate.slotId,
          `Replace the rejected card with a distinct assessment target; it overlaps another candidate (${pair.reason.toLowerCase()}, similarity ${pair.similarity.toFixed(2)}).`,
        );
      }
    });
    const provisionallyAccepted = reviewCandidates.filter(
      (candidate) => !repairCardIds.has(candidate.card.id),
    );
    const coverage = evaluateBlueprintCoverage({
      inventory: context.inventory,
      blueprint: context.blueprint,
      acceptedSlotIds: provisionallyAccepted.map((candidate) => candidate.slotId),
      policy: this.policy,
    });
    const missingCandidateSlotIds = context.blueprint.slots
      .filter((slot) => slot.required && !latestBySlot.has(slot.slotId))
      .map((slot) => slot.slotId);
    const repairSlotIds = new Set([
      ...missingCandidateSlotIds,
      ...coverage.missingRequiredSlotIds,
      ...reviewCandidates
        .filter((candidate) => repairCardIds.has(candidate.card.id))
        .map((candidate) => candidate.slotId),
    ]);
    for (const slotId of missingCandidateSlotIds) {
      repairReasonsBySlot.set(slotId, "Generate the missing required Slot with a self-contained, cited card.");
    }
    for (const slotId of coverage.missingRequiredSlotIds) {
      if (!repairReasonsBySlot.has(slotId)) {
        repairReasonsBySlot.set(slotId, "Generate this required Slot so the Chapter meets its Blueprint coverage contract.");
      }
    }
    const duplicateRate = reviewCandidates.length === 0 ? 0 : duplicateCardIds.size / reviewCandidates.length;
    const countPasses = provisionallyAccepted.length >= bundle.chapter.minCardCount &&
      provisionallyAccepted.length <= bundle.chapter.maxCardCount;
    const passes = coverage.passes && countPasses && missingCandidateSlotIds.length === 0 &&
      repairCardIds.size === 0 &&
      duplicateRate <= this.policy.semanticDuplicateMaximum &&
      !actionableDuplicates.some((pair) => pair.reason === "EXACT_NORMALIZED");
    const evaluations = reviewCandidates.map((candidate) => {
      const needsRepair = repairSlotIds.has(candidate.slotId);
      const rubric = rubricByCardId.get(candidate.card.id);
      if (!rubric) throw new Error(`V3 candidate ${candidate.card.id} has no Rubric evaluation`);
      const duplicateFailure = duplicateCardIds.has(candidate.card.id) && rubric.result.passes
        ? ["DUPLICATE_CANDIDATE"]
        : [];
      return {
        slotId: candidate.slotId,
        cardId: candidate.card.id,
        candidateRevision: candidate.candidateRevision,
        verdict: needsRepair ? "REPAIR_REQUESTED" as const : "APPROVED" as const,
        hardFailures: needsRepair ? [...rubric.result.failures, ...duplicateFailure] : [],
        rubric: rubric.rubric,
      };
    });
    const decision: BlueprintQualityDecisionV3 = {
      projectId: claimed.projectId,
      chapterId: claimed.chapterId,
      designRunId: context.designRunId,
      evaluations,
      coverageResult: {
        ...coverage,
        duplicateRate,
        countPasses,
        embeddingModel,
        policySnapshot: this.policy,
      },
      duplicatePairs: duplicates,
      evaluatorModel: (qualityFallbackUsed
        ? `${this.qualityEvaluator.modelId}+${deterministicQualityFallback.modelId}`
        : this.qualityEvaluator.modelId).slice(0, 200),
      promptVersion: qualityFallbackUsed
        ? deterministicQualityFallback.promptVersion
        : this.qualityEvaluator.promptVersion,
    };

    if (!passes) {
      const fallbackSlotIds = repairSlotIds.size > 0
        ? [...repairSlotIds]
        : context.blueprint.slots
            .filter((slot) => slot.required && latestBySlot.get(slot.slotId)?.status !== "ACCEPTED")
            .map((slot) => slot.slotId);
      if (fallbackSlotIds.length === 0) {
        throw new Error("V3 Chapter quality failed without any repairable Blueprint Slots");
      }
      const reason = !countPasses
        ? `V3 Chapter has ${provisionallyAccepted.length} accepted cards outside ${bundle.chapter.minCardCount}-${bundle.chapter.maxCardCount}`
        : "V3 Chapter Blueprint coverage or duplicate policy failed";
      for (const slotId of fallbackSlotIds) {
        if (!repairReasonsBySlot.has(slotId)) repairReasonsBySlot.set(slotId, reason);
      }
      await repository.requestChapterBlueprintRepairs({
        ...decision,
        repairs: fallbackSlotIds.map((slotId) => ({
          slotId,
          reason: repairReasonsBySlot.get(slotId)!,
        })),
      });
      await this.repository.recordProjectAgentEvent({
        projectId: claimed.projectId,
        chapterId: claimed.chapterId,
        role: "chapter-quality-gate",
        type: "CHAPTER_REPAIR_REQUESTED",
        payload: {
          policyVersion: 3,
          repairSlotIds: fallbackSlotIds.join(","),
          duplicateCount: duplicates.length,
          rubricFailureCount: rubricRepairCardIds.size,
          reason,
        },
      });
      return "REPAIR_REQUESTED";
    }

    const approvedWorkUnits = bundle.workUnits.map((unit) => {
      const cards = provisionallyAccepted
        .filter((candidate) => candidate.workUnitId === unit.workUnitId)
        .map((candidate) => candidate.card);
      if (cards.length === 0) throw new Error(`V3 Work Unit ${unit.workUnitId} has no accepted Blueprint candidates`);
      return { workUnitId: unit.workUnitId, ...freezeWorkerCandidatesV2(cards) };
    });
    await repository.approveChapterBlueprintCandidates({ ...decision, workUnits: approvedWorkUnits });
    await this.repository.recordProjectAgentEvent({
      projectId: claimed.projectId,
      chapterId: claimed.chapterId,
      role: "chapter-quality-gate",
      type: "CHAPTER_CANDIDATES_APPROVED",
      payload: {
        policyVersion: 3,
        candidateCount: reviewCandidates.length,
        approvedCount: provisionallyAccepted.length,
        duplicateCount: duplicates.length,
        rubricFailureCount: rubricRepairCardIds.size,
        weightedCoverage: coverage.weightedCoverage,
      },
    });
    return "APPROVED";
  }

  private async requestRepair(
    projectId: `0x${string}`,
    chapterId: number,
    message: string,
    duplicateCount: number,
  ): Promise<void> {
    await this.repository.requestChapterCandidateRepair(projectId, chapterId, message);
    await this.repository.recordProjectAgentEvent({
      projectId,
      chapterId,
      role: "chapter-quality-gate",
      type: "CHAPTER_REPAIR_REQUESTED",
      payload: { duplicateCount, reason: message },
    });
  }
}
