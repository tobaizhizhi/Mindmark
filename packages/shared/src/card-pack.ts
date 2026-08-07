import { canonicalize } from "json-canonicalize";
import { keccak256, stringToHex, type Hex } from "viem";
import { z } from "zod";
import { Bytes32Schema } from "./schemas.js";

export const CARD_PACK_SCHEMA_VERSION = 1;
export const MAX_CARD_PACK_CHAPTERS = 16;
export const CARD_PACK_TYPES = [
  "concept",
  "qa",
  "comparison",
  "process",
  "application",
  "misconception",
  "code_read",
  "code_write",
  "code_complete",
  "code_debug",
  "output_trace",
  "security_review",
] as const;

export const CARD_PACK_CODE_TYPES = [
  "code_read",
  "code_write",
  "code_complete",
  "code_debug",
  "output_trace",
  "security_review",
] as const;

const SlugSchema = z.string().regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  "Expected a lowercase kebab-case identifier",
);

export const ProjectKindSchema = z.enum(["UPLOAD", "PACK"]);
export const PackLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
export const PackCardTypeSchema = z.enum(CARD_PACK_TYPES);

export const PackReadingBlockSchema = z.object({
  blockId: SlugSchema.max(120),
  position: z.number().int().min(0).max(199),
  kind: z.enum(["heading", "paragraph", "code", "callout"]),
  text: z.string().trim().min(1).max(30_000),
  language: z.string().trim().min(1).max(40).optional(),
}).strict().superRefine((block, context) => {
  if (block.kind === "code" && !block.language) {
    context.addIssue({ code: "custom", path: ["language"], message: "Code reading blocks require a language" });
  }
  if (block.kind !== "code" && block.language) {
    context.addIssue({ code: "custom", path: ["language"], message: "Only code reading blocks may declare a language" });
  }
});

export const PackCodeExerciseSchema = z
  .object({
    language: z.literal("solidity"),
    starterCode: z.string().trim().max(8_000).optional(),
    solutionCode: z.string().trim().min(1).max(8_000),
    testInput: z.string().trim().max(2_000).optional(),
    expectedResult: z.string().trim().max(2_000).optional(),
    hints: z.array(z.string().trim().min(1).max(300)).max(3).optional(),
  })
  .strict();

export const PackReferenceSchema = z
  .object({
    kind: z.literal("pack_reference").default("pack_reference"),
    label: z.string().trim().min(1).max(200),
    url: z.string().url().max(500).optional(),
    locator: z.string().trim().min(1).max(200).optional(),
    quote: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const PackKnowledgeCardContentSchema = z
  .object({
    type: PackCardTypeSchema,
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(1_500),
    keyPoint: z.string().trim().min(1).max(500),
    source: PackReferenceSchema,
    tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    importance: z.number().int().min(1).max(5),
    initialDifficulty: z.number().int().min(1).max(5),
    readingBlockId: SlugSchema.max(120).optional(),
    code: PackCodeExerciseSchema.optional(),
  })
  .strict();

export const PackCardSchema = z
  .object({
    packCardId: SlugSchema.max(120),
    position: z.number().int().min(0).max(199),
    type: PackCardTypeSchema,
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(1_500),
    keyPoint: z.string().trim().min(1).max(500),
    tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    importance: z.number().int().min(1).max(5),
    initialDifficulty: z.number().int().min(1).max(5),
    readingBlockId: SlugSchema.max(120).optional(),
    sourceReference: PackReferenceSchema,
    code: PackCodeExerciseSchema.optional(),
  })
  .strict()
  .superRefine((card, context) => {
    const isCodeCard = (CARD_PACK_CODE_TYPES as readonly string[]).includes(card.type);
    if (isCodeCard && !card.code) {
      context.addIssue({ code: "custom", path: ["code"], message: "Code cards require a Solidity exercise" });
    }
    if (!isCodeCard && card.code) {
      context.addIssue({ code: "custom", path: ["code"], message: "Only code cards may include a Solidity exercise" });
    }
  });

export const PackChapterSchema = z
  .object({
    chapterId: z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1),
    position: z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1),
    slug: SlugSchema.max(80),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    estimatedMinutes: z.number().int().min(1).max(600),
    learningObjectives: z.array(z.string().trim().min(1).max(200)).min(2).max(5).optional(),
    prerequisiteChapterIds: z.array(z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1)).max(5).optional(),
    stageId: z.number().int().min(0).max(7).optional(),
    stageTitle: z.string().trim().min(1).max(80).optional(),
    newConcepts: z.array(z.string().trim().min(1).max(80)).min(1).max(8).optional(),
    prerequisiteConcepts: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
    practiceFocus: z.string().trim().min(1).max(300).optional(),
    projectMilestone: z.string().trim().min(1).max(300).optional(),
    readingBlocks: z.array(PackReadingBlockSchema).min(1).max(200).optional(),
    cards: z.array(PackCardSchema).min(5).max(30),
  })
  .strict();

export const PackManifestChapterSchema = z
  .object({
    id: z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1),
    position: z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1),
    slug: SlugSchema.max(80),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    estimatedMinutes: z.number().int().min(1).max(600),
    learningObjectives: z.array(z.string().trim().min(1).max(200)).min(2).max(5).optional(),
    prerequisiteChapterIds: z.array(z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1)).max(5).optional(),
    stageId: z.number().int().min(0).max(7).optional(),
    stageTitle: z.string().trim().min(1).max(80).optional(),
    newConcepts: z.array(z.string().trim().min(1).max(80)).min(1).max(8).optional(),
    prerequisiteConcepts: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
    practiceFocus: z.string().trim().min(1).max(300).optional(),
    projectMilestone: z.string().trim().min(1).max(300).optional(),
    readingBlocks: z.array(PackReadingBlockSchema).min(1).max(200).optional(),
    cardCount: z.number().int().min(5).max(30),
    cardsFile: z.string().regex(/^chapters\/[a-z0-9-]+\.json$/u),
  })
  .strict();

export const PackManifestSchema = z
  .object({
    schemaVersion: z.literal(CARD_PACK_SCHEMA_VERSION),
    slug: SlugSchema.max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u, "Expected a semantic version"),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1_000),
    subject: z.string().trim().min(1).max(100),
    language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u),
    level: PackLevelSchema,
    license: z.string().trim().min(1).max(100),
    attribution: z.string().trim().min(1).max(300),
    chapters: z.array(PackManifestChapterSchema).min(1).max(MAX_CARD_PACK_CHAPTERS),
  })
  .strict();

export const CardPackBundleSchema = z
  .object({
    manifest: PackManifestSchema,
    chapters: z.array(PackChapterSchema).min(1).max(MAX_CARD_PACK_CHAPTERS),
  })
  .strict();

export const CardPackArtifactSchema = z
  .object({
    manifest: PackManifestSchema,
    chapters: z.array(PackChapterSchema),
    manifestHash: z.string().regex(/^0x[0-9a-f]{64}$/u),
    contentHash: z.string().regex(/^0x[0-9a-f]{64}$/u),
    chapterCount: z.number().int().min(1).max(MAX_CARD_PACK_CHAPTERS),
    cardCount: z.number().int().min(1).max(200),
  })
  .strict();

export const CardPackCatalogItemSchema = z.object({
  packId: z.string().uuid(),
  packVersionId: z.string().uuid(),
  slug: SlugSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1_000),
  subject: z.string().trim().min(1).max(100),
  language: z.string().min(2).max(10),
  level: PackLevelSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  chapterCount: z.number().int().min(1).max(MAX_CARD_PACK_CHAPTERS),
  cardCount: z.number().int().min(1).max(200),
  estimatedMinutes: z.number().int().min(1),
  license: z.string().trim().min(1).max(100),
  attribution: z.string().trim().min(1).max(300),
  installedProjectId: Bytes32Schema.nullable(),
}).strict();

export const CardPackCatalogResponseSchema = z.object({
  packs: z.array(CardPackCatalogItemSchema).max(100),
}).strict();

export const PublishedPackCardSchema = PackKnowledgeCardContentSchema.extend({
  packCardId: SlugSchema,
  position: z.number().int().min(0).max(199),
}).strict();

export const PublishedPackChapterSchema = z.object({
  chapterId: z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1),
  position: z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1),
  slug: SlugSchema,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  estimatedMinutes: z.number().int().min(1).max(600),
  learningObjectives: z.array(z.string().trim().min(1).max(200)).min(2).max(5).optional(),
  prerequisiteChapterIds: z.array(z.number().int().min(0).max(MAX_CARD_PACK_CHAPTERS - 1)).max(5).optional(),
  stageId: z.number().int().min(0).max(7).optional(),
  stageTitle: z.string().trim().min(1).max(80).optional(),
  newConcepts: z.array(z.string().trim().min(1).max(80)).min(1).max(8).optional(),
  prerequisiteConcepts: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
  practiceFocus: z.string().trim().min(1).max(300).optional(),
  projectMilestone: z.string().trim().min(1).max(300).optional(),
  readingBlocks: z.array(PackReadingBlockSchema).min(1).max(200).optional(),
  cardCount: z.number().int().min(1).max(30),
  cards: z.array(PublishedPackCardSchema).max(30),
}).strict();

export const PublishedCardPackSchema = CardPackCatalogItemSchema.extend({
  chapters: z.array(PublishedPackChapterSchema).min(1).max(MAX_CARD_PACK_CHAPTERS),
}).strict();

export const InstallCardPackRequestSchema = z.object({
  folderId: z.string().uuid().nullable().optional(),
}).strict();

export const InstallCardPackResponseSchema = z.object({
  installationId: z.string().uuid(),
  projectId: Bytes32Schema,
  projectKind: z.literal("PACK"),
  packVersionId: z.string().uuid(),
  status: z.literal("READY"),
  chapterCount: z.number().int().min(1).max(MAX_CARD_PACK_CHAPTERS),
  cardCount: z.number().int().min(1).max(200),
  idempotent: z.boolean(),
}).strict();

export type ProjectKind = z.infer<typeof ProjectKindSchema>;
export type PackReference = z.infer<typeof PackReferenceSchema>;
export type PackReadingBlock = z.infer<typeof PackReadingBlockSchema>;
export type PackCodeExercise = z.infer<typeof PackCodeExerciseSchema>;
export type PackKnowledgeCardContent = z.infer<typeof PackKnowledgeCardContentSchema>;
export type PackCard = z.infer<typeof PackCardSchema>;
export type PackChapter = z.infer<typeof PackChapterSchema>;
export type PackManifest = z.infer<typeof PackManifestSchema>;
export type CardPackBundle = z.infer<typeof CardPackBundleSchema>;
export type CardPackArtifact = z.infer<typeof CardPackArtifactSchema>;
export type CardPackCatalogItem = z.infer<typeof CardPackCatalogItemSchema>;
export type CardPackCatalogResponse = z.infer<typeof CardPackCatalogResponseSchema>;
export type PublishedCardPack = z.infer<typeof PublishedCardPackSchema>;
export type InstallCardPackRequest = z.infer<typeof InstallCardPackRequestSchema>;
export type InstallCardPackResponse = z.infer<typeof InstallCardPackResponseSchema>;

function assertContiguous(values: number[], field: string): void {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.some((value, index) => value !== index)) {
    throw new Error(`${field} must be unique and contiguous from zero`);
  }
}

function normalizedQuestion(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function assertChapterCoverage(chapter: PackChapter, requireCodeExercise: boolean): void {
  const foundationCount = chapter.cards.filter((card) => card.type === "concept" || card.type === "qa").length;
  if (foundationCount < 2) {
    throw new Error(`Pack Chapter ${chapter.slug} needs at least two concept or Q&A cards`);
  }
  if (!chapter.cards.some((card) => card.type === "comparison" || card.type === "process" || (CARD_PACK_CODE_TYPES as readonly string[]).includes(card.type))) {
    throw new Error(`Pack Chapter ${chapter.slug} needs a comparison or process card`);
  }
  if (!chapter.cards.some((card) => card.type === "application")) {
    throw new Error(`Pack Chapter ${chapter.slug} needs an application card`);
  }
  if (!chapter.cards.some((card) => card.type === "misconception")) {
    throw new Error(`Pack Chapter ${chapter.slug} needs a misconception card`);
  }
  if (requireCodeExercise && !chapter.cards.some((card) => (CARD_PACK_CODE_TYPES as readonly string[]).includes(card.type))) {
    throw new Error(`Pack Chapter ${chapter.slug} needs a code exercise card`);
  }
}

export function validateCardPack(input: unknown): CardPackBundle {
  const bundle = CardPackBundleSchema.parse(input);
  const { manifest, chapters } = bundle;
  if (chapters.length !== manifest.chapters.length) {
    throw new Error("Pack manifest Chapter count does not match loaded Chapter files");
  }
  assertContiguous(manifest.chapters.map((chapter) => chapter.id), "Pack manifest Chapter IDs");
  assertContiguous(manifest.chapters.map((chapter) => chapter.position), "Pack manifest Chapter positions");
  assertContiguous(chapters.map((chapter) => chapter.chapterId), "Pack Chapter IDs");
  assertContiguous(chapters.map((chapter) => chapter.position), "Pack Chapter positions");

  const cardIds = new Set<string>();
  const questions = new Set<string>();
  const majorVersion = Number(manifest.version.split(".")[0]);
  for (const chapter of chapters) {
    const declared = manifest.chapters.find((item) => item.id === chapter.chapterId);
    if (!declared) throw new Error(`Pack Chapter ${chapter.chapterId} is not declared in the manifest`);
    if (
      declared.position !== chapter.position
      || declared.slug !== chapter.slug
      || declared.title !== chapter.title
      || declared.summary !== chapter.summary
      || declared.estimatedMinutes !== chapter.estimatedMinutes
      || canonicalize(declared.learningObjectives ?? []) !== canonicalize(chapter.learningObjectives ?? [])
      || canonicalize(declared.prerequisiteChapterIds ?? []) !== canonicalize(chapter.prerequisiteChapterIds ?? [])
      || declared.stageId !== chapter.stageId
      || declared.stageTitle !== chapter.stageTitle
      || canonicalize(declared.newConcepts ?? []) !== canonicalize(chapter.newConcepts ?? [])
      || canonicalize(declared.prerequisiteConcepts ?? []) !== canonicalize(chapter.prerequisiteConcepts ?? [])
      || declared.practiceFocus !== chapter.practiceFocus
      || declared.projectMilestone !== chapter.projectMilestone
      || canonicalize(declared.readingBlocks ?? []) !== canonicalize(chapter.readingBlocks ?? [])
      || declared.cardCount !== chapter.cards.length
    ) {
      throw new Error(`Pack Chapter ${chapter.slug} does not match its manifest entry`);
    }
    assertContiguous(chapter.cards.map((card) => card.position), `Pack Chapter ${chapter.slug} card positions`);
    assertChapterCoverage(chapter, majorVersion >= 2);
    if (majorVersion >= 3) {
      if (!chapter.learningObjectives || chapter.learningObjectives.length < 3) {
        throw new Error(`Progressive Pack Chapter ${chapter.slug} needs at least three learning objectives`);
      }
      if (majorVersion >= 4) {
        if (chapter.stageId === undefined || !chapter.stageTitle || !chapter.newConcepts?.length || !chapter.practiceFocus || !chapter.projectMilestone) {
          throw new Error(`Structured Pack Chapter ${chapter.slug} needs stage, concepts, practice focus, and project milestone metadata`);
        }
        if (chapter.chapterId === 0 && (chapter.prerequisiteConcepts?.length ?? 0) > 0) {
          throw new Error(`Structured Pack Chapter ${chapter.slug} cannot require concepts before the first chapter`);
        }
        if (chapter.chapterId > 0 && (chapter.prerequisiteConcepts?.length ?? 0) === 0) {
          throw new Error(`Structured Pack Chapter ${chapter.slug} must declare prerequisite concepts`);
        }
        if (chapter.stageId > 0 && chapter.chapterId > 0 && chapter.stageId < (chapters[chapter.chapterId - 1]?.stageId ?? 0)) {
          throw new Error(`Structured Pack Chapter ${chapter.slug} moves backward between stages`);
        }
      }
      const prerequisites = chapter.prerequisiteChapterIds ?? [];
      if (chapter.chapterId === 0 ? prerequisites.length > 0 : !prerequisites.includes(chapter.chapterId - 1)) {
        throw new Error(`Progressive Pack Chapter ${chapter.slug} must depend on the immediately preceding Chapter`);
      }
    }
    if (majorVersion >= 5) {
      if (!chapter.readingBlocks?.length) {
        throw new Error(`Readable Pack Chapter ${chapter.slug} needs authored reading blocks`);
      }
      assertContiguous(chapter.readingBlocks.map((block) => block.position), `Pack Chapter ${chapter.slug} reading block positions`);
      const blockIds = new Set(chapter.readingBlocks.map((block) => block.blockId));
      if (blockIds.size !== chapter.readingBlocks.length) {
        throw new Error(`Pack Chapter ${chapter.slug} has duplicate reading block IDs`);
      }
      for (const card of chapter.cards) {
        if (!card.readingBlockId || !blockIds.has(card.readingBlockId)) {
          throw new Error(`Pack Card ${card.packCardId} must reference a reading block in its Chapter`);
        }
      }
    }
    for (const card of chapter.cards) {
      if (cardIds.has(card.packCardId)) throw new Error(`Duplicate Pack Card ID: ${card.packCardId}`);
      cardIds.add(card.packCardId);
      const question = normalizedQuestion(card.question);
      if (questions.has(question)) throw new Error(`Duplicate Pack Card question: ${card.question}`);
      questions.add(question);
      if (manifest.language.startsWith("zh") && !/\p{Script=Han}/u.test(card.question)) {
        throw new Error(`Chinese Pack Card question must contain Chinese text: ${card.packCardId}`);
      }
      const isCodeCard = (CARD_PACK_CODE_TYPES as readonly string[]).includes(card.type);
      if (isCodeCard && !card.code) throw new Error(`Code Pack Card requires an exercise: ${card.packCardId}`);
      if (!isCodeCard && card.code) throw new Error(`Only code Pack Cards may include an exercise: ${card.packCardId}`);
    }
  }
  return bundle;
}

function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(canonicalize(value)));
}

export function hashCardPackManifest(manifest: PackManifest): Hex {
  return hashCanonical(PackManifestSchema.parse(manifest));
}

export function hashCardPackContent(bundle: CardPackBundle): Hex {
  const parsed = CardPackBundleSchema.parse(bundle);
  return hashCanonical({
    slug: parsed.manifest.slug,
    version: parsed.manifest.version,
    chapters: [...parsed.chapters]
      .sort((left, right) => left.position - right.position)
      .map((chapter) => ({
        ...chapter,
        cards: [...chapter.cards].sort((left, right) => left.position - right.position),
      })),
  });
}

export function materializePackKnowledgeCard(card: PackCard): PackKnowledgeCardContent {
  const parsed = PackCardSchema.parse(card);
  return PackKnowledgeCardContentSchema.parse({
    type: parsed.type,
    question: parsed.question,
    answer: parsed.answer,
    keyPoint: parsed.keyPoint,
    source: parsed.sourceReference,
    tags: parsed.tags,
    importance: parsed.importance,
    initialDifficulty: parsed.initialDifficulty,
    ...(parsed.readingBlockId ? { readingBlockId: parsed.readingBlockId } : {}),
    ...(parsed.code ? { code: parsed.code } : {}),
  });
}

export function buildCardPackArtifact(input: unknown): CardPackArtifact {
  const bundle = validateCardPack(input);
  return CardPackArtifactSchema.parse({
    ...bundle,
    manifestHash: hashCardPackManifest(bundle.manifest),
    contentHash: hashCardPackContent(bundle),
    chapterCount: bundle.chapters.length,
    cardCount: bundle.chapters.reduce((total, chapter) => total + chapter.cards.length, 0),
  });
}
