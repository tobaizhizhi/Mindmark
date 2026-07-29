import { ReviewRatingSchema } from "@mindmark/shared";
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
  rating: z.infer<typeof ReviewRatingSchema>;
  reviewedAt: string;
}): SerializedFsrsCard {
  const reviewedAt = new Date(input.reviewedAt);
  const current: CardInput | Card = input.currentState
    ? { ...input.currentState, last_review: input.currentState.last_review ?? null }
    : createEmptyCard(reviewedAt);
  return serializeCard(scheduler.next(current, reviewedAt, ratingMap[input.rating]).card);
}
