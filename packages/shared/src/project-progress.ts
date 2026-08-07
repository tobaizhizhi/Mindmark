import { z } from "zod";
import { Bytes32Schema } from "./schemas.js";
import { MAX_PROJECT_CHAPTERS } from "./project-v2.js";

export const LearnerProjectStageSchema = z.enum([
  "ANALYZING_SOURCE",
  "OUTLINE_READY",
  "DESIGNING_CARDS",
  "AWAITING_MONAD",
  "GENERATING_CARDS",
  "CHECKING_QUALITY",
  "READY",
  "ACTION_REQUIRED",
  "FAILED",
]);

export const LearnerProjectProgressSchema = z.object({
  projectId: Bytes32Schema,
  stage: LearnerProjectStageSchema,
  progressPercent: z.number().int().min(0).max(100),
  currentChapter: z.object({
    chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
    title: z.string().min(1).max(200),
  }).nullable(),
  completedChapters: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
  totalChapters: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
  retrying: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
  operationId: z.string().uuid().nullable(),
  code: z.string().min(1).max(100).nullable(),
}).strict();

export type LearnerProjectStage = z.infer<typeof LearnerProjectStageSchema>;
export type LearnerProjectProgress = z.infer<typeof LearnerProjectProgressSchema>;
