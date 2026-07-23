import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import {
  KnowledgeCardContentSchema,
  SourcePageSchema,
  normalizeSourceText,
  validateCitation,
} from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function extractPages(): Promise<Array<{ pageNumber: number; text: string }>> {
  const bytes = new Uint8Array(await readFile(path.join(root, "fixtures/reentrancy.pdf")));
  const loadingTask = getDocument({
    data: bytes,
    standardFontDataUrl: `${path.join(root, "node_modules/pdfjs-dist/standard_fonts")}${path.sep}`,
  });
  const document = await loadingTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item) => "str" in item)
      .map((item) => item.str)
      .filter((item) => !/^Page \d+ of \d+$/u.test(item));
    pages.push({ pageNumber, text: normalizeSourceText(text.join(" ")) });
  }

  await loadingTask.destroy();
  return pages;
}

describe("Step 0 demo fixtures", () => {
  it("extracts the same eight pages on every run", async () => {
    const expectedFixture = JSON.parse(
      await readFile(path.join(root, "fixtures/reentrancy-pages.json"), "utf8"),
    ) as { pages: unknown };
    const expected = SourcePageSchema.array().parse(expectedFixture.pages);

    expect(expected).toHaveLength(8);
    expect(await extractPages()).toEqual(expected);
  });

  it("keeps the three semantic ranges meaningful", async () => {
    const fixture = JSON.parse(
      await readFile(path.join(root, "fixtures/reentrancy-pages.json"), "utf8"),
    ) as { pages: unknown };
    const pages = SourcePageSchema.array().parse(fixture.pages);
    const ranges = [pages.slice(0, 3), pages.slice(3, 6), pages.slice(6, 8)];

    expect(ranges.map((range) => range.length)).toEqual([3, 3, 2]);
    expect(ranges[0]?.join(" ")).toBeDefined();
    expect(ranges[0]!.map((page) => page.text).join(" ")).toContain("exploit");
    expect(ranges[1]!.map((page) => page.text).join(" ")).toContain(
      "Checks-Effects-Interactions",
    );
    expect(ranges[2]!.map((page) => page.text).join(" ")).toContain("invariant tests");
  });

  it("detects out-of-range pages and fabricated quotes", async () => {
    const pagesFixture = JSON.parse(
      await readFile(path.join(root, "fixtures/reentrancy-pages.json"), "utf8"),
    ) as { pages: unknown };
    const invalidFixture = JSON.parse(
      await readFile(path.join(root, "fixtures/invalid-citations.json"), "utf8"),
    ) as {
      cases: Array<{
        source: { page: number; quote: string };
        expectedError: "page_out_of_range" | "quote_not_found";
      }>;
    };
    const pages = SourcePageSchema.array().parse(pagesFixture.pages);

    for (const invalidCase of invalidFixture.cases) {
      const card = KnowledgeCardContentSchema.parse({
        type: "qa",
        question: "Invalid fixture",
        answer: "This card is expected to fail citation validation.",
        keyPoint: "Citation errors must be deterministic.",
        source: invalidCase.source,
        tags: ["fixture"],
        importance: 1,
        initialDifficulty: 1,
      });
      expect(validateCitation(card, pages)).toEqual({
        valid: false,
        error: invalidCase.expectedError,
      });
    }
  });
});
