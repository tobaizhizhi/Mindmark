import type {
  CommittedKnowledgeCard,
  JourneyDetailResponse,
} from "@mindmark/shared";

type StudyQueue = NonNullable<JourneyDetailResponse["studyQueue"]>;
type StudyQueueItem = StudyQueue["queue"][number];
type ChapterChunk = Pick<
  JourneyDetailResponse["chunks"][number],
  "chunkId" | "pageStart" | "pageEnd" | "title"
>;

export type StudyChapter = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  chunkIds: number[];
  cards: CommittedKnowledgeCard[];
  studiedCount: number;
  queue: StudyQueueItem[];
};

export type StudyChapterSource = {
  chunks: ChapterChunk[];
  deck: CommittedKnowledgeCard[] | null;
  studiedCardIds: readonly `0x${string}`[];
  studyQueue: StudyQueue | null;
};

const segmentSuffix = /\s*·\s*分段\s+\d+\/\d+\s*$/u;

function baseChapterTitle(title: string): string {
  return title.replace(segmentSuffix, "").trim();
}

function isExplicitChapterTitle(title: string): boolean {
  return (
    /^第[0-9一二三四五六七八九十百]+[章节篇部单元]\s*\S*/u.test(title) ||
    /^(?:chapter|unit|part|section)\s+[0-9ivxlcdm]+(?:\s*[:：.-]\s*|\s+)\S*/iu.test(title) ||
    /^\d+(?:\.\d+){0,3}[.)、:：\s]+\S+/u.test(title)
  );
}

function oneChapter(chunks: ChapterChunk[]): Array<{
  id: string;
  title: string;
  chunks: ChapterChunk[];
}> {
  return [{ id: "chapter-all", title: "全部学习内容", chunks }];
}

export function buildStudyChapters(source: StudyChapterSource): StudyChapter[] {
  if (source.chunks.length === 0) return [];
  const pageStart = Math.min(...source.chunks.map((chunk) => chunk.pageStart));
  const pageEnd = Math.max(...source.chunks.map((chunk) => chunk.pageEnd));
  const compactMaterial = pageEnd - pageStart + 1 <= 8;
  const titledChunks = source.chunks.map((chunk) => ({
    chunk,
    title: baseChapterTitle(chunk.title),
  }));
  const hasExplicitChapters = titledChunks.some(({ title }) => isExplicitChapterTitle(title));

  const groups =
    compactMaterial || !hasExplicitChapters
      ? oneChapter(source.chunks)
      : [...titledChunks.reduce((grouped, { chunk, title }) => {
          const current = grouped.get(title);
          if (current) current.chunks.push(chunk);
          else grouped.set(title, { id: `chapter-${chunk.chunkId}`, title, chunks: [chunk] });
          return grouped;
        }, new Map<string, { id: string; title: string; chunks: ChapterChunk[] }>()).values()];

  const deck = source.deck ?? [];
  const studiedIds = new Set(source.studiedCardIds);
  const queue = source.studyQueue?.queue ?? [];

  return groups.map((group) => {
    const chunkIds = group.chunks.map((chunk) => chunk.chunkId);
    const chunkIdSet = new Set(chunkIds);
    const cards = deck.filter((card) => chunkIdSet.has(card.chunkId));
    return {
      id: group.id,
      title: group.title,
      pageStart: Math.min(...group.chunks.map((chunk) => chunk.pageStart)),
      pageEnd: Math.max(...group.chunks.map((chunk) => chunk.pageEnd)),
      chunkIds,
      cards,
      studiedCount: cards.filter((card) => studiedIds.has(card.id)).length,
      queue: queue.filter((item) => chunkIdSet.has(item.card.chunkId)),
    };
  });
}

