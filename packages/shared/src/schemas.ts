import { z } from "zod";

export const MAX_SOURCE_PAGES = 30;
export const MAX_SOURCE_CHARACTERS = 60_000;

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, "Expected a 32-byte hex value")
  .transform((value) => value.toLowerCase() as `0x${string}`);

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, "Expected an EVM address")
  .transform((value) => value.toLowerCase() as `0x${string}`);

export const SourcePageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    text: z.string().trim().min(1).max(30_000),
  })
  .strict();

export const CardSourceSchema = z
  .object({
    page: z.number().int().positive(),
    quote: z.string().trim().min(20).max(400),
  })
  .strict();

export const KnowledgeCardContentSchema = z
  .object({
    type: z.enum(["concept", "qa"]),
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(1_500),
    keyPoint: z.string().trim().min(1).max(500),
    source: CardSourceSchema,
    tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    importance: z.number().int().min(1).max(5),
    initialDifficulty: z.number().int().min(1).max(5),
  })
  .strict();

export const PlannedDaySchema = z
  .object({
    dayOffset: z.number().int().min(0).max(6),
    newCardIds: z.array(Bytes32Schema).max(8),
    reviewCardIds: z.array(Bytes32Schema).max(15),
  })
  .strict()
  .refine((day) => day.newCardIds.length + day.reviewCardIds.length <= 15, {
    message: "A planned day cannot contain more than 15 tasks",
  });

export const ReviewPlanSchema = z
  .object({
    version: z.number().int().positive(),
    generatedAt: z.string().datetime({ offset: true }),
    days: z.array(PlannedDaySchema).length(7),
  })
  .strict();

export const AuthNonceRequestSchema = z.object({ address: AddressSchema }).strict();

export const AuthNonceResponseSchema = z
  .object({
    nonce: z.string().min(8).max(64),
    expiresAt: z.string().datetime({ offset: true }),
    chainId: z.number().int().positive(),
    domain: z.string().min(1),
    uri: z.string().url(),
  })
  .strict();

export const AuthVerifyRequestSchema = z
  .object({
    message: z.string().min(1).max(4_000),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/u),
  })
  .strict();

export const AuthVerifyResponseSchema = z
  .object({ address: AddressSchema, expiresAt: z.string().datetime({ offset: true }) })
  .strict();

export const ReviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

export const SubmitReviewRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    cardId: Bytes32Schema,
    rating: ReviewRatingSchema,
    responseMs: z.number().int().min(0).max(3_600_000),
    reviewedAt: z.string().datetime({ offset: true }),
    scope: z.enum(["CHAPTER", "PROJECT"]).optional(),
  })
  .strict();

export const SubmitReviewResponseSchema = z
  .object({
    accepted: z.boolean(),
    duplicate: z.boolean(),
    nextReviewAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type SourcePage = z.infer<typeof SourcePageSchema>;
export type KnowledgeCardContent = z.infer<typeof KnowledgeCardContentSchema>;
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;
export type AuthNonceRequest = z.infer<typeof AuthNonceRequestSchema>;
export type AuthNonceResponse = z.infer<typeof AuthNonceResponseSchema>;
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponseSchema>;
export type SubmitReviewRequest = z.infer<typeof SubmitReviewRequestSchema>;
export type SubmitReviewResponse = z.infer<typeof SubmitReviewResponseSchema>;
