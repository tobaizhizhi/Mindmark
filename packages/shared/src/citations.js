export function normalizeSourceText(value) {
    return value.replace(/\s+/gu, " ").trim();
}
export function validateCitation(card, pages) {
    const page = pages.find((candidate) => candidate.pageNumber === card.source.page);
    if (!page)
        return { valid: false, error: "page_out_of_range" };
    const pageText = normalizeSourceText(page.text);
    const quote = normalizeSourceText(card.source.quote);
    if (!pageText.includes(quote))
        return { valid: false, error: "quote_not_found" };
    return { valid: true };
}
//# sourceMappingURL=citations.js.map