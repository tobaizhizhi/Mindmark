import {
  ReviewPlanSchema,
  buildProjectDeckCommitmentV2,
  hashInitialPlan,
  type ReviewPlan,
} from "@mindmark/shared";
import type { ProjectCommitmentRepositoryV2, ProjectRegistryGatewayV2 } from "./types-v2.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Project Finalizer failure";
}

function buildInitialPlan(cardIds: `0x${string}`[], generatedAt: string): ReviewPlan {
  const days = Array.from({ length: 7 }, (_, dayOffset) => ({
    dayOffset,
    newCardIds: cardIds.slice(dayOffset * 8, dayOffset * 8 + 8),
    reviewCardIds: [],
  }));
  return ReviewPlanSchema.parse({ version: 1, generatedAt, days });
}

export class ProjectFinalizerV2 {
  constructor(
    private readonly repository: ProjectCommitmentRepositoryV2,
    private readonly registry: ProjectRegistryGatewayV2,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runClaimed(projectId: `0x${string}`): Promise<void> {
    try {
      const bundle = await this.repository.getProjectBundle(projectId);
      if (bundle.chapters.length === 0 || bundle.chapters.some((chapter) => chapter.status !== "READY" || !chapter.cardsRoot || chapter.cardCount < 1)) {
        throw new Error("Project cannot finalize until every Chapter is READY");
      }
      const deck = buildProjectDeckCommitmentV2(projectId, bundle.chapters.map((chapter) => ({
        chapterId: chapter.chapterId,
        cardsRoot: chapter.cardsRoot!,
        cardCount: chapter.cardCount,
      })));
      const cards = [...bundle.cards].sort((left, right) =>
        left.chapterId - right.chapterId || left.position - right.position,
      );
      if (cards.length < 1 || cards.length > 200) throw new Error("Project card count is outside V2 limits");
      const plan = bundle.project.initialPlan ?? buildInitialPlan(
        cards.map((card) => card.id),
        this.now().toISOString(),
      );
      const planHash = hashInitialPlan(plan);
      if (
        bundle.project.initialPlan &&
        (bundle.project.projectDeckRoot !== deck.root ||
          bundle.project.initialPlanHash !== planHash ||
          bundle.project.totalCardCount !== cards.length)
      ) {
        throw new Error("Persisted Project finalization no longer matches READY Chapters");
      }
      if (!bundle.project.initialPlan) {
        await this.repository.saveProjectFinalization({
          projectId,
          projectDeckRoot: deck.root,
          initialPlan: plan,
          initialPlanHash: planHash,
          totalCardCount: cards.length,
        });
      }
      const onChain = await this.registry.readProject(projectId);
      let txHash = null;
      if (onChain?.status === "READY") {
        if (
          onChain.projectDeckRoot !== deck.root ||
          onChain.initialPlanHash !== planHash ||
          onChain.totalCardCount !== cards.length
        ) throw new Error("Existing Monad Project finalization does not match persisted Chapters");
      } else {
        const receipt = await this.registry.finalizeProject({
          projectId,
          projectDeckRoot: deck.root,
          initialPlanHash: planHash,
          totalCardCount: cards.length,
        });
        txHash = receipt.txHash;
      }
      await this.repository.markProjectReady({
        projectId,
        projectDeckRoot: deck.root,
        initialPlan: plan,
        initialPlanHash: planHash,
        totalCardCount: cards.length,
        txHash,
      });
      await this.repository.recordProjectAgentEvent({
        projectId,
        role: "project-finalizer",
        type: "PROJECT_READY",
        payload: { cardCount: cards.length, chapterCount: bundle.chapters.length },
        ...(txHash ? { txHash } : {}),
      });
    } catch (error) {
      await this.repository.markProjectRetryable(projectId, messageOf(error));
      throw error;
    }
  }
}
