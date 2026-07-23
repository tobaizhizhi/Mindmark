import {
  ReviewPlanSchema,
  type CommittedKnowledgeCard,
  type ReviewPlan,
  type StudyQueue,
} from "@mindmark/shared";
import { ReviewRatingSchema, StudyQueueSchema } from "@mindmark/shared/schemas";
import {
  Rating,
  State,
  createEmptyCard,
  fsrs,
  type Card,
  type CardInput,
} from "ts-fsrs";
import { z } from "zod";

const SerializedFsrsCardSchema = z
  .object({
    due: z.string().datetime({ offset: true }),
    stability: z.number().nonnegative(),
    difficulty: z.number().nonnegative(),
    elapsed_days: z.number().nonnegative(),
    scheduled_days: z.number().nonnegative(),
    learning_steps: z.number().int().nonnegative(),
    reps: z.number().int().nonnegative(),
    lapses: z.number().int().nonnegative(),
    state: z.nativeEnum(State),
    last_review: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export type SerializedFsrsCard = z.infer<typeof SerializedFsrsCardSchema>;
export type FsrsStateMap = Record<string, SerializedFsrsCard>;

const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 36_500,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ["1m", "10m"],
  relearning_steps: ["10m"],
});

const ratingMap = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
} as const;

type ReviewRating = z.infer<typeof ReviewRatingSchema>;

export function parseFsrsStateMap(value: unknown): FsrsStateMap {
  const raw = z.record(z.string(), z.unknown()).parse(value ?? {});
  return Object.fromEntries(
    Object.entries(raw).map(([cardId, state]) => [cardId, SerializedFsrsCardSchema.parse(state)]),
  );
}

function serializeCard(card: Card): SerializedFsrsCard {
  return SerializedFsrsCardSchema.parse({
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review?.toISOString() ?? null,
  });
}

export function scheduleReview(input: {
  currentState: SerializedFsrsCard | null;
  rating: ReviewRating;
  reviewedAt: string;
}): SerializedFsrsCard {
  const reviewedAt = new Date(input.reviewedAt);
  const current: CardInput | Card = input.currentState
    ? { ...input.currentState, last_review: input.currentState.last_review ?? null }
    : createEmptyCard(reviewedAt);
  return serializeCard(scheduler.next(current, reviewedAt, ratingMap[input.rating]).card);
}

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function priority(left: CommittedKnowledgeCard, right: CommittedKnowledgeCard): number {
  return right.importance - left.importance || left.id.localeCompare(right.id);
}

export function buildStudyQueue(input: {
  deck: CommittedKnowledgeCard[];
  fsrsStates: FsrsStateMap;
  plan: ReviewPlan | null;
  now?: Date;
}): StudyQueue {
  const now = input.now ?? new Date();
  const cardsById = new Map(input.deck.map((card) => [card.id, card]));
  const due = input.deck
    .filter((card) => {
      const state = input.fsrsStates[card.id];
      return state ? Date.parse(state.due) <= now.getTime() : false;
    })
    .sort((left, right) => {
      const leftDue = Date.parse(input.fsrsStates[left.id]!.due);
      const rightDue = Date.parse(input.fsrsStates[right.id]!.due);
      return leftDue - rightDue || priority(left, right);
    });
  const queue: Array<{
    reason: "due" | "planned";
    card: CommittedKnowledgeCard;
  }> = due.slice(0, 15).map((card) => ({ reason: "due", card }));

  const unstudied = input.deck
    .filter((card) => !input.fsrsStates[card.id])
    .sort(priority);
  let plannedIds: `0x${string}`[] = [];
  if (input.plan) {
    const generated = new Date(input.plan.generatedAt);
    const offset = Math.floor((utcDay(now) - utcDay(generated)) / 86_400_000);
    plannedIds = input.plan.days.find((day) => day.dayOffset === offset)?.newCardIds ?? [];
  }
  const orderedNew = [
    ...plannedIds.flatMap((id) => {
      const card = cardsById.get(id);
      return card && !input.fsrsStates[id] ? [card] : [];
    }),
    ...unstudied.filter((card) => !plannedIds.includes(card.id)),
  ];
  const desiredNew = Math.min(8, Math.max(Math.min(3, unstudied.length), plannedIds.length));
  const newCards = orderedNew.slice(0, Math.min(desiredNew, 15 - queue.length));
  queue.push(...newCards.map((card) => ({ reason: "planned" as const, card })));

  return StudyQueueSchema.parse({
    dueCount: due.length,
    newCount: newCards.length,
    queue,
  });
}

export function dueForecast(fsrsStates: FsrsStateMap, now = new Date()): number[] {
  const forecast = Array.from({ length: 7 }, () => 0);
  for (const state of Object.values(fsrsStates)) {
    const offset = Math.floor((utcDay(new Date(state.due)) - utcDay(now)) / 86_400_000);
    if (offset >= 0 && offset < 7) forecast[offset] = forecast[offset]! + 1;
  }
  return forecast;
}

export function buildAdaptivePlan(input: {
  deck: CommittedKnowledgeCard[];
  fsrsStates: FsrsStateMap;
  version: number;
  now?: Date;
}): ReviewPlan {
  const now = input.now ?? new Date();
  const days = Array.from({ length: 7 }, (_, dayOffset) => ({
    dayOffset,
    newCardIds: [] as `0x${string}`[],
    reviewCardIds: [] as `0x${string}`[],
  }));
  const dueCards = input.deck
    .filter((card) => input.fsrsStates[card.id])
    .sort((left, right) => Date.parse(input.fsrsStates[left.id]!.due) - Date.parse(input.fsrsStates[right.id]!.due));
  for (const card of dueCards) {
    const offset = Math.max(
      0,
      Math.min(6, Math.floor((utcDay(new Date(input.fsrsStates[card.id]!.due)) - utcDay(now)) / 86_400_000)),
    );
    if (days[offset]!.reviewCardIds.length < 15) days[offset]!.reviewCardIds.push(card.id);
  }
  const newCards = input.deck.filter((card) => !input.fsrsStates[card.id]).sort(priority);
  let dayOffset = 0;
  for (const card of newCards) {
    while (
      dayOffset < 6 &&
      (days[dayOffset]!.newCardIds.length >= 3 ||
        days[dayOffset]!.newCardIds.length + days[dayOffset]!.reviewCardIds.length >= 15)
    ) {
      dayOffset += 1;
    }
    const day = days[dayOffset]!;
    if (day.newCardIds.length < 8 && day.newCardIds.length + day.reviewCardIds.length < 15) {
      day.newCardIds.push(card.id);
    }
  }
  return ReviewPlanSchema.parse({
    version: input.version,
    generatedAt: now.toISOString(),
    days,
  });
}
