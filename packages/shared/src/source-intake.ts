import { normalizeSourceText } from "./citations.js";
import { isUsableChapterTitle } from "./chapter-title.js";
import { hashSourceBlockV2, hashSourceBlocksV2 } from "./hash-v2.js";
import {
  MAX_SOURCE_BLOCK_CHARACTERS,
  SourceBlockContentSchema,
  SourceBlockSchema,
  type SourceBlock,
  type SourceBlockContent,
  type SourceBlockKind,
} from "./project-v2.js";
import {
  MAX_SOURCE_CHARACTERS,
  MAX_SOURCE_PAGES,
  SourcePageSchema,
  type SourcePage,
} from "./schemas.js";
import { classifyStandaloneSourceText } from "./source-relevance.js";
import type { Hex } from "viem";

export type SourceIntake = {
  sourceHash: Hex;
  pageCount: number;
  characterCount: number;
  blocks: SourceBlock[];
};

function headingLevel(value: string): number | null {
  const line = normalizeSourceText(value);
  if (line.length < 2 || line.length > 160) return null;
  const markdown = /^(#{1,6})\s+\S+/u.exec(line);
  if (markdown) return isUsableChapterTitle(line) ? markdown[1]!.length : null;
  const chinese = /^第[0-9一二三四五六七八九十百]+([章节篇部单元])\s*\S*/u.exec(line);
  if (chinese) return isUsableChapterTitle(line) ? chinese[1] === "节" ? 2 : 1 : null;
  const english = /^(chapter|unit|part|section)\s+[0-9ivxlcdm]+(?:\s*[:：.-]\s*|\s+)\S*/iu.exec(line);
  if (english) return isUsableChapterTitle(line)
    ? english[1]!.toLowerCase() === "section" ? 2 : 1
    : null;
  if (
    /^(?:目\s*录|contents|table\s+of\s+contents|(?:\d{2,4}\s*年?)?(?:考\s*纲|考试大纲)(?:变化|调整|更新|修订)?|考试安排|报名通知|版本说明|更新说明|勘误说明|作者简介|出版说明)$/iu.test(line)
  ) return 1;
  if (classifyStandaloneSourceText(line)) return null;
  const numbered = /^(\d+(?:\.\d+){0,3})(?:\s*[.)、:：）]\s*|\s+(?=\p{L}))\S+/u.exec(line);
  return numbered && isUsableChapterTitle(line) ? numbered[1]!.split(".").length : null;
}

function splitMetadataPrefix(line: string): { notice: string; remainder: string } | null {
  const match = /^(.{1,240}?[。！？.!?])\s*(.+)$/u.exec(line);
  if (!match) return null;
  const classification = classifyStandaloneSourceText(match[1]!);
  if (!classification || !["EXAM_UPDATE", "VERSION_NOTICE", "SCHEDULE_NOTICE"].includes(classification.category)) {
    return null;
  }
  return { notice: match[1]!, remainder: match[2]! };
}

function splitLongText(text: string): string[] {
  if (text.length <= MAX_SOURCE_BLOCK_CHARACTERS) return [text];
  const sentences = text
    .split(/(?<=[.!?。！？])\s*/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const parts: string[] = [];
  let current = "";

  for (const sentence of sentences.length > 1 ? sentences : [text]) {
    let remaining = sentence;
    while (remaining.length > MAX_SOURCE_BLOCK_CHARACTERS) {
      if (current) {
        parts.push(current);
        current = "";
      }
      parts.push(remaining.slice(0, MAX_SOURCE_BLOCK_CHARACTERS).trim());
      remaining = remaining.slice(MAX_SOURCE_BLOCK_CHARACTERS).trim();
    }
    if (!remaining) continue;
    const candidate = current ? `${current} ${remaining}` : remaining;
    if (candidate.length > MAX_SOURCE_BLOCK_CHARACTERS) {
      parts.push(current);
      current = remaining;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function repeatedPageLines(pages: SourcePage[]): Set<string> {
  if (pages.length < 3) return new Set();
  const linePages = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const rawLine of page.text.replace(/\r\n?/gu, "\n").split("\n")) {
      const line = normalizeSourceText(rawLine);
      if (!line || line.length > 200) continue;
      const pagesForLine = linePages.get(line) ?? new Set<number>();
      pagesForLine.add(page.pageNumber);
      linePages.set(line, pagesForLine);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.3));
  return new Set(
    [...linePages.entries()].filter(([, pageNumbers]) => pageNumbers.size >= threshold).map(([line]) => line),
  );
}

function pageBlocks(page: SourcePage, repeatedLines: ReadonlySet<string>): Array<{
  kind: SourceBlockKind;
  text: string;
  headingLevel: number | null;
}> {
  const lines = page.text.replace(/\r\n?/gu, "\n").split("\n");
  const result: Array<{ kind: SourceBlockKind; text: string; headingLevel: number | null }> = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const pushText = (kind: SourceBlockKind, rawText: string, level: number | null = null) => {
    const text = kind === "code" ? rawText.trim() : normalizeSourceText(rawText);
    if (!text) return;
    for (const part of splitLongText(text)) result.push({ kind, text: part, headingLevel: level });
  };
  const flushParagraph = () => {
    if (paragraph.length > 0) pushText("paragraph", paragraph.join(" "));
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      if (code) {
        code.push(rawLine);
        pushText("code", code.join("\n"));
        code = null;
      } else {
        flushParagraph();
        code = [rawLine];
      }
      continue;
    }
    if (code) {
      code.push(rawLine);
      continue;
    }
    if (!line) {
      flushParagraph();
      continue;
    }
    const normalizedLine = normalizeSourceText(line);
    if (repeatedLines.has(normalizedLine)) {
      flushParagraph();
      pushText("paragraph", line);
      continue;
    }
    const level = headingLevel(line);
    if (level !== null) {
      flushParagraph();
      pushText("heading", line, level);
      continue;
    }
    const metadataPrefix = splitMetadataPrefix(normalizedLine);
    if (metadataPrefix) {
      flushParagraph();
      pushText("paragraph", metadataPrefix.notice);
      paragraph.push(metadataPrefix.remainder);
      continue;
    }
    if (classifyStandaloneSourceText(normalizedLine)) {
      flushParagraph();
      pushText("paragraph", line);
      continue;
    }
    paragraph.push(line);
  }
  if (code) pushText("code", code.join("\n"));
  flushParagraph();
  return result;
}

export function intakeSource(rawPages: SourcePage[]): SourceIntake {
  const pages = SourcePageSchema.array().min(1).max(MAX_SOURCE_PAGES).parse(rawPages);
  const pageNumbers = pages.map((page) => page.pageNumber);
  if (new Set(pageNumbers).size !== pageNumbers.length) {
    throw new Error("pageNumber values must be unique");
  }
  if (pageNumbers.some((pageNumber, index) => index > 0 && pageNumber <= pageNumbers[index - 1]!)) {
    throw new Error("pages must be ordered by pageNumber");
  }
  const characterCount = pages.reduce((total, page) => total + page.text.length, 0);
  if (characterCount > MAX_SOURCE_CHARACTERS) {
    throw new RangeError(`Source text cannot exceed ${MAX_SOURCE_CHARACTERS} characters`);
  }

  const repeatedLines = repeatedPageLines(pages);
  const extracted = pages.flatMap((page) =>
    pageBlocks(page, repeatedLines).map((block) => ({ ...block, pageNumber: page.pageNumber })),
  );
  const contents: SourceBlockContent[] = extracted.map((block, blockIndex) =>
    SourceBlockContentSchema.parse({
      pageNumber: block.pageNumber,
      kind: block.kind,
      text: block.text,
      blockIndex,
    }),
  );

  if (contents.length === 0) throw new Error("Source material did not contain any readable text");
  const blocks = contents.map((content, index) =>
    SourceBlockSchema.parse({
      ...content,
      headingLevel: extracted[index]?.headingLevel ?? null,
      blockHash: hashSourceBlockV2(content),
    }),
  );
  return {
    sourceHash: hashSourceBlocksV2(blocks),
    pageCount: pages.length,
    characterCount,
    blocks,
  };
}
