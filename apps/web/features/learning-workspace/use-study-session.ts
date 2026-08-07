"use client";

import { useRef, useState } from "react";
import type { ChapterStudyCard, ProjectStudyCard } from "@mindmark/shared/study";
import type { SubmitReviewResponse } from "@mindmark/shared";
import {
  createPersistedReviewSessionIds,
  createSerialTaskQueue,
  MAX_CARDS_PER_PERSISTED_REVIEW_SESSION,
  persistedReviewSessionIdForCard,
} from "@/lib/client/serial-task-queue";
import { parseApiResponse as parseApi } from "@/lib/client/http";

export type StudyCard = ChapterStudyCard | ProjectStudyCard;
export type StudyScope = "project" | "chapter";
export type StudyRating = "again" | "hard" | "good" | "easy";

export function useStudySession(input: {
  projectId: `0x${string}` | null;
  chapterId: number | null;
  onError: (message: string | null) => void;
  onComplete: () => void;
}) {
  const [active, setActive] = useState(false);
  const [scope, setScope] = useState<StudyScope | null>(null);
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [index, setIndex] = useState(0);
  const [answerVisible, setAnswerVisible] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const sessionIds = useRef<string[]>([]);
  const shownAt = useRef(0);
  const reviewWrites = useRef(createSerialTaskQueue());
  const currentCard = cards[index] ?? null;

  function start(nextScope: StudyScope, nextCards: StudyCard[]) {
    if (nextCards.length === 0) return;
    sessionIds.current = createPersistedReviewSessionIds(nextCards.length, () => crypto.randomUUID());
    reviewWrites.current = createSerialTaskQueue();
    shownAt.current = Date.now();
    setIndex(0);
    setAnswerVisible(false);
    setRatingBusy(false);
    setDone(false);
    setFinishing(false);
    setCards(nextCards);
    setScope(nextScope);
    setActive(true);
  }

  function exit() {
    setActive(false);
    setScope(null);
  }

  async function rate(rating: StudyRating) {
    if (!input.projectId || !currentCard || !scope || sessionIds.current.length === 0) return;
    const ratedCard = currentCard;
    const activeSessionId = persistedReviewSessionIdForCard(sessionIds.current, index);
    const completesPersistedSession = (index + 1) % MAX_CARDS_PER_PERSISTED_REVIEW_SESSION === 0
      || index + 1 === cards.length;
    const ratedChapterId = scope === "project" && "chapterId" in ratedCard
      ? ratedCard.chapterId
      : input.chapterId;
    if (ratedChapterId === null) return;
    const responseMs = Math.min(3_600_000, Date.now() - shownAt.current);
    const reviewedAt = new Date().toISOString();
    setRatingBusy(true);
    input.onError(null);
    const persistence = reviewWrites.current.enqueue(async () => {
      await parseApi<SubmitReviewResponse>(await fetch(
        `/api/projects/${input.projectId}/chapters/${ratedChapterId}/reviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: activeSessionId,
            cardId: ratedCard.id,
            rating,
            responseMs,
            reviewedAt,
            scope: scope === "project" ? "PROJECT" : "CHAPTER",
          }),
        },
      ));
      if (completesPersistedSession) {
        await parseApi(await fetch(`/api/projects/${input.projectId}/sessions/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: activeSessionId }),
        }));
      }
    });

    if (index + 1 < cards.length) {
      setIndex((value) => value + 1);
      setAnswerVisible(false);
      shownAt.current = Date.now();
      setRatingBusy(false);
      void persistence.catch((error: unknown) => {
        input.onError(error instanceof Error ? `上一张卡评分保存失败：${error.message}` : "上一张卡评分保存失败");
      });
      return;
    }

    setDone(true);
    setFinishing(true);
    try {
      await persistence;
      await reviewWrites.current.onIdle();
      setFinishing(false);
      input.onComplete();
    } catch (error) {
      setDone(false);
      setFinishing(false);
      input.onError(error instanceof Error ? error.message : "评分保存失败");
    } finally {
      setRatingBusy(false);
    }
  }

  return {
    active,
    scope,
    cards,
    currentCard,
    index,
    answerVisible,
    ratingBusy,
    done,
    finishing,
    start,
    exit,
    reveal: () => setAnswerVisible(true),
    rate,
  };
}
