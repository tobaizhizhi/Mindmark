import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PackChapterSchema,
  PackManifestSchema,
  PackReadingBlockSchema,
  type PackChapter,
  type PackReadingBlock,
} from "../packages/shared/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "content/card-packs/solidity-foundations/v4");
const targetDir = path.join(root, "content/card-packs/solidity-foundations/v5");

async function json(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function makeBlocks(chapter: PackChapter): PackReadingBlock[] {
  const blocks: PackReadingBlock[] = [
    { blockId: `${chapter.slug}-title`, position: 0, kind: "heading", text: chapter.title },
    { blockId: `${chapter.slug}-overview`, position: 1, kind: "paragraph", text: chapter.summary },
    {
      blockId: `${chapter.slug}-stage`,
      position: 2,
      kind: "callout",
      text: `${chapter.stageTitle ?? "本章学习"}。练习重点：${chapter.practiceFocus ?? "先理解概念，再动手验证。"}`,
    },
    {
      blockId: `${chapter.slug}-objectives`,
      position: 3,
      kind: "heading",
      text: "本章学习目标",
    },
    {
      blockId: `${chapter.slug}-objective-text`,
      position: 4,
      kind: "paragraph",
      text: (chapter.learningObjectives ?? []).map((item, index) => `${index + 1}. ${item}`).join("\n"),
    },
    {
      blockId: `${chapter.slug}-concepts`,
      position: 5,
      kind: "heading",
      text: "关键概念",
    },
    {
      blockId: `${chapter.slug}-concept-text`,
      position: 6,
      kind: "paragraph",
      text: `本章引入：${(chapter.newConcepts ?? []).join("、")}。${chapter.projectMilestone ?? "完成本章后，回到 LearningRegistry 检查状态变化。"}`,
    },
  ];
  const codeCards = chapter.cards.filter((card) => card.code);
  for (const [index, card] of codeCards.entries()) {
    blocks.push({
      blockId: `${chapter.slug}-code-${index + 1}`,
      position: blocks.length,
      kind: "code",
      language: "solidity",
      text: card.code?.starterCode ?? card.code?.solutionCode ?? "",
    });
  }
  blocks.push(
    { blockId: `${chapter.slug}-practice`, position: blocks.length, kind: "heading", text: "迁移练习" },
    {
      blockId: `${chapter.slug}-practice-text`,
      position: blocks.length + 1,
      kind: "paragraph",
      text: `${chapter.practiceFocus ?? "结合本章概念完成练习。"}\n项目里程碑：${chapter.projectMilestone ?? "让 LearningRegistry 保持可观察、可测试。"}`,
    },
  );
  return blocks.map((block) => PackReadingBlockSchema.parse(block));
}

function attachAnchors(chapter: PackChapter, blocks: PackReadingBlock[]): PackChapter {
  const conceptBlock = `${chapter.slug}-concept-text`;
  const practiceBlock = `${chapter.slug}-practice-text`;
  const codeBlockIds = blocks.filter((block) => block.kind === "code").map((block) => block.blockId);
  let codeIndex = 0;
  return {
    ...chapter,
    readingBlocks: blocks,
    cards: chapter.cards.map((card) => {
      const readingBlockId = card.code ? codeBlockIds[codeIndex++] : card.type === "application" || card.type === "misconception" ? practiceBlock : conceptBlock;
      return { ...card, packCardId: `v5-${card.packCardId}`, readingBlockId };
    }),
  };
}

async function main() {
  const sourceManifest = PackManifestSchema.parse(await json(path.join(sourceDir, "manifest.json")));
  const sourceChapters = await Promise.all(sourceManifest.chapters.map(async (entry) => (
    PackChapterSchema.parse(await json(path.join(sourceDir, entry.cardsFile)))
  )));
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.join(targetDir, "chapters"), { recursive: true });

  const chapters = sourceChapters.map((chapter) => attachAnchors(chapter, makeBlocks(chapter)));
  const manifestChapters = chapters.map((chapter) => ({
    id: chapter.chapterId,
    position: chapter.position,
    slug: chapter.slug,
    title: chapter.title,
    summary: chapter.summary,
    estimatedMinutes: chapter.estimatedMinutes,
    learningObjectives: chapter.learningObjectives,
    prerequisiteChapterIds: chapter.prerequisiteChapterIds,
    stageId: chapter.stageId,
    stageTitle: chapter.stageTitle,
    newConcepts: chapter.newConcepts,
    prerequisiteConcepts: chapter.prerequisiteConcepts,
    practiceFocus: chapter.practiceFocus,
    projectMilestone: chapter.projectMilestone,
    readingBlocks: chapter.readingBlocks,
    cardCount: chapter.cards.length,
    cardsFile: `chapters/${String(chapter.position + 1).padStart(2, "0")}-${chapter.slug}.json`,
  }));
  for (const chapter of chapters) {
    const filename = `${String(chapter.position + 1).padStart(2, "0")}-${chapter.slug}.json`;
    await writeFile(path.join(targetDir, "chapters", filename), `${JSON.stringify(chapter, null, 2)}\n`, "utf8");
  }
  const manifest = {
    schemaVersion: 1,
    slug: sourceManifest.slug,
    version: "5.0.0",
    title: sourceManifest.title,
    description: "Solidity 101 的正文与知识卡双视图课程。每章由作者编写的阅读块、代码练习和可定位知识卡组成。",
    subject: sourceManifest.subject,
    language: sourceManifest.language,
    level: sourceManifest.level,
    license: sourceManifest.license,
    attribution: `${sourceManifest.attribution}；v5 课程正文由 Mindmark Hackathon Team 编写`,
    chapters: manifestChapters,
  };
  await writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(targetDir, "README.md"), "# Solidity 101 双视图课程 v5\n\n每章同时提供作者编写的课程正文和知识卡。卡片的 readingBlockId 指向同章正文，浏览时可以双向定位；正式复习仍独立使用 FSRS。\n", "utf8");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
