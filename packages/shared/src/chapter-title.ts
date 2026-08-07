const MAX_CHAPTER_TITLE_CHARACTERS = 64;
const CHINESE_NUMBER = "零〇一二三四五六七八九十百千万两";

/** Converts source and model headings into one learner-facing title format. */
export function normalizeChapterTitle(rawTitle: string): string {
  let title = rawTitle.normalize("NFKC").trim();
  const markdownWrapper = /^(?:\*{1,3}|_{1,3})(.+?)(?:\*{1,3}|_{1,3})$/u.exec(title);
  if (markdownWrapper) title = markdownWrapper[1]!.trim();
  title = title
    .replace(/^#{1,6}\s*/u, "")
    .replace(
      new RegExp(`^第\\s*[0-9${CHINESE_NUMBER}]+\\s*(?:章|节|篇|部|单元)\\s*(?:[·:：.\\-—–]\\s*)?`, "u"),
      "",
    )
    .replace(/^(?:chapter|unit|part|section)\s+[0-9ivxlcdm]+\s*(?:[·:：.\-—–]\s*)?/iu, "")
    .replace(
      new RegExp(`^(?:[（(]\\s*)?(?:\\d+(?:\\.\\d+){0,3}|[${CHINESE_NUMBER}]+)\\s*(?:[）)]|[.)、:：])\\s*`, "u"),
      "",
    )
    .replace(/^\d+(?:\.\d+){0,3}\s+(?=[\p{L}\p{Script=Han}])/u, "")
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/\s+/gu, " ")
    .replace(/^[·:：.\-—–\s]+|[。！？!?；;：:、·\s]+$/gu, "")
    .trim();
  if (/[\p{Script=Han}]/u.test(title)) {
    title = title.replace(/\s*\(\s*/gu, "（").replace(/\s*\)\s*/gu, "）");
  }
  return title;
}

export function chapterTitleQualityIssues(rawTitle: string): string[] {
  const title = normalizeChapterTitle(rawTitle);
  const issues: string[] = [];
  if (title.length < 2) issues.push("Chapter title must contain a specific learning topic");
  if (title.length > MAX_CHAPTER_TITLE_CHARACTERS) {
    issues.push(`Chapter title must not exceed ${MAX_CHAPTER_TITLE_CHARACTERS} characters`);
  }
  if (/\d+(?:\s*[+\-−×÷=]\s*\d+)+/u.test(title)) {
    issues.push("Chapter title must not be an arithmetic expression or worked-example fragment");
  }
  if (/[。！？!?；;]/u.test(title)) {
    issues.push("Chapter title must be a concise topic, not a sentence");
  }
  if (
    title.length > 16
    && /(?:^|[，,）)]\s*)(?:此时|这时|因此|所以|故|应该|应当|可知|表示)/u.test(title)
  ) {
    issues.push("Chapter title must not contain explanatory sentence wording");
  }
  const latinWords = title.match(/[A-Za-z][A-Za-z0-9_-]*/gu) ?? [];
  if (!/[\p{Script=Han}]/u.test(title) && latinWords.length > 12) {
    issues.push("Chapter title must use at most 12 words");
  }
  return issues;
}

export function isUsableChapterTitle(rawTitle: string): boolean {
  return chapterTitleQualityIssues(rawTitle).length === 0;
}
