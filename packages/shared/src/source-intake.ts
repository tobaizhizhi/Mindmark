import { normalizeSourceText } from "./citations.js";
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
  if (markdown) return markdown[1]!.length;
  const chinese = /^第[0-9一二三四五六七八九十百]+([章节篇部单元])\s*\S*/u.exec(line);
  if (chinese) return chinese[1] === "节" ? 2 : 1;
  const english = /^(chapter|unit|part|section)\s+[0-9ivxlcdm]+(?:\s*[:：.-]\s*|\s+)\S*/iu.exec(line);
  if (english) return english[1]!.toLowerCase() === "section" ? 2 : 1;
  const numbered = /^(\d+(?:\.\d+){0,3})[.)、:：\s]+\S+/u.exec(line);
  return numbered ? numbered[1]!.split(".").length : null;
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

function pageBlocks(page: SourcePage): Array<{
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
    const level = headingLevel(line);
    if (level !== null) {
      flushParagraph();
      pushText("heading", line, level);
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

  const extracted = pages.flatMap((page) =>
    pageBlocks(page).map((block) => ({ ...block, pageNumber: page.pageNumber })),
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
