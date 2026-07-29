import { normalizeSourceText } from "@mindmark/shared";
import type { ProjectRunnerRepositoryV2 } from "./types-v2.js";
import { freezeWorkerCandidatesV2, verifyCommittedCardsV2 } from "./validation-v2.js";

class ChapterRepairRequestedError extends Error {}

function duplicateKey(card: { question: string; keyPoint: string }): string {
  return `${normalizeSourceText(card.question).toLowerCase()}|${normalizeSourceText(card.keyPoint).toLowerCase()}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Chapter quality failure";
}

export class ChapterQualityGate {
  constructor(private readonly repository: ProjectRunnerRepositoryV2) {}

  async runClaimed(claimed: { projectId: `0x${string}`; chapterId: number }): Promise<"APPROVED" | "REPAIR_REQUESTED"> {
    try {
      const bundle = await this.repository.getChapterBundle(claimed.projectId, claimed.chapterId);
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
