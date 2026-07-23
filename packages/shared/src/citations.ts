import type { KnowledgeCardContent, SourcePage } from "./schemas.js";

export type CitationError = "page_out_of_range" | "quote_not_found";

export function normalizeSourceText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function validateCitation(
  card: KnowledgeCardContent,
  pages: SourcePage[],
): { valid: true } | { valid: false; error: CitationError } {
  const page = pages.find((candidate) => candidate.pageNumber === card.source.page);
  if (!page) return { valid: false, error: "page_out_of_range" };

  const pageText = normalizeSourceText(page.text);
  const quote = normalizeSourceText(card.source.quote);
  if (!pageText.includes(quote)) return { valid: false, error: "quote_not_found" };

  return { valid: true };
}

