import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPdfSourcePages } from "@/lib/client/pdf-source";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("PDF source intake", () => {
  it("extracts ordered source pages for the V2 project intake", async () => {
    const bytes = new Uint8Array(
      await readFile(path.join(root, "fixtures/reentrancy.pdf")),
    );

    const pages = await extractPdfSourcePages(bytes);

    expect(pages).toHaveLength(8);
    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pages[0]?.text).toContain("Reentrancy");
    expect(pages[7]?.text).toContain("invariant tests");
  });
});
