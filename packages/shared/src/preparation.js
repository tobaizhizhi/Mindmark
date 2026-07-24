import { buildChunkManifest } from "./merkle.js";
import { PrepareJourneyRequestSchema, MAX_SOURCE_CHUNKS, SourcePageSchema, SourceChunkContentSchema, } from "./schemas.js";
import { hashGoal, hashSourceChunk, hashSourcePages } from "./hash.js";
import { normalizeSourceText } from "./citations.js";
function selectChunkCount(pageCount, totalCharacters, chapterCount = 0) {
    const byPages = Math.ceil((pageCount + 1) / 3);
    const byCharacters = totalCharacters >= 12_000
        ? Math.max(4, Math.ceil(totalCharacters / 6_000))
        : totalCharacters >= 4_500
            ? 3
            : 2;
    return Math.min(MAX_SOURCE_CHUNKS, Math.max(2, byPages, byCharacters, chapterCount));
}
function splitIntoUnits(request, desiredCount) {
    if (request.pages.length >= desiredCount) {
        return request.pages.map((page) => ({
            pageNumber: page.pageNumber,
            text: normalizeSourceText(page.text),
            chapterTitle: null,
        }));
    }
    return request.pages.flatMap((page) => {
        const paragraphs = page.text
            .split(/\n{2,}/u)
            .map(normalizeSourceText)
            .filter(Boolean);
        const candidates = paragraphs.length >= desiredCount
            ? paragraphs
            : normalizeSourceText(page.text)
                .split(/(?<=[.!?。！？])\s+/u)
                .map(normalizeSourceText)
                .filter(Boolean);
        return candidates.map((text) => ({
            pageNumber: page.pageNumber,
            text,
            chapterTitle: null,
        }));
    });
}
function isChapterHeading(value) {
    const line = normalizeSourceText(value);
    if (line.length < 2 || line.length > 120)
        return false;
    return (/^第[0-9一二三四五六七八九十百]+[章节篇部单元]\s*\S*/u.test(line) ||
        /^(?:chapter|unit|part|section)\s+[0-9ivxlcdm]+(?:\s*[:：.-]\s*|\s+)\S*/iu.test(line) ||
        /^\d+(?:\.\d+){0,3}[.)、:：\s]+\S+/u.test(line) ||
        (/^[A-Z][A-Z\d\s:&-]{4,}$/u.test(line) && line.includes(" ")));
}
function chapterSections(request) {
    const sections = [];
    let current = null;
    let foundHeading = false;
    for (const page of request.pages) {
        const lines = page.text
            .split(/\n+/u)
            .map(normalizeSourceText)
            .filter(Boolean);
        for (const line of lines) {
            if (isChapterHeading(line)) {
                foundHeading = true;
                if (current?.units.length)
                    sections.push(current);
                current = { title: line, units: [] };
            }
            current ??= { title: null, units: [] };
            current.units.push({
                pageNumber: page.pageNumber,
                text: line,
                chapterTitle: current.title,
            });
        }
    }
    if (current?.units.length)
        sections.push(current);
    return foundHeading && sections.reduce((total, section) => total + section.units.length, 0) >= 2
        ? sections
        : null;
}
function partitionUnits(units, count) {
    if (units.length < count) {
        throw new Error("Source material is too short to create two meaningful chunks");
    }
    const groups = [];
    let cursor = 0;
    let remainingCharacters = units.reduce((total, unit) => total + unit.text.length, 0);
    for (let groupIndex = 0; groupIndex < count; groupIndex += 1) {
        const remainingGroups = count - groupIndex;
        const targetCharacters = remainingCharacters / remainingGroups;
        const group = [];
        let groupCharacters = 0;
        while (cursor < units.length) {
            const unitsAfterCandidate = units.length - (cursor + 1);
            const groupsAfterCurrent = remainingGroups - 1;
            const unit = units[cursor];
            group.push(unit);
            groupCharacters += unit.text.length;
            cursor += 1;
            if (groupCharacters >= targetCharacters &&
                unitsAfterCandidate >= groupsAfterCurrent) {
                break;
            }
            if (unitsAfterCandidate === groupsAfterCurrent)
                break;
        }
        groups.push(group);
        remainingCharacters -= groupCharacters;
    }
    return groups;
}
function partitionChapterSections(sections, desiredCount) {
    const totalCharacters = sections.reduce((total, section) => total + section.units.reduce((sum, unit) => sum + unit.text.length, 0), 0);
    const targetCharacters = totalCharacters / desiredCount;
    const groups = sections.flatMap((section) => {
        const sectionCharacters = section.units.reduce((total, unit) => total + unit.text.length, 0);
        const partCount = Math.min(section.units.length, Math.max(1, Math.round(sectionCharacters / targetCharacters)));
        return partitionUnits(section.units, partCount).map((units) => ({
            chapterTitles: section.title ? [section.title] : [],
            units,
        }));
    });
    while (groups.length < desiredCount) {
        const targetIndex = groups.reduce((largestIndex, group, index) => {
            if (group.units.length < 2)
                return largestIndex;
            if (largestIndex < 0)
                return index;
            const size = group.units.reduce((total, unit) => total + unit.text.length, 0);
            const largestSize = groups[largestIndex].units.reduce((total, unit) => total + unit.text.length, 0);
            return size > largestSize ? index : largestIndex;
        }, -1);
        if (targetIndex < 0)
            break;
        const target = groups[targetIndex];
        const [left, right] = partitionUnits(target.units, 2);
        groups.splice(targetIndex, 1, { chapterTitles: target.chapterTitles, units: left }, { chapterTitles: target.chapterTitles, units: right });
    }
    while (groups.length > desiredCount) {
        let targetIndex = 0;
        let targetScore = Number.POSITIVE_INFINITY;
        for (let index = 0; index < groups.length - 1; index += 1) {
            const left = groups[index];
            const right = groups[index + 1];
            const sameChapter = left.chapterTitles.join(" / ") === right.chapterTitles.join(" / ");
            const characters = [...left.units, ...right.units].reduce((total, unit) => total + unit.text.length, 0);
            const score = characters + (sameChapter ? 0 : totalCharacters);
            if (score < targetScore) {
                targetIndex = index;
                targetScore = score;
            }
        }
        const left = groups[targetIndex];
        const right = groups[targetIndex + 1];
        groups.splice(targetIndex, 2, {
            chapterTitles: [...new Set([...left.chapterTitles, ...right.chapterTitles])],
            units: [...left.units, ...right.units],
        });
    }
    return groups;
}
function titleFor(text, chunkId) {
    const firstSentence = text.split(/(?<=[.!?。！？])\s+/u)[0] ?? text;
    const normalized = normalizeSourceText(firstSentence).replace(/^\d+[.)]\s*/u, "");
    const shortened = normalized.length > 72 ? `${normalized.slice(0, 69).trim()}...` : normalized;
    return shortened || `Knowledge section ${chunkId + 1}`;
}
function allocateCardBudgets(characterCounts) {
    const totalCharacters = characterCounts.reduce((total, count) => total + count, 0);
    const desiredTotal = Math.max(4, Math.min(30, Math.round(totalCharacters / 420)));
    const effectiveTotal = Math.max(desiredTotal, characterCounts.length);
    const raw = characterCounts.map((count) => (count / totalCharacters) * effectiveTotal);
    const budgets = raw.map((value) => Math.max(1, Math.floor(value)));
    let allocated = budgets.reduce((total, budget) => total + budget, 0);
    const priority = raw
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
    while (allocated < effectiveTotal) {
        const target = priority[allocated % priority.length];
        budgets[target.index] = budgets[target.index] + 1;
        allocated += 1;
    }
    while (allocated > effectiveTotal) {
        const target = [...priority].reverse().find((item) => budgets[item.index] > 1);
        if (!target)
            break;
        budgets[target.index] = budgets[target.index] - 1;
        allocated -= 1;
    }
    return budgets;
}
export function prepareJourney(rawRequest, journeyId) {
    const request = PrepareJourneyRequestSchema.parse(rawRequest);
    const pages = request.pages.map((page) => ({
        ...page,
        text: normalizeSourceText(page.text),
    }));
    const totalCharacters = pages.reduce((total, page) => total + page.text.length, 0);
    const chapters = chapterSections(request);
    const units = chapters
        ? chapters.flatMap((section) => section.units)
        : splitIntoUnits(request, selectChunkCount(pages.length, totalCharacters));
    const desiredCount = Math.min(selectChunkCount(pages.length, totalCharacters, chapters?.length ?? 0), units.length);
    const groups = chapters
        ? partitionChapterSections(chapters, desiredCount)
        : partitionUnits(units, desiredCount).map((group) => ({ chapterTitles: [], units: group }));
    const chunkCount = groups.length;
    const titleTotals = new Map();
    for (const group of groups) {
        const key = group.chapterTitles.join(" / ");
        if (key)
            titleTotals.set(key, (titleTotals.get(key) ?? 0) + 1);
    }
    const titleIndexes = new Map();
    const contents = groups.map((group, chunkId) => {
        const text = group.units.map((unit) => unit.text).join("\n\n");
        const chapterKey = group.chapterTitles.join(" / ");
        const chapterPart = chapterKey ? (titleIndexes.get(chapterKey) ?? 0) + 1 : 0;
        if (chapterKey)
            titleIndexes.set(chapterKey, chapterPart);
        const rawTitle = chapterKey
            ? (titleTotals.get(chapterKey) ?? 1) > 1
                ? `${chapterKey} · 分段 ${chapterPart}/${titleTotals.get(chapterKey)}`
                : chapterKey
            : titleFor(text, chunkId);
        return SourceChunkContentSchema.parse({
            chunkId,
            pageStart: Math.min(...group.units.map((unit) => unit.pageNumber)),
            pageEnd: Math.max(...group.units.map((unit) => unit.pageNumber)),
            title: rawTitle.length > 200 ? `${rawTitle.slice(0, 197).trim()}...` : rawTitle,
            text,
        });
    });
    const sourcePagesByChunk = groups.map((group) => {
        const pageNumbers = [...new Set(group.units.map((unit) => unit.pageNumber))];
        return SourcePageSchema.array().parse(pageNumbers.map((pageNumber) => ({
            pageNumber,
            text: group.units
                .filter((unit) => unit.pageNumber === pageNumber)
                .map((unit) => unit.text)
                .join(" "),
        })));
    });
    const budgets = allocateCardBudgets(contents.map((content) => content.text.length));
    const hashes = contents.map((content) => hashSourceChunk(content));
    const manifest = buildChunkManifest(journeyId, contents.map((content, index) => ({
        chunkId: content.chunkId,
        sourceChunkHash: hashes[index],
    })));
    return {
        journeyId,
        sourceHash: hashSourcePages(pages),
        goalHash: hashGoal(request.goal ?? ""),
        chunkManifestRoot: manifest.root,
        chunkCount,
        chunks: contents.map((content, index) => ({
            content,
            sourcePages: sourcePagesByChunk[index],
            sourceChunkHash: hashes[index],
            manifestProof: manifest.chunks[index].proof,
            cardBudget: budgets[index],
        })),
    };
}
//# sourceMappingURL=preparation.js.map