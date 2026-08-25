import {
  Bytes32Schema,
  ChapterReadingResponseSchema,
  KnowledgeCardContentSchema,
  PackKnowledgeCardContentSchema,
  type ChapterReadingBlock,
  type ChapterReadingResponse,
  type SourcePage,
} from "@mindmark/shared";
import { z } from "zod";
import type { Hex } from "viem";
import { extractPdfSourcePages } from "@/lib/client/pdf-source";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

const SOURCE_FILE_BUCKET = "learning-source-files";
const PDF_TEXT_CACHE_TTL_MS = 15 * 60_000;
const PDF_TEXT_CACHE_LIMIT = 16;

type PdfTextCacheEntry = {
  expiresAt: number;
  pages: SourcePage[];
};

const pdfTextCache = new Map<Hex, PdfTextCacheEntry>();
const pdfTextLoads = new Map<Hex, Promise<SourcePage[]>>();

const OwnedReadingChapterSchema = z.object({
  project_id: Bytes32Schema,
  project_kind: z.enum(["UPLOAD", "PACK"]),
  pack_version_id: z.string().uuid().nullable(),
  title: z.string().min(1).max(200),
  chapter_id: z.number().int().min(0).max(15),
  chapter_title: z.string().min(1).max(200),
  start_block: z.number().int().nonnegative().nullable(),
  end_block: z.number().int().nonnegative().nullable(),
  page_start: z.number().int().positive().nullable(),
  page_end: z.number().int().positive().nullable(),
  pack_chapter_id: z.number().int().min(0).max(15).nullable(),
}).strict();

const UploadBlockRowSchema = z.object({
  block_index: z.number().int().nonnegative(),
  page_number: z.number().int().positive(),
  kind: z.enum(["heading", "paragraph", "code"]),
  text: z.string().min(1).nullable(),
}).strict();

const UploadFileRowSchema = z.object({
  source_storage_bucket: z.string().min(1).nullable(),
  source_storage_path: z.string().min(1).nullable(),
  source_file_status: z.enum(["MISSING", "UPLOADING", "READY", "FAILED"]),
}).strict();

const PackBlockRowSchema = z.object({
  block_id: z.string().min(1).max(120),
  position: z.number().int().nonnegative(),
  kind: z.enum(["heading", "paragraph", "code", "callout"]),
  text: z.string().min(1),
  language: z.string().nullable(),
}).strict();

const ReadingCardRowSchema = z.object({
  card_id: Bytes32Schema,
  content: z.unknown(),
}).strict();

type OwnedReadingChapter = z.infer<typeof OwnedReadingChapterSchema>;
type UploadBlockRow = z.infer<typeof UploadBlockRowSchema>;
type PackBlockRow = z.infer<typeof PackBlockRowSchema>;
type ReadingCardRow = z.infer<typeof ReadingCardRowSchema>;

export interface ProjectReadingStore {
  loadOwnedChapter(
    projectId: Hex,
    chapterId: number,
    owner: `0x${string}`,
  ): Promise<OwnedReadingChapter | null>;
  loadUploadBlocks(projectId: Hex, startBlock: number, endBlock: number): Promise<UploadBlockRow[]>;
  loadUploadPages?(projectId: Hex, pageStart: number, pageEnd: number): Promise<SourcePage[]>;
  loadPackBlocks(packVersionId: string, packChapterId: number): Promise<PackBlockRow[]>;
  loadCards(projectId: Hex, chapterId: number): Promise<ReadingCardRow[]>;
}

class SupabaseProjectReadingStore implements ProjectReadingStore {
  async loadOwnedChapter(projectId: Hex, chapterId: number, owner: `0x${string}`) {
    const client = getSupabaseAdmin();
    const { data: project, error: projectError } = await client.from("learning_projects")
      .select("project_id,project_kind,pack_version_id,title")
      .eq("project_id", projectId).eq("owner_address", owner).maybeSingle();
    if (projectError) throw new Error(`Could not read Project for Chapter reading: ${projectError.message}`);
    if (!project) return null;
    const { data: chapter, error: chapterError } = await client.from("chapters")
      .select("chapter_id,title,start_block,end_block,page_start,page_end,pack_chapter_id")
      .eq("project_id", projectId).eq("chapter_id", chapterId).maybeSingle();
    if (chapterError) throw new Error(`Could not read Chapter for reading: ${chapterError.message}`);
    if (!chapter) return null;
    return OwnedReadingChapterSchema.parse({
      ...project,
      chapter_id: chapter.chapter_id,
      chapter_title: chapter.title,
      start_block: chapter.start_block,
      end_block: chapter.end_block,
      page_start: chapter.page_start,
      page_end: chapter.page_end,
      pack_chapter_id: chapter.pack_chapter_id,
    });
  }

  async loadUploadBlocks(projectId: Hex, startBlock: number, endBlock: number) {
    const { data, error } = await getSupabaseAdmin().from("source_blocks")
      .select("block_index,page_number,kind,text")
      .eq("project_id", projectId).gte("block_index", startBlock).lte("block_index", endBlock)
      .order("block_index");
    if (error) throw new Error(`Could not read Chapter Source Blocks: ${error.message}`);
    return UploadBlockRowSchema.array().parse(data ?? []);
  }

  async loadUploadPages(projectId: Hex, pageStart: number, pageEnd: number) {
    const now = Date.now();
    const cached = pdfTextCache.get(projectId);
    if (cached && cached.expiresAt > now) {
      return cached.pages.filter((page) => page.pageNumber >= pageStart && page.pageNumber <= pageEnd);
    }
    if (cached) pdfTextCache.delete(projectId);

    let loading = pdfTextLoads.get(projectId);
    if (!loading) {
      loading = this.extractStoredPdfPages(projectId);
      pdfTextLoads.set(projectId, loading);
    }
    try {
      const pages = await loading;
      return pages.filter((page) => page.pageNumber >= pageStart && page.pageNumber <= pageEnd);
    } finally {
      if (pdfTextLoads.get(projectId) === loading) pdfTextLoads.delete(projectId);
    }
  }

  private async extractStoredPdfPages(projectId: Hex): Promise<SourcePage[]> {
    const client = getSupabaseAdmin();
    const { data, error } = await client.from("learning_projects")
      .select("source_storage_bucket,source_storage_path,source_file_status")
      .eq("project_id", projectId).maybeSingle();
    if (error) throw new Error(`Could not locate stored source PDF: ${error.message}`);
    if (!data) return [];
    const file = UploadFileRowSchema.parse(data);
    if (file.source_file_status !== "READY" || !file.source_storage_path) return [];
    const downloaded = await client.storage
      .from(file.source_storage_bucket ?? SOURCE_FILE_BUCKET)
      .download(file.source_storage_path);
    if (downloaded.error || !downloaded.data) {
      throw new Error(`Could not download stored source PDF: ${downloaded.error?.message ?? "file unavailable"}`);
    }
    const pages = await extractPdfSourcePages(await downloaded.data.arrayBuffer());
    if (pdfTextCache.size >= PDF_TEXT_CACHE_LIMIT) {
      pdfTextCache.delete(pdfTextCache.keys().next().value as Hex);
    }
    pdfTextCache.set(projectId, {
      expiresAt: Date.now() + PDF_TEXT_CACHE_TTL_MS,
      pages,
    });
    return pages;
  }

  async loadPackBlocks(packVersionId: string, packChapterId: number) {
    const { data, error } = await getSupabaseAdmin().from("card_pack_chapter_reading_blocks")
      .select("block_id,position,kind,text,language")
      .eq("pack_version_id", packVersionId).eq("chapter_id", packChapterId).order("position");
    if (error) throw new Error(`Could not read Card Pack Chapter content: ${error.message}`);
    return PackBlockRowSchema.array().parse(data ?? []);
  }

  async loadCards(projectId: Hex, chapterId: number) {
    const { data, error } = await getSupabaseAdmin().from("knowledge_cards")
      .select("card_id,content").eq("project_id", projectId).eq("chapter_id", chapterId).order("position");
    if (error) throw new Error(`Could not read Chapter Cards for source links: ${error.message}`);
    return ReadingCardRowSchema.array().parse(data ?? []);
  }
}

function normalizedCitation(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function uploadCardLinks(blocks: ChapterReadingBlock[], cards: ReadingCardRow[]) {
  type IndexedBlock = { block: ChapterReadingBlock; normalizedText: string };
  const blocksByPage = new Map<number, IndexedBlock[]>();
  for (const block of blocks) {
    if (block.pageNumber === null) continue;
    const pageBlocks = blocksByPage.get(block.pageNumber);
    const indexed = { block, normalizedText: normalizedCitation(block.text) };
    if (pageBlocks) {
      pageBlocks.push(indexed);
    } else {
      blocksByPage.set(block.pageNumber, [indexed]);
    }
  }

  return cards.flatMap((row) => {
    const card = KnowledgeCardContentSchema.safeParse(row.content);
    if (!card.success) return [];
    const samePage = blocksByPage.get(card.data.source.page) ?? [];
    const quote = normalizedCitation(card.data.source.quote);
    const exact = samePage.filter((entry) => entry.normalizedText.includes(quote));
    const target = exact.length === 1 ? exact[0] : samePage[0];
    if (!target) return [];
    return [{
      cardId: row.card_id,
      blockId: target.block.blockId,
      match: exact.length === 1 ? "QUOTE" as const : "PAGE_FALLBACK" as const,
    }];
  });
}

function savedUploadBlocks(blocks: UploadBlockRow[]): ChapterReadingBlock[] {
  return blocks.flatMap((block) => block.text === null ? [] : [{
    blockId: `source-block-${block.block_index}`,
    position: 0,
    kind: block.kind,
    text: block.text,
    pageNumber: block.page_number,
    language: block.kind === "code" ? "text" : null,
  }]).map((block, position) => ({ ...block, position }));
}

function recoveredPdfBlocks(pages: SourcePage[]): ChapterReadingBlock[] {
  return pages.map((page, position) => ({
    blockId: `source-page-${page.pageNumber}`,
    position,
    kind: "paragraph",
    text: page.text,
    pageNumber: page.pageNumber,
    language: null,
  }));
}

function savedCardQuoteBlocks(cards: ReadingCardRow[]): ChapterReadingBlock[] {
  const seen = new Set<string>();
  return cards.flatMap((row) => {
    const card = KnowledgeCardContentSchema.safeParse(row.content);
    if (!card.success) return [];
    const key = `${card.data.source.page}:${normalizedCitation(card.data.source.quote)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ pageNumber: card.data.source.page, text: card.data.source.quote }];
  }).map((source, position) => ({
    blockId: `source-card-${position}`,
    position,
    kind: "paragraph",
    text: source.text,
    pageNumber: source.pageNumber,
    language: null,
  }));
}

function packCardLinks(blocks: PackBlockRow[], cards: ReadingCardRow[]) {
  const blockIds = new Set(blocks.map((block) => block.block_id));
  return cards.flatMap((row) => {
    const card = PackKnowledgeCardContentSchema.safeParse(row.content);
    if (!card.success || !card.data.readingBlockId || !blockIds.has(card.data.readingBlockId)) return [];
    return [{ cardId: row.card_id, blockId: card.data.readingBlockId, match: "EXPLICIT" as const }];
  });
}

export async function getChapterReadingForOwner(
  projectId: Hex,
  chapterId: number,
  owner: `0x${string}`,
  store: ProjectReadingStore = new SupabaseProjectReadingStore(),
): Promise<ChapterReadingResponse> {
  const loaded = await store.loadOwnedChapter(projectId, chapterId, owner);
  if (!loaded) throw new ApiError(404, "chapter_not_found", "Chapter was not found");
  const cards = await store.loadCards(projectId, chapterId);
  if (loaded.project_kind === "UPLOAD") {
    if (loaded.start_block === null || loaded.end_block === null) {
      throw new Error("UPLOAD Chapter is missing its Source Block range");
    }
    const blocks = await store.loadUploadBlocks(projectId, loaded.start_block, loaded.end_block);
    if (blocks.length === 0) throw new ApiError(404, "reading_not_available", "Chapter source is not available");
    let readingBlocks = savedUploadBlocks(blocks);
    if (readingBlocks.length !== blocks.length) {
      let recoveredPages: SourcePage[] = [];
      if (loaded.page_start !== null && loaded.page_end !== null && store.loadUploadPages) {
        try {
          recoveredPages = await store.loadUploadPages(projectId, loaded.page_start, loaded.page_end);
        } catch {
          recoveredPages = [];
        }
      }
      readingBlocks = recoveredPages.length > 0
        ? recoveredPdfBlocks(recoveredPages)
        : readingBlocks.length > 0
          ? readingBlocks
          : savedCardQuoteBlocks(cards);
    }
    if (readingBlocks.length === 0) {
      throw new ApiError(
        409,
        "reading_source_redacted",
        "这个旧项目的正文已被清理，且没有可恢复的原 PDF，请重新上传 PDF",
      );
    }
    return ChapterReadingResponseSchema.parse({
      projectId,
      chapterId,
      origin: "UPLOAD_SOURCE",
      title: loaded.chapter_title,
      pageStart: loaded.page_start,
      pageEnd: loaded.page_end,
      blocks: readingBlocks,
      cardLinks: uploadCardLinks(readingBlocks, cards),
    });
  }

  if (!loaded.pack_version_id || loaded.pack_chapter_id === null) {
    throw new Error("PACK Chapter is missing Card Pack provenance");
  }
  const blocks = await store.loadPackBlocks(loaded.pack_version_id, loaded.pack_chapter_id);
  if (blocks.length === 0) throw new ApiError(404, "reading_not_available", "This Card Pack Version has no course reading");
  return ChapterReadingResponseSchema.parse({
    projectId,
    chapterId,
    origin: "PACK_LESSON",
    title: loaded.chapter_title,
    pageStart: null,
    pageEnd: null,
    blocks: blocks.map((block) => ({
      blockId: block.block_id,
      position: block.position,
      kind: block.kind,
      text: block.text,
      pageNumber: null,
      language: block.language,
    })),
    cardLinks: packCardLinks(blocks, cards),
  });
}
