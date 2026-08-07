import {
  KnowledgeCardV2Schema,
  buildCardTree,
  normalizeSourceText,
  type KnowledgeCardV2,
} from "@mindmark/shared";
import { getAddress } from "viem";
import type { ChapterCommitmentRepositoryV2, ProjectRegistryGatewayV2 } from "./types-v2.js";
import { verifyCommittedCardsV2 } from "./validation-v2.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Chapter Assembler failure";
}

export class ChapterAssembler {
  constructor(
    private readonly repository: ChapterCommitmentRepositoryV2,
    private readonly registry: ProjectRegistryGatewayV2,
  ) {}

  async runClaimed(claimed: { projectId: `0x${string}`; chapterId: number }): Promise<void> {
    try {
      const bundle = await this.repository.getChapterBundle(claimed.projectId, claimed.chapterId);
      const candidates = [];
      for (const unit of bundle.workUnits) {
        if (unit.status !== "CONFIRMED" || !unit.cardsRoot || !unit.cardCount || !unit.workerAddress) {
          throw new Error(`Work Unit ${unit.workUnitId} is not ready for Chapter assembly`);
        }
        const chain = await this.registry.readWorkUnit(unit.projectId, unit.workUnitId);
        const allowedWorkers = [0, 1, 2].map((index) => getAddress(this.registry.workerAddress(index)));
        if (
          !chain ||
          chain.chapterId !== unit.chapterId ||
          chain.sourceUnitHash !== unit.sourceUnitHash ||
          chain.cardsRoot !== unit.cardsRoot ||
          chain.cardCount !== unit.cardCount ||
          getAddress(chain.worker) !== getAddress(unit.workerAddress) ||
          !allowedWorkers.includes(getAddress(chain.worker)) ||
          !verifyCommittedCardsV2({
            projectId: unit.projectId,
            chapterId: unit.chapterId,
            workUnitId: unit.workUnitId,
            cards: unit.workerCards,
            expectedRoot: unit.cardsRoot,
          })
        ) {
          throw new Error(`Work Unit ${unit.workUnitId} does not match its Monad commitment`);
        }
        candidates.push(...unit.workerCards);
      }

      const seen = new Set<string>();
      const selected = candidates.filter((card) => {
        const key = `${normalizeSourceText(card.question).toLowerCase()}|${normalizeSourceText(card.keyPoint).toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 30);
      if (selected.length < bundle.chapter.minCardCount) {
        throw new Error(
          `Chapter has ${selected.length} unique cards but the minimum is ${bundle.chapter.minCardCount}`,
        );
      }
      const tree = buildCardTree(selected.map((card) => card.id));
      const cards: KnowledgeCardV2[] = selected.map((card, position) => {
        const proof = tree.cards.find((candidate) => candidate.cardId === card.id)?.proof;
        if (!proof) throw new Error("Chapter card proof was not generated");
        return KnowledgeCardV2Schema.parse({ ...card, position, chapterProof: proof });
      });
      await this.repository.saveChapterAssembly(claimed.projectId, claimed.chapterId, {
        cards,
        cardsRoot: tree.root,
      });

      const onChain = await this.registry.readChapter(claimed.projectId, claimed.chapterId);
      let txHash = null;
      if (onChain?.status === "READY") {
        if (onChain.cardsRoot !== tree.root || onChain.cardCount !== cards.length) {
          throw new Error("Existing Monad Chapter finalization does not match assembled cards");
        }
      } else {
        const receipt = await this.registry.finalizeChapter({
          projectId: claimed.projectId,
          chapterId: claimed.chapterId,
          cardsRoot: tree.root,
          cardCount: cards.length,
        });
        txHash = receipt.txHash;
      }
      await this.repository.markChapterReady(claimed.projectId, claimed.chapterId, txHash);
      await this.repository.recordProjectAgentEvent({
        projectId: claimed.projectId,
        chapterId: claimed.chapterId,
        role: "chapter-assembler",
        type: "CHAPTER_READY",
        payload: { cardCount: cards.length, duplicateCount: candidates.length - cards.length },
        ...(txHash ? { txHash } : {}),
      });
    } catch (error) {
      await this.repository.markChapterRetryable(claimed.projectId, claimed.chapterId, messageOf(error));
      throw error;
    }
  }
}
