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
  "REPAIRING_CARDS",
  "ASSEMBLING_CHAPTERS",
  "READY",
  "ACTION_REQUIRED",
  "FAILED",
]);

const ProjectPhaseCountSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict().refine((value) => value.completed <= value.total, {
  message: "completed phase count cannot exceed total",
});

export const LearnerProjectPhaseCountsSchema = z.object({
  generation: ProjectPhaseCountSchema,
  qualityCheck: ProjectPhaseCountSchema,
  automaticRepair: ProjectPhaseCountSchema.extend({
    active: z.number().int().nonnegative(),
  }).strict(),
  assembly: ProjectPhaseCountSchema,
  completion: ProjectPhaseCountSchema,
}).strict();

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
  phaseCounts: LearnerProjectPhaseCountsSchema,
  retrying: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
  operationId: z.string().uuid().nullable(),
  code: z.string().min(1).max(100).nullable(),
}).strict();

export type LearnerProjectStage = z.infer<typeof LearnerProjectStageSchema>;
export type LearnerProjectPhaseCounts = z.infer<typeof LearnerProjectPhaseCountsSchema>;
export type LearnerProjectProgress = z.infer<typeof LearnerProjectProgressSchema>;
