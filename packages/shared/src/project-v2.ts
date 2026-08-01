import { z } from "zod";
import {
  AddressSchema,
  Bytes32Schema,
  KnowledgeCardContentSchema,
  SourcePageSchema,
} from "./schemas.js";

export const MAX_PROJECT_CHAPTERS = 16;
export const MAX_CHAPTER_WORK_UNITS = 8;
export const MAX_PROJECT_WORK_UNITS = 48;
export const MAX_PROJECT_CARDS = 200;
export const MAX_SOURCE_BLOCK_CHARACTERS = 4_000;

export const ProjectStatusSchema = z.enum([
  "UPLOADED",
  "OUTLINING",
  "OUTLINE_READY",
  "DESIGNING_CARDS",
  "AWAITING_REGISTRY",
  "GENERATING",
  "FINALIZING",
  "READY",
  "FAILED_RETRYABLE",
  "CANCELLED",
]);

export const ChapterStatusSchema = z.enum([
  "DRAFT",
  "CONFIRMED",
  "GENERATING",
  "QUALITY_CHECK",
  "ASSEMBLING",
  "READY",
  "FAILED_RETRYABLE",
]);

export const WorkUnitStatusSchema = z.enum([
  "QUEUED",
  "GENERATING",
  "VALIDATING",
  "CANDIDATE_READY",
  "REPAIRING",
  "APPROVED",
  "SAVED",
  "SUBMITTING",
  "CONFIRMED",
  "RETRYABLE",
]);

export const SourceBlockKindSchema = z.enum(["heading", "paragraph", "code"]);

export const SourceBlockContentSchema = z
  .object({
    blockIndex: z.number().int().min(0).max(65_535),
    pageNumber: z.number().int().positive(),
    kind: SourceBlockKindSchema,
    text: z.string().trim().min(1).max(MAX_SOURCE_BLOCK_CHARACTERS),
  })
  .strict();

export const SourceBlockSchema = SourceBlockContentSchema.extend({
  headingLevel: z.number().int().min(1).max(6).nullable().default(null),
  blockHash: Bytes32Schema,
}).strict();

export const ChapterOutlineItemSchema = z
  .object({
    chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
    position: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    startBlock: z.number().int().min(0).max(65_535),
    endBlock: z.number().int().min(0).max(65_535),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    sourceHash: Bytes32Schema,
    importance: z.number().int().min(1).max(5),
  })
  .strict()
  .superRefine((chapter, context) => {
    if (chapter.endBlock < chapter.startBlock) {
      context.addIssue({
        code: "custom",
        message: "endBlock must be greater than or equal to startBlock",
        path: ["endBlock"],
      });
    }
    if (chapter.pageEnd < chapter.pageStart) {
      context.addIssue({
        code: "custom",
        message: "pageEnd must be greater than or equal to pageStart",
        path: ["pageEnd"],
      });
    }
  });

export const ChapterOutlineSchema = z
  .object({
    projectId: Bytes32Schema,
    outlineVersion: z.number().int().positive(),
    outlineHash: Bytes32Schema,
    chapters: z
      .array(ChapterOutlineItemSchema)
      .min(1)
      .max(MAX_PROJECT_CHAPTERS),
  })
  .strict();

export const ChapterProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    startBlock: z.number().int().min(0).max(65_535),
    endBlock: z.number().int().min(0).max(65_535),
    importance: z.number().int().min(1).max(5),
  })
  .strict();

export const ChapterProposalListSchema = z
  .array(ChapterProposalSchema)
  .min(1)
  .max(MAX_PROJECT_CHAPTERS);

export const SourceExclusionCategorySchema = z.enum([
  "REPEATED_HEADER_FOOTER",
  "PAGE_NUMBER",
  "TABLE_OF_CONTENTS",
  "COPYRIGHT",
  "PROMOTIONAL",
  "ADMINISTRATIVE",
  "EXAM_UPDATE",
  "VERSION_NOTICE",
  "SCHEDULE_NOTICE",
  "OTHER",
]);

export const SourceExclusionRangeSchema = z.object({
  startBlock: z.number().int().min(0).max(65_535),
  endBlock: z.number().int().min(0).max(65_535),
  category: SourceExclusionCategorySchema,
  reason: z.string().trim().min(1).max(300),
}).strict().superRefine((range, context) => {
  if (range.endBlock < range.startBlock) {
    context.addIssue({
      code: "custom",
      message: "endBlock must be greater than or equal to startBlock",
      path: ["endBlock"],
    });
  }
});

export const SourceExclusionRangeListSchema = z.array(SourceExclusionRangeSchema).max(256);

export const ChapterPlanningProposalSchema = z.object({
  chapters: ChapterProposalListSchema,
  excludedRanges: SourceExclusionRangeListSchema,
}).strict();

export const ChapterOutlineDraftSchema = ChapterOutlineSchema.extend({
  excludedRanges: SourceExclusionRangeListSchema,
}).strict();

export const LearningProjectSchema = z
  .object({
    projectId: Bytes32Schema,
    ownerAddress: AddressSchema,
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(500).nullable(),
    sourceHash: Bytes32Schema,
    goalHash: Bytes32Schema,
    outlineVersion: z.number().int().positive(),
    outlineHash: Bytes32Schema.nullable(),
    workUnitManifestRoot: Bytes32Schema.nullable(),
    registryVersion: z.literal(2),
    status: ProjectStatusSchema,
    projectDeckRoot: Bytes32Schema.nullable(),
    initialPlanHash: Bytes32Schema.nullable(),
    totalCardCount: z.number().int().min(0).max(MAX_PROJECT_CARDS),
  })
  .strict();

export const ChapterSchema = ChapterOutlineItemSchema.extend({
  projectId: Bytes32Schema,
  outlineVersion: z.number().int().positive(),
  status: ChapterStatusSchema,
  cardsRoot: Bytes32Schema.nullable(),
  cardCount: z.number().int().min(0).max(30),
  minCardCount: z.number().int().min(2).max(30),
  targetCardCount: z.number().int().min(2).max(30),
  maxCardCount: z.number().int().min(2).max(30),
  finalizeTxHash: Bytes32Schema.nullable(),
}).strict();

export const WorkUnitSchema = z
  .object({
    projectId: Bytes32Schema,
    workUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1),
    chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
    unitIndex: z.number().int().min(0).max(MAX_CHAPTER_WORK_UNITS - 1),
    startBlock: z.number().int().min(0).max(65_535),
    endBlock: z.number().int().min(0).max(65_535),
    sourceBlockIndexes: z.array(z.number().int().min(0).max(65_535)).min(1),
    sourceUnitHash: Bytes32Schema,
    manifestProof: z.array(Bytes32Schema),
    cardMinimum: z.number().int().min(1).max(30),
    cardTarget: z.number().int().min(1).max(30),
    cardBudget: z.number().int().min(1).max(30),
    workerAddress: AddressSchema.nullable(),
    status: WorkUnitStatusSchema,
  })
  .strict()
  .superRefine((workUnit, context) => {
    if (workUnit.endBlock < workUnit.startBlock) {
      context.addIssue({
        code: "custom",
        message: "endBlock must be greater than or equal to startBlock",
        path: ["endBlock"],
      });
    }
    if (workUnit.cardMinimum > workUnit.cardTarget || workUnit.cardTarget > workUnit.cardBudget) {
      context.addIssue({
        code: "custom",
        message: "cardMinimum must not exceed cardTarget or cardBudget",
        path: ["cardMinimum"],
      });
    }
    if (
      workUnit.sourceBlockIndexes.some((value, index) =>
        value < workUnit.startBlock
        || value > workUnit.endBlock
        || (index > 0 && value <= workUnit.sourceBlockIndexes[index - 1]!)
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "sourceBlockIndexes must be unique, ordered, and inside the Work Unit range",
        path: ["sourceBlockIndexes"],
      });
    }
  });

export const WorkerKnowledgeCardV2Schema = KnowledgeCardContentSchema.extend({
  id: Bytes32Schema,
  cardHash: Bytes32Schema,
  projectId: Bytes32Schema,
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  workUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1),
  workerProof: z.array(Bytes32Schema),
}).strict();

export const KnowledgeCardV2Schema = WorkerKnowledgeCardV2Schema.extend({
  position: z.number().int().min(0).max(MAX_PROJECT_CARDS - 1),
  chapterProof: z.array(Bytes32Schema),
}).strict();

export const ChapterProgressSchema = z
  .object({
    projectId: Bytes32Schema,
    chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
    cardCount: z.number().int().nonnegative(),
    studiedCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    newCount: z.number().int().nonnegative(),
    masteredCount: z.number().int().nonnegative(),
    lastReviewedAt: z.string().datetime({ offset: true }).nullable(),
    progressPercent: z.number().min(0).max(100),
  })
  .strict()
  .superRefine((progress, context) => {
    for (const field of ["studiedCount", "dueCount", "newCount", "masteredCount"] as const) {
      if (progress[field] > progress.cardCount) {
        context.addIssue({
          code: "custom",
          message: `${field} cannot exceed cardCount`,
          path: [field],
        });
      }
    }
  });

export const ProjectIntakeRequestSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(500).optional(),
    sourceFilename: z.string().trim().min(1).max(255).optional(),
    sourceMimeType: z.string().trim().min(1).max(100).optional(),
    folderId: z.string().uuid().optional(),
    pages: z.array(SourcePageSchema).min(1).max(30),
  })
  .strict();

export const ProjectSourceRegistrationResponseSchema = z.object({
  projectId: Bytes32Schema,
  status: z.literal("UPLOADED"),
  sourceHash: Bytes32Schema,
  sourcePageCount: z.number().int().positive(),
  sourceCharacterCount: z.number().int().positive(),
}).strict();

export const ProjectSummarySchema = z
  .object({
    projectId: Bytes32Schema,
    title: z.string().min(1).max(200),
    goal: z.string().max(500).nullable(),
    status: ProjectStatusSchema,
    registryVersion: z.literal(2),
    chapterCount: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
    readyChapterCount: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
    cardCount: z.number().int().min(0).max(MAX_PROJECT_CARDS),
    dueCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const ChapterSummarySchema = ChapterProgressSchema.extend({
  position: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  importance: z.number().int().min(1).max(5),
  status: ChapterStatusSchema,
}).strict();

export const ProjectIntakeResponseSchema = z
  .object({
    projectId: Bytes32Schema,
    status: z.literal("OUTLINE_READY"),
    sourceHash: Bytes32Schema,
    outlineVersion: z.number().int().positive(),
    outlineHash: Bytes32Schema,
    chapters: z.array(ChapterOutlineItemSchema).min(1).max(MAX_PROJECT_CHAPTERS),
    excludedRanges: SourceExclusionRangeListSchema.default([]),
  })
  .strict();

export const OutlinePlanningOperationStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "RETRYABLE",
  "FAILED",
  "CANCELLED",
]);

export const WorkflowJobKindSchema = z.enum([
  "PLAN_OUTLINE",
  "DESIGN_CHAPTER",
  "FREEZE_PROJECT_DESIGN",
  "RECONCILE_PROJECT",
  "GENERATE_WORK_UNIT",
  "QUALITY_CHECK_CHAPTER",
  "ASSEMBLE_CHAPTER",
  "FINALIZE_PROJECT",
  "SETTLE_WORK_UNIT_REWARD",
]);

export const WorkflowJobStatusSchema = OutlinePlanningOperationStatusSchema;

export const WorkflowOperationsMetricsSchema = z.object({
  queuedJobs: z.number().int().nonnegative(),
  runningJobs: z.number().int().nonnegative(),
  retryableJobs: z.number().int().nonnegative(),
  failedJobs: z.number().int().nonnegative(),
  staleJobs: z.number().int().nonnegative(),
  succeededJobs: z.number().int().nonnegative(),
  pendingRewards: z.number().int().nonnegative(),
  blockedRewards: z.number().int().nonnegative(),
  retryableRewards: z.number().int().nonnegative(),
  failedProjects: z.number().int().nonnegative(),
}).strict();

export const WorkflowOperationsJobSchema = z.object({
  jobId: z.string().uuid(),
  projectId: Bytes32Schema,
  projectTitle: z.string().trim().min(1).max(200),
  kind: WorkflowJobKindSchema,
  status: WorkflowJobStatusSchema,
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1).nullable(),
  workUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1).nullable(),
  attempt: z.number().int().nonnegative(),
  availableAt: z.string().datetime({ offset: true }),
  leaseUntil: z.string().datetime({ offset: true }).nullable(),
  lastError: z.string().max(500).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const WorkflowOperationsEventSchema = z.object({
  eventId: z.coerce.number().int().nonnegative(),
  jobId: z.string().uuid().nullable(),
  projectId: Bytes32Schema,
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1).nullable(),
  workUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1).nullable(),
  eventType: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const WorkflowOperationsAlertSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  code: z.enum(["STALE_JOBS", "FAILED_JOBS", "BLOCKED_REWARDS", "FAILED_PROJECTS"]),
  count: z.number().int().positive(),
  message: z.string().min(1).max(200),
}).strict();

export const WorkflowOperationsSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  metrics: WorkflowOperationsMetricsSchema,
  alerts: z.array(WorkflowOperationsAlertSchema).max(4),
  jobs: z.array(WorkflowOperationsJobSchema).max(100),
  events: z.array(WorkflowOperationsEventSchema).max(80),
}).strict();

export const LearningQualityFeedbackSummarySchema = z.object({
  totalCount: z.number().int().nonnegative(),
  upCount: z.number().int().nonnegative(),
  downCount: z.number().int().nonnegative(),
  incorrectCount: z.number().int().nonnegative(),
  unclearCount: z.number().int().nonnegative(),
}).strict();

export const LearningQualityChapterSummarySchema = z.object({
  projectId: Bytes32Schema,
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  slotCount: z.number().int().nonnegative(),
  requiredSlotCount: z.number().int().nonnegative(),
  acceptedSlotCount: z.number().int().nonnegative(),
  evaluationCount: z.number().int().nonnegative(),
  approvedEvaluationCount: z.number().int().nonnegative(),
  repairRequestedEvaluationCount: z.number().int().nonnegative(),
  failedEvaluationCount: z.number().int().nonnegative(),
  feedback: LearningQualityFeedbackSummarySchema,
}).strict();

export const LearningQualitySlotSummarySchema = z.object({
  projectId: Bytes32Schema,
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  slotId: Bytes32Schema,
  cardType: z.enum(["concept", "comparison", "process", "application", "misconception"]),
  required: z.boolean(),
  status: z.enum(["PLANNED", "ASSIGNED", "CANDIDATE_READY", "REPAIR_REQUESTED", "ACCEPTED", "REJECTED"]),
  evaluationCount: z.number().int().nonnegative(),
  approvedEvaluationCount: z.number().int().nonnegative(),
  repairRequestedEvaluationCount: z.number().int().nonnegative(),
  failedEvaluationCount: z.number().int().nonnegative(),
  feedback: LearningQualityFeedbackSummarySchema,
}).strict();

export const LearningQualityFailureCategorySchema = z.object({
  code: z.string().trim().min(1).max(100),
  count: z.number().int().positive(),
}).strict();

export const LearningQualityOperationsReportSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  feedback: LearningQualityFeedbackSummarySchema,
  chapters: z.array(LearningQualityChapterSummarySchema).max(MAX_PROJECT_CHAPTERS * 24),
  slots: z.array(LearningQualitySlotSummarySchema).max(MAX_PROJECT_CHAPTERS * 30),
  failureCategories: z.array(LearningQualityFailureCategorySchema).max(20),
}).strict();

export const OutlinePlanningOperationSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: Bytes32Schema,
    status: OutlinePlanningOperationStatusSchema,
    attempt: z.number().int().nonnegative(),
    lastError: z.string().max(500).nullable(),
  })
  .strict();

export const ProjectListResponseSchema = z
  .object({ projects: z.array(ProjectSummarySchema).max(24) })
  .strict();

export const LibraryFolderSchema = z.object({
  folderId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  parentFolderId: z.string().uuid().nullable(),
  documentCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const LibraryDocumentSchema = z.object({
  projectId: Bytes32Schema,
  folderId: z.string().uuid().nullable(),
  title: z.string().trim().min(1).max(200),
  sourceFilename: z.string().trim().min(1).max(255).nullable(),
  sourceMimeType: z.string().trim().min(1).max(100).nullable(),
  sourcePageCount: z.number().int().positive().nullable(),
  status: ProjectStatusSchema,
  chapterCount: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
  readyChapterCount: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
  cardCount: z.number().int().min(0).max(MAX_PROJECT_CARDS),
  dueCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const DocumentLibraryResponseSchema = z.object({
  currentFolderId: z.string().uuid().nullable(),
  folders: z.array(LibraryFolderSchema).max(500),
  documents: z.array(LibraryDocumentSchema).max(500),
}).strict();

export const CreateFolderRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentFolderId: z.string().uuid().nullable().optional(),
}).strict();

export const RenameFolderRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict();

export type OutlinePlanningOperation = z.infer<typeof OutlinePlanningOperationSchema>;
export type WorkflowOperationsSnapshot = z.infer<typeof WorkflowOperationsSnapshotSchema>;
export type LearningQualityFeedbackSummary = z.infer<typeof LearningQualityFeedbackSummarySchema>;
export type LearningQualityChapterSummary = z.infer<typeof LearningQualityChapterSummarySchema>;
export type LearningQualitySlotSummary = z.infer<typeof LearningQualitySlotSummarySchema>;
export type LearningQualityFailureCategory = z.infer<typeof LearningQualityFailureCategorySchema>;
export type LearningQualityOperationsReport = z.infer<typeof LearningQualityOperationsReportSchema>;

export const FolderMutationResponseSchema = z.object({
  folderId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  parentFolderId: z.string().uuid().nullable(),
}).strict();

export const MoveProjectRequestSchema = z.object({
  folderId: z.string().uuid().nullable(),
}).strict();

export const ChapterListResponseSchema = z
  .object({
    projectId: Bytes32Schema,
    chapters: z.array(ChapterSummarySchema).max(MAX_PROJECT_CHAPTERS),
  })
  .strict();

export const ProjectConfirmationResponseSchema = z
  .object({
    projectId: Bytes32Schema,
    status: z.literal("AWAITING_REGISTRY"),
    outlineVersion: z.number().int().positive(),
    outlineHash: Bytes32Schema,
    workUnitManifestRoot: Bytes32Schema,
    chapterCount: z.number().int().min(1).max(MAX_PROJECT_CHAPTERS),
    workUnitCount: z.number().int().min(1).max(MAX_PROJECT_WORK_UNITS),
    createProjectArgs: z
      .object({
        projectId: Bytes32Schema,
        sourceHash: Bytes32Schema,
        goalHash: Bytes32Schema,
        outlineHash: Bytes32Schema,
        workUnitManifestRoot: Bytes32Schema,
        chapters: z
          .array(
            z
              .object({
                sourceHash: Bytes32Schema,
                firstWorkUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1),
                workUnitCount: z.number().int().min(1).max(MAX_CHAPTER_WORK_UNITS),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_PROJECT_CHAPTERS),
      })
      .strict(),
  })
  .strict();

export const ProjectDesignAcceptedResponseSchema = z.object({
  projectId: Bytes32Schema,
  status: z.literal("DESIGNING_CARDS"),
  outlineVersion: z.number().int().positive(),
  outlineHash: Bytes32Schema,
  chapterCount: z.number().int().min(1).max(MAX_PROJECT_CHAPTERS),
}).strict();

export const ProjectOutlineConfirmationResponseSchema = z.discriminatedUnion("status", [
  ProjectDesignAcceptedResponseSchema,
  ProjectConfirmationResponseSchema,
]);

export const ProjectDesignProgressSchema = z.object({
  completedChapters: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
  totalChapters: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
  failedChapters: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
}).strict();

export const ProjectCreationViewSchema = z.object({
  projectId: Bytes32Schema,
  status: ProjectStatusSchema,
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(500).nullable(),
  sourceFilename: z.string().min(1).max(255).nullable(),
  sourceMimeType: z.string().min(1).max(100).nullable(),
  sourcePageCount: z.number().int().positive().nullable(),
  sourceCharacterCount: z.number().int().positive().nullable(),
  outline: ProjectIntakeResponseSchema.nullable(),
  confirmation: ProjectConfirmationResponseSchema.nullable(),
  designProgress: ProjectDesignProgressSchema.nullable(),
}).strict();

export const SaveCreateProjectResponseSchema = z
  .object({
    projectId: Bytes32Schema,
    status: z.literal("CREATED"),
    blockNumber: z.string().regex(/^\d+$/u),
  })
  .strict();

export const SaveCreateProjectTransactionRequestSchema = z
  .object({ txHash: Bytes32Schema })
  .strict();

export const ChapterStudyCardSchema = KnowledgeCardContentSchema.extend({
  id: Bytes32Schema,
  position: z.number().int().min(0).max(MAX_PROJECT_CARDS - 1),
  state: z.enum(["NEW", "LEARNING", "DUE", "SCHEDULED"]),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
}).strict();

export const ChapterStudyResponseSchema = z.object({
  projectId: Bytes32Schema,
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  status: ChapterStatusSchema,
  cards: z.array(ChapterStudyCardSchema).max(30),
  queue: z.array(Bytes32Schema).max(MAX_PROJECT_CARDS),
  dueCount: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
}).strict();

export const ProjectStudyCardSchema = ChapterStudyCardSchema.extend({
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  chapterPosition: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  chapterTitle: z.string().min(1).max(200),
}).strict();

export const ProjectStudyResponseSchema = z.object({
  projectId: Bytes32Schema,
  status: ProjectStatusSchema,
  readyChapterCount: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
  queue: z.array(ProjectStudyCardSchema).max(MAX_PROJECT_CARDS),
  dueCount: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
}).strict();

export const CompleteProjectSessionRequestSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

export const CompleteProjectSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  reviewedCount: z.number().int().min(0).max(15),
  forgottenCount: z.number().int().min(0).max(15),
  averageResponseMs: z.number().int().nonnegative(),
  completedAt: z.string().datetime({ offset: true }),
}).strict();

export const KnowledgeCardFeedbackRatingSchema = z.enum(["UP", "DOWN", "INCORRECT", "UNCLEAR"]);

export const KnowledgeCardCorrectionSchema = z.object({
  question: z.string().trim().min(1).max(500).optional(),
  answer: z.string().trim().min(1).max(1_500).optional(),
  keyPoint: z.string().trim().min(1).max(500).optional(),
}).strict().refine(
  (correction) => Object.values(correction).some((value) => value !== undefined),
  "A correction must contain at least one card field",
);

export const SubmitKnowledgeCardFeedbackRequestSchema = z.object({
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  cardId: Bytes32Schema,
  rating: KnowledgeCardFeedbackRatingSchema,
  reason: z.string().trim().min(1).max(500).optional(),
  correctedContent: KnowledgeCardCorrectionSchema.optional(),
}).strict().superRefine((feedback, context) => {
  if ((feedback.rating === "INCORRECT" || feedback.rating === "UNCLEAR") && !feedback.reason) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Incorrect and unclear feedback requires a reason",
    });
  }
});

export const KnowledgeCardFeedbackSchema = z.object({
  feedbackId: z.string().uuid(),
  projectId: Bytes32Schema,
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  cardId: Bytes32Schema,
  rating: KnowledgeCardFeedbackRatingSchema,
  reason: z.string().nullable(),
  correctedContent: KnowledgeCardCorrectionSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const KnowledgeCardFeedbackListResponseSchema = z.object({
  feedback: z.array(KnowledgeCardFeedbackSchema).max(100),
}).strict();

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
export type ChapterStatus = z.infer<typeof ChapterStatusSchema>;
export type WorkUnitStatus = z.infer<typeof WorkUnitStatusSchema>;
export type SourceBlockKind = z.infer<typeof SourceBlockKindSchema>;
export type SourceBlockContent = z.infer<typeof SourceBlockContentSchema>;
export type SourceBlock = z.infer<typeof SourceBlockSchema>;
export type ChapterOutlineItem = z.infer<typeof ChapterOutlineItemSchema>;
export type ChapterOutline = z.infer<typeof ChapterOutlineSchema>;
export type LearningProject = z.infer<typeof LearningProjectSchema>;
export type Chapter = z.infer<typeof ChapterSchema>;
export type WorkUnit = z.infer<typeof WorkUnitSchema>;
export type WorkerKnowledgeCardV2 = z.infer<typeof WorkerKnowledgeCardV2Schema>;
export type KnowledgeCardV2 = z.infer<typeof KnowledgeCardV2Schema>;
export type ChapterProgress = z.infer<typeof ChapterProgressSchema>;
export type ProjectIntakeRequest = z.infer<typeof ProjectIntakeRequestSchema>;
export type ProjectSourceRegistrationResponse = z.infer<typeof ProjectSourceRegistrationResponseSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;
export type ProjectIntakeResponse = z.infer<typeof ProjectIntakeResponseSchema>;
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
export type LibraryFolder = z.infer<typeof LibraryFolderSchema>;
export type LibraryDocument = z.infer<typeof LibraryDocumentSchema>;
export type DocumentLibraryResponse = z.infer<typeof DocumentLibraryResponseSchema>;
export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>;
export type FolderMutationResponse = z.infer<typeof FolderMutationResponseSchema>;
export type MoveProjectRequest = z.infer<typeof MoveProjectRequestSchema>;
export type ChapterListResponse = z.infer<typeof ChapterListResponseSchema>;
export type ChapterProposal = z.infer<typeof ChapterProposalSchema>;
export type SourceExclusionCategory = z.infer<typeof SourceExclusionCategorySchema>;
export type SourceExclusionRange = z.infer<typeof SourceExclusionRangeSchema>;
export type ChapterPlanningProposal = z.infer<typeof ChapterPlanningProposalSchema>;
export type ChapterOutlineDraft = z.infer<typeof ChapterOutlineDraftSchema>;
export type ProjectConfirmationResponse = z.infer<typeof ProjectConfirmationResponseSchema>;
export type ProjectDesignAcceptedResponse = z.infer<typeof ProjectDesignAcceptedResponseSchema>;
export type ProjectOutlineConfirmationResponse = z.infer<typeof ProjectOutlineConfirmationResponseSchema>;
export type ProjectDesignProgress = z.infer<typeof ProjectDesignProgressSchema>;
export type ProjectCreationView = z.infer<typeof ProjectCreationViewSchema>;
export type SaveCreateProjectResponse = z.infer<typeof SaveCreateProjectResponseSchema>;
export type ChapterStudyCard = z.infer<typeof ChapterStudyCardSchema>;
export type ChapterStudyResponse = z.infer<typeof ChapterStudyResponseSchema>;
export type ProjectStudyCard = z.infer<typeof ProjectStudyCardSchema>;
export type ProjectStudyResponse = z.infer<typeof ProjectStudyResponseSchema>;
export type CompleteProjectSessionResponse = z.infer<typeof CompleteProjectSessionResponseSchema>;
export type KnowledgeCardFeedbackRating = z.infer<typeof KnowledgeCardFeedbackRatingSchema>;
export type KnowledgeCardCorrection = z.infer<typeof KnowledgeCardCorrectionSchema>;
export type SubmitKnowledgeCardFeedbackRequest = z.infer<typeof SubmitKnowledgeCardFeedbackRequestSchema>;
export type KnowledgeCardFeedback = z.infer<typeof KnowledgeCardFeedbackSchema>;
export type KnowledgeCardFeedbackListResponse = z.infer<typeof KnowledgeCardFeedbackListResponseSchema>;
