import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "fixtures/reentrancy-source.json");
const pdfPath = path.join(root, "fixtures/reentrancy.pdf");
const pagesPath = path.join(root, "fixtures/reentrancy-pages.json");

const source = JSON.parse(await readFile(sourcePath, "utf8"));

function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/u);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);
    line = word;
  }

  if (line) lines.push(line);
  return lines;
}

const document = await PDFDocument.create();
document.setTitle(source.title);
document.setAuthor("Mindmark Hackathon Team");
document.setSubject(source.goal);
document.setCreator("Mindmark deterministic fixture generator");
document.setProducer("pdf-lib 1.17.1");
document.setCreationDate(new Date(0));
document.setModificationDate(new Date(0));

const regular = await document.embedFont(StandardFonts.Helvetica);
const bold = await document.embedFont(StandardFonts.HelveticaBold);
const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 54;

for (const [index, pageSource] of source.pages.entries()) {
  const page = document.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  page.drawText(pageSource.title, {
    x: margin,
    y,
    font: bold,
    size: 18,
    color: rgb(0.08, 0.12, 0.18),
  });
  y -= 38;

  for (const paragraph of pageSource.paragraphs) {
    for (const line of wrapText(paragraph, regular, 11, pageWidth - margin * 2)) {
      page.drawText(line, {
        x: margin,
        y,
        font: regular,
        size: 11,
        color: rgb(0.12, 0.14, 0.18),
      });
      y -= 16;
    }
    y -= 12;
  }

  if (y < 72) {
    throw new Error(`Fixture page ${index + 1} overflows the printable area`);
  }

  page.drawText(`Page ${index + 1} of ${source.pages.length}`, {
    x: margin,
    y: 34,
    font: regular,
    size: 9,
    color: rgb(0.35, 0.38, 0.42),
  });
}

const pdfBytes = await document.save({ useObjectStreams: false });
await writeFile(pdfPath, pdfBytes);

function normalizeText(value) {
  return value.replace(/\s+/gu, " ").trim();
}

const loadingTask = getDocument({
  data: pdfBytes,
  standardFontDataUrl: `${path.join(root, "node_modules/pdfjs-dist/standard_fonts")}${path.sep}`,
});
const loaded = await loadingTask.promise;
const pages = [];

for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
  const page = await loaded.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items
    .filter((item) => "str" in item)
    .map((item) => item.str)
    .filter((item) => !/^Page \d+ of \d+$/u.test(item));

  pages.push({ pageNumber, text: normalizeText(text.join(" ")) });
}

await loadingTask.destroy();

await writeFile(
  pagesPath,
  `${JSON.stringify(
    {
      title: source.title,
      goal: source.goal,
      extraction: {
        engine: "pdfjs-dist/legacy/build/pdf.mjs",
        normalization: "collapse-whitespace-and-remove-page-footer",
      },
      pages,
    },
    null,
    2,
  )}\n`,
);

console.log(`Generated ${path.relative(root, pdfPath)} and ${path.relative(root, pagesPath)}`);
