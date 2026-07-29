import {
  MAX_SOURCE_CHARACTERS,
  MAX_SOURCE_PAGES,
  type SourcePage,
} from "@mindmark/shared";

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

type PdfTextItem = {
  str: string;
  hasEOL?: boolean;
  transform?: unknown[];
};

function normalizePageText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function isPdfTextItem(value: unknown): value is PdfTextItem {
  return Boolean(
    value &&
    typeof value === "object" &&
    "str" in value &&
    typeof (value as { str?: unknown }).str === "string",
  );
}

function pdfItemsToText(items: readonly unknown[]): string {
  let output = "";
  let previousY: number | null = null;

  for (const item of items) {
    if (!isPdfTextItem(item)) continue;
    const y = Array.isArray(item.transform) && typeof item.transform[5] === "number"
      ? item.transform[5]
      : null;
    if (previousY !== null && y !== null && Math.abs(previousY - y) > 2.5) {
      output = output.trimEnd() + "\n";
    }
    output += item.str;
    if (item.hasEOL === true) {
      output = output.trimEnd() + "\n";
      previousY = null;
    } else {
      output += " ";
      previousY = y;
    }
  }

  return output;
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

export async function extractPdfSourcePages(
  source: ArrayBuffer | Uint8Array,
): Promise<SourcePage[]> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("PDF 不能超过 15 MB");
  if (!hasPdfSignature(bytes)) throw new Error("所选文件不是有效的 PDF");

  const pdfjs = typeof window === "undefined"
    ? await import("pdfjs-dist/legacy/build/pdf.mjs")
    : await import("pdfjs-dist");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }

  const loadingTask = pdfjs.getDocument({ data: bytes });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > MAX_SOURCE_PAGES) {
      throw new Error(`PDF 不能超过 ${MAX_SOURCE_PAGES} 页`);
    }

    const pages: SourcePage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizePageText(pdfItemsToText(content.items));
      if (text) pages.push({ pageNumber, text });
      page.cleanup();
    }

    const totalCharacters = pages.reduce((total, page) => total + page.text.length, 0);
    if (totalCharacters === 0) {
      throw new Error("这个 PDF 没有可提取的文字；扫描件请先做 OCR，或改用粘贴文本");
    }
    if (totalCharacters > MAX_SOURCE_CHARACTERS) {
      throw new Error(`提取文本不能超过 ${MAX_SOURCE_CHARACTERS.toLocaleString()} 字符`);
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

export async function extractPdfFile(file: File): Promise<SourcePage[]> {
  if (file.size > MAX_PDF_BYTES) throw new Error("PDF 不能超过 15 MB");
  return extractPdfSourcePages(await file.arrayBuffer());
}
