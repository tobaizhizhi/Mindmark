import { normalizeSourceText } from "./citations.js";
import {
  SourceBlockSchema,
  SourceExclusionRangeListSchema,
  type SourceBlock,
  type SourceExclusionCategory,
  type SourceExclusionRange,
} from "./project-v2.js";

type ClassifiedBlock = {
  blockIndex: number;
  category: SourceExclusionCategory;
  reason: string;
};

export type SourceTextExclusion = Omit<ClassifiedBlock, "blockIndex">;

const SECTION_SCOPED_CATEGORIES = new Set<SourceExclusionCategory>([
  "TABLE_OF_CONTENTS",
  "COPYRIGHT",
  "PROMOTIONAL",
  "ADMINISTRATIVE",
  "EXAM_UPDATE",
  "VERSION_NOTICE",
  "SCHEDULE_NOTICE",
]);

function normalizedKey(value: string): string {
  return normalizeSourceText(value).toLocaleLowerCase();
}

function cleanStructuralPrefix(value: string): string {
  return normalizeSourceText(value).replace(/^#{1,6}\s+/u, "").trim();
}

function normalizedHeadingKey(value: string): string {
  return normalizeSourceText(value)
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^第\s*[0-9一二三四五六七八九十百千万两]+\s*(?:章|节|篇|部|单元)\s*/u, "")
    .replace(/^(?:chapter|unit|part|section)\s+[0-9ivxlcdm]+\s*/iu, "")
    .replace(/^(?:\d+(?:\.\d+){0,3}|[一二三四五六七八九十百千万两]+)\s*[.)、:：）]?\s*/u, "")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase();
}

function implicitContentsPages(blocks: SourceBlock[]): Set<number> {
  const headingsByPage = new Map<number, string[]>();
  for (const block of blocks) {
    if (block.kind !== "heading" || block.headingLevel === null || !isUsableHeading(block.text)) continue;
    const titles = headingsByPage.get(block.pageNumber) ?? [];
    titles.push(normalizedHeadingKey(block.text));
    headingsByPage.set(block.pageNumber, titles);
  }
  const pages = [...new Set(blocks.map((block) => block.pageNumber))].sort((left, right) => left - right);
  const contentsPages = new Set<number>();
  for (const [pageIndex, pageNumber] of pages.entries()) {
    const headings = [...new Set(headingsByPage.get(pageNumber) ?? [])].filter(Boolean);
    if (headings.length < 6) continue;
    const pageBlockCount = blocks.filter((block) => block.pageNumber === pageNumber).length;
    if (headings.length / Math.max(1, pageBlockCount) < 0.3) continue;
    const laterHeadings = new Set(
      pages
        .slice(pageIndex + 1)
        .flatMap((laterPage) => headingsByPage.get(laterPage) ?? []),
    );
    const repeated = headings.filter((heading) => laterHeadings.has(heading)).length;
    if (repeated >= 4 && repeated / headings.length >= 0.5) contentsPages.add(pageNumber);
  }
  return contentsPages;
}

function isUsableHeading(value: string): boolean {
  const text = cleanStructuralPrefix(value);
  return text.length >= 2
    && text.length <= 160
    && !classifyStandaloneSourceText(text)
    && !/[。！？!?；;]/u.test(text)
    && !/^\d+(?:\s*[+\-−×÷=]\s*\d+)+/u.test(text);
}

export function classifyStandaloneSourceText(rawText: string): SourceTextExclusion | null {
  const text = cleanStructuralPrefix(rawText);
  const compact = text.replace(/\s+/gu, "");
  if (/^(?:page\s*)?\d{1,4}(?:\s*[/／-]\s*\d{1,4})?$/iu.test(text)) {
    return { category: "PAGE_NUMBER", reason: "内容仅包含页码" };
  }
  if (/^(?:目\s*录|contents|table\s+of\s+contents)(?:\s*[:：].*)?$/iu.test(text)) {
    return { category: "TABLE_OF_CONTENTS", reason: "内容为目录而非学习知识" };
  }
  if (text.length <= 600 && /(?:版权所有|copyright|未经许可|保留所有权利|免责声明|©|®)/iu.test(text)) {
    return { category: "COPYRIGHT", reason: "内容为版权或免责声明" };
  }
  const examScope = /(?:考\s*纲|考试大纲|大纲|考点|考试范围|考试内容|考试章节|考试科目|命题|题型|分值|考查范围|可考查|参考自|仅作参考|拓展内容)/u.test(compact);
  const changeAction = /(?:变化|变动|改动|改版|调整|更新|修订|增补|新增|增加|删减|删除|移除|取消|趋势)/u.test(compact);
  if (
    text.length <= 600
    && (
      (examScope && changeAction)
      || /(?:新增|增加|删除|移除|取消)(?:考点|考试内容|考试章节)/u.test(compact)
    )
  ) {
    return { category: "EXAM_UPDATE", reason: "内容描述考纲、考点、题型或分值变化" };
  }
  if (
    text.length <= 600
    && /(?:(?:考试|报名|准考证|开课|直播|课程)(?:时间|日期|安排|通知|入口|截止)|(?:报名|考试)(?:开始|截止|开放))/u.test(compact)
  ) {
    return { category: "SCHEDULE_NOTICE", reason: "内容为考试、报名或课程时间安排" };
  }
  if (
    text.length <= 600
    && /(?:(?:版本|课程|资料|讲义)(?:更新|升级|修订|说明|变更)|(?:更新|修订)(?:日志|记录|说明)|(?:\d{2,4}\s*版|v\d+(?:\.\d+)*).*(?:上线|发布|更新)|预计.*上线|即将上线|勘误)/iu.test(compact)
  ) {
    return { category: "VERSION_NOTICE", reason: "内容为资料、课程或版本更新通知" };
  }
  if (
    text.length <= 300
    && /(?:扫码|二维码|关注公众号|点击关注|购买链接|联系(?:客服|作者)|敬请期待)/iu.test(compact)
  ) {
    return { category: "PROMOTIONAL", reason: "内容为宣传或联络信息" };
  }
  if (
    text.length <= 300
    && /^(?:(?:作者|编者|主编|出版社|出版日期|修订日期)\s*[:：]|作者简介|编写说明|出版说明)/u.test(text)
  ) {
    return { category: "ADMINISTRATIVE", reason: "内容为作者、出版或资料管理信息" };
  }
  return null;
}

function classifyBlock(
  block: SourceBlock,
  repeatedAcrossPages: ReadonlySet<string>,
): SourceTextExclusion | null {
  const text = normalizeSourceText(block.text);
  if (text.length <= 200 && repeatedAcrossPages.has(normalizedKey(text))) {
    return {
      category: "REPEATED_HEADER_FOOTER",
      reason: "同一短文本在多个页面重复出现，判定为页眉、页脚或水印",
    };
  }
  return classifyStandaloneSourceText(text);
}

export function validateSourceExclusionRanges(
  rawRanges: SourceExclusionRange[],
  blockCount: number,
): SourceExclusionRange[] {
  const ranges = SourceExclusionRangeListSchema.parse(rawRanges)
    .map((range) => ({ ...range }))
    .sort((left, right) => left.startBlock - right.startBlock || left.endBlock - right.endBlock);
  for (const [index, range] of ranges.entries()) {
    if (range.endBlock >= blockCount) throw new Error("Source exclusion range is outside the Source Block collection");
    if (index > 0 && range.startBlock <= ranges[index - 1]!.endBlock) {
      throw new Error("Source exclusion ranges must not overlap");
    }
  }
  return ranges;
}

export function excludedSourceBlockIndexes(ranges: SourceExclusionRange[]): Set<number> {
  const indexes = new Set<number>();
  for (const range of SourceExclusionRangeListSchema.parse(ranges)) {
    for (let index = range.startBlock; index <= range.endBlock; index += 1) indexes.add(index);
  }
  return indexes;
}

export function filterExcludedSourceBlocks(
  rawBlocks: SourceBlock[],
  rawRanges: SourceExclusionRange[],
): SourceBlock[] {
  const blocks = SourceBlockSchema.array().parse(rawBlocks);
  const excluded = excludedSourceBlockIndexes(rawRanges);
  return blocks.filter((block) => !excluded.has(block.blockIndex));
}

export function mergeSourceExclusionRanges(
  rawProtectedRanges: SourceExclusionRange[],
  rawProposedRanges: SourceExclusionRange[],
  blockCount: number,
): SourceExclusionRange[] {
  const protectedRanges = validateSourceExclusionRanges(rawProtectedRanges, blockCount);
  const proposedRanges = validateSourceExclusionRanges(rawProposedRanges, blockCount);
  const classifications: Array<SourceTextExclusion | null> = Array.from(
    { length: blockCount },
    () => null,
  );
  for (const range of proposedRanges) {
    for (let index = range.startBlock; index <= range.endBlock; index += 1) {
      classifications[index] = { category: range.category, reason: range.reason };
    }
  }
  for (const range of protectedRanges) {
    for (let index = range.startBlock; index <= range.endBlock; index += 1) {
      classifications[index] = { category: range.category, reason: range.reason };
    }
  }
  const ranges: SourceExclusionRange[] = [];
  for (const [blockIndex, classification] of classifications.entries()) {
    if (!classification) continue;
    const previous = ranges.at(-1);
    if (
      previous
      && previous.endBlock + 1 === blockIndex
      && previous.category === classification.category
      && previous.reason === classification.reason
    ) {
      previous.endBlock = blockIndex;
    } else {
      ranges.push({
        startBlock: blockIndex,
        endBlock: blockIndex,
        category: classification.category,
        reason: classification.reason,
      });
    }
  }
  return validateSourceExclusionRanges(ranges, blockCount);
}

export function classifySourceExclusions(rawBlocks: SourceBlock[]): SourceExclusionRange[] {
  const blocks = SourceBlockSchema.array().min(1).parse(rawBlocks);
  const contentsPages = implicitContentsPages(blocks);
  const pageCount = new Set(blocks.map((block) => block.pageNumber)).size;
  const repeatedThreshold = pageCount >= 3 ? Math.max(2, Math.ceil(pageCount * 0.3)) : 3;
  const textPages = new Map<string, Set<number>>();
  for (const block of blocks) {
    const key = normalizedKey(block.text);
    const pages = textPages.get(key) ?? new Set<number>();
    pages.add(block.pageNumber);
    textPages.set(key, pages);
  }
  const repeatedAcrossPages = new Set(
    [...textPages.entries()]
      .filter(([key, pages]) => key.length > 0 && key.length <= 200 && pages.size >= repeatedThreshold)
      .map(([key]) => key),
  );
  const classified: ClassifiedBlock[] = [];
  let activeSection: { headingLevel: number; classification: SourceTextExclusion } | null = null;
  let previousPage: number | null = null;
  for (const block of blocks) {
    if (previousPage !== null && block.pageNumber !== previousPage && contentsPages.has(previousPage)) {
      activeSection = null;
    }
    previousPage = block.pageNumber;
    if (contentsPages.has(block.pageNumber)) {
      classified.push({
        blockIndex: block.blockIndex,
        category: "TABLE_OF_CONTENTS",
        reason: "页面密集列出后文重复标题，判定为隐式目录页",
      });
      continue;
    }
    if (
      block.kind === "heading"
      && block.headingLevel !== null
      && activeSection
      && block.headingLevel <= activeSection.headingLevel
    ) {
      activeSection = null;
    }
    const direct = classifyBlock(block, repeatedAcrossPages);
    if (
      block.kind === "heading"
      && block.headingLevel !== null
      && direct
      && SECTION_SCOPED_CATEGORIES.has(direct.category)
    ) {
      activeSection = { headingLevel: block.headingLevel, classification: direct };
    }
    const classification = direct ?? activeSection?.classification ?? null;
    if (classification) classified.push({ blockIndex: block.blockIndex, ...classification });
  }
  const ranges: SourceExclusionRange[] = [];
  for (const block of classified) {
    const previous = ranges.at(-1);
    if (
      previous
      && previous.endBlock + 1 === block.blockIndex
      && previous.category === block.category
      && previous.reason === block.reason
    ) {
      previous.endBlock = block.blockIndex;
    } else {
      ranges.push({
        startBlock: block.blockIndex,
        endBlock: block.blockIndex,
        category: block.category,
        reason: block.reason,
      });
    }
  }
  return validateSourceExclusionRanges(ranges, blocks.length);
}
