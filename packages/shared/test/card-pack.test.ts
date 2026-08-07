import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PackChapterSchema,
  PackManifestSchema,
  buildCardPackArtifact,
  hashCardPackContent,
  materializePackKnowledgeCard,
  validateCardPack,
  type CardPackBundle,
} from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function fixture(version = "v1"): Promise<CardPackBundle> {
  const versionDir = path.join(root, `content/card-packs/solidity-foundations/${version}`);
  const manifest = PackManifestSchema.parse(await readJson(path.join(versionDir, "manifest.json")));
  const chapters = await Promise.all(manifest.chapters.map(async (chapter) => (
    PackChapterSchema.parse(await readJson(path.join(versionDir, chapter.cardsFile)))
  )));
  return { manifest, chapters };
}

describe("Card Pack domain", () => {
  it("validates and hashes the fixed Solidity Pack", async () => {
    const bundle = await fixture();
    const artifact = buildCardPackArtifact(bundle);

    expect(artifact.chapterCount).toBe(8);
    expect(artifact.cardCount).toBe(40);
    expect(artifact.manifestHash).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(artifact.contentHash).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(validateCardPack(bundle)).toEqual(bundle);
  });

  it("validates the code-first Solidity v2 Pack and preserves exercises", async () => {
    const bundle = await fixture("v2");
    const artifact = buildCardPackArtifact(bundle);

    expect(artifact.manifest.version).toBe("2.0.0");
    expect(artifact.chapterCount).toBe(8);
    expect(artifact.cardCount).toBe(48);
    expect(bundle.chapters.every((chapter) => chapter.cards.filter((card) => card.code).length >= 2)).toBe(true);

    const codeCard = bundle.chapters[0]!.cards.find((card) => card.type === "code_complete")!;
    expect(materializePackKnowledgeCard(codeCard)).toMatchObject({
      type: "code_complete",
      code: { language: "solidity", expectedResult: expect.any(String) },
    });
  });

  it("validates the progressive Solidity v3 Pack and its learning path", async () => {
    const bundle = await fixture("v3");
    const artifact = buildCardPackArtifact(bundle);
    const codeCards = bundle.chapters.flatMap((chapter) => chapter.cards).filter((card) => card.code);

    expect(artifact.manifest.version).toBe("3.0.0");
    expect(artifact.chapterCount).toBe(15);
    expect(artifact.cardCount).toBe(105);
    expect(codeCards).toHaveLength(45);
    expect(bundle.chapters.every((chapter) => chapter.learningObjectives?.length === 3)).toBe(true);
    expect(bundle.chapters.every((chapter, index) => (
      index === 0
        ? chapter.prerequisiteChapterIds?.length === 0
        : chapter.prerequisiteChapterIds?.includes(index - 1)
    ))).toBe(true);
    expect(codeCards.every((card) => (
      Boolean(card.code?.starterCode) && Boolean(card.code?.solutionCode)
    ))).toBe(true);
    expect(bundle.chapters.at(-1)).toMatchObject({
      slug: "errors",
      title: expect.stringContaining("错误处理"),
    });
  });

  it("validates the structured Solidity v4 Pack as a staged curriculum", async () => {
    const bundle = await fixture("v4");
    const artifact = buildCardPackArtifact(bundle);
    const codeCards = bundle.chapters.flatMap((chapter) => chapter.cards).filter((card) => card.code);

    expect(artifact.manifest.version).toBe("4.0.0");
    expect(artifact.chapterCount).toBe(16);
    expect(artifact.cardCount).toBe(112);
    expect(codeCards).toHaveLength(48);
    expect(bundle.chapters.every((chapter) => (
      chapter.stageId !== undefined
      && chapter.stageTitle
      && chapter.newConcepts?.length
      && chapter.practiceFocus
      && chapter.projectMilestone
    ))).toBe(true);
    expect(bundle.chapters.every((chapter, index) => (
      index === 0
        ? chapter.prerequisiteChapterIds?.length === 0
        : chapter.prerequisiteChapterIds?.includes(index - 1)
    ))).toBe(true);
    expect(bundle.chapters.map((chapter) => chapter.stageId)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5,
    ]);
    expect(bundle.chapters[8]?.newConcepts).toContain("delete 重置");
    expect(bundle.chapters[9]?.newConcepts).toContain("constant 配置");
    expect(codeCards.every((card) => Boolean(card.code?.starterCode) && Boolean(card.code?.solutionCode))).toBe(true);
  });

  it("validates the v5 dual-view curriculum and its same-Chapter card anchors", async () => {
    const bundle = await fixture("v5");
    const artifact = buildCardPackArtifact(bundle);
    expect(artifact.manifest.version).toBe("5.0.0");
    expect(bundle.chapters.every((chapter) => (chapter.readingBlocks?.length ?? 0) >= 1)).toBe(true);
    expect(bundle.chapters.every((chapter) => chapter.cards.every((card) => (
      Boolean(card.readingBlockId)
      && chapter.readingBlocks?.some((block) => block.blockId === card.readingBlockId)
    )))).toBe(true);

    const invalid = structuredClone(bundle);
    invalid.chapters[0]!.cards[0]!.readingBlockId = "missing-block";
    expect(() => validateCardPack(invalid)).toThrow(/must reference a reading block/u);
  });

  it("rejects a v2 code card without an exercise payload", async () => {
    const bundle = await fixture("v2");
    const invalid = structuredClone(bundle) as unknown as { chapters: Array<{ cards: Array<{ code?: unknown }> }> };
    delete invalid.chapters[0]!.cards[2]!.code;

    expect(() => validateCardPack(invalid)).toThrow(/Code cards require a Solidity exercise/u);
  });

  it("keeps content hashes stable when Chapter and Card arrays are reordered", async () => {
    const bundle = await fixture();
    const reordered = {
      ...bundle,
      chapters: [...bundle.chapters].reverse().map((chapter) => ({
        ...chapter,
        cards: [...chapter.cards].reverse(),
      })),
    };

    expect(hashCardPackContent(reordered)).toBe(hashCardPackContent(bundle));
  });

  it("rejects duplicate IDs, duplicate questions and manifest drift", async () => {
    const bundle = await fixture();
    const duplicateId = structuredClone(bundle);
    duplicateId.chapters[1]!.cards[0]!.packCardId = duplicateId.chapters[0]!.cards[0]!.packCardId;
    expect(() => validateCardPack(duplicateId)).toThrow(/Duplicate Pack Card ID/u);

    const duplicateQuestion = structuredClone(bundle);
    duplicateQuestion.chapters[1]!.cards[0]!.question = duplicateQuestion.chapters[0]!.cards[0]!.question;
    expect(() => validateCardPack(duplicateQuestion)).toThrow(/Duplicate Pack Card question/u);

    const countDrift = structuredClone(bundle);
    countDrift.manifest.chapters[0]!.cardCount = 6;
    expect(() => validateCardPack(countDrift)).toThrow(/does not match its manifest entry/u);
  });

  it("rejects missing learning coverage and English-only questions in a Chinese Pack", async () => {
    const bundle = await fixture();
    const missingApplication = structuredClone(bundle);
    missingApplication.chapters[0]!.cards[3]!.type = "concept";
    expect(() => validateCardPack(missingApplication)).toThrow(/needs an application card/u);

    const wrongLanguage = structuredClone(bundle);
    wrongLanguage.chapters[0]!.cards[0]!.question = "What is a Solidity value type?";
    expect(() => validateCardPack(wrongLanguage)).toThrow(/must contain Chinese text/u);
  });

  it("materializes Pack provenance without a fake PDF citation", async () => {
    const bundle = await fixture();
    const content = materializePackKnowledgeCard(bundle.chapters[0]!.cards[0]!);

    expect(content.source).toMatchObject({
      kind: "pack_reference",
      label: "Solidity Types",
    });
    expect(content.source).not.toHaveProperty("page");
  });
});
