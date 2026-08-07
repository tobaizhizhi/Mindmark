import { z } from "zod";

export const AiTutorConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(6_000),
}).strict();

export const AskChapterTutorRequestSchema = z.object({
  question: z.string().trim().min(1).max(1_200),
  currentPage: z.number().int().positive().nullable().optional(),
  selectedText: z.string().trim().min(1).max(2_000).nullable().optional(),
  history: z.array(AiTutorConversationMessageSchema).max(8).default([]),
}).strict();

export const AiTutorCitationSchema = z.object({
  blockId: z.string().min(1).max(120),
  pageNumber: z.number().int().positive().nullable(),
  quote: z.string().trim().min(1).max(500),
}).strict();

export const AskChapterTutorResponseSchema = z.object({
  answer: z.string().trim().min(1).max(8_000),
  citations: z.array(AiTutorCitationSchema).max(6),
  suggestedQuestions: z.array(z.string().trim().min(1).max(160)).max(3),
}).strict();

export const AiTutorStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("answer_delta"),
    delta: z.string().min(1).max(8_000),
  }).strict(),
  z.object({
    type: z.literal("result"),
    response: AskChapterTutorResponseSchema,
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
  }).strict(),
]);

export type AiTutorConversationMessage = z.infer<typeof AiTutorConversationMessageSchema>;
export type AskChapterTutorRequest = z.infer<typeof AskChapterTutorRequestSchema>;
export type AiTutorCitation = z.infer<typeof AiTutorCitationSchema>;
export type AskChapterTutorResponse = z.infer<typeof AskChapterTutorResponseSchema>;
export type AiTutorStreamEvent = z.infer<typeof AiTutorStreamEventSchema>;
