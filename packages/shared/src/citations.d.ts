import type { KnowledgeCardContent, SourcePage } from "./schemas.js";
export type CitationError = "page_out_of_range" | "quote_not_found";
export declare function normalizeSourceText(value: string): string;
export declare function validateCitation(card: KnowledgeCardContent, pages: SourcePage[]): {
    valid: true;
} | {
    valid: false;
    error: CitationError;
};
//# sourceMappingURL=citations.d.ts.map