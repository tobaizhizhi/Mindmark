import { describe, expect, it } from "vitest";
import type { CardPackCatalogItem } from "@mindmark/shared";
import {
  getPublishedCardPack,
  installCardPackForOwner,
  listInstalledCardPacks,
  listPublishedCardPacks,
  type CardPackStore,
} from "@/lib/server/card-packs";

const owner = `0x${"ab".repeat(20)}` as `0x${string}`;
const packId = "123e4567-e89b-42d3-a456-426614174000";
const packVersionId = "123e4567-e89b-42d3-a456-426614174001";
const installationId = "123e4567-e89b-42d3-a456-426614174002";
const projectId = `0x${"71".repeat(32)}` as const;

function catalogItem(): CardPackCatalogItem {
  return {
    packId,
    packVersionId,
    slug: "solidity-foundations",
    title: "Solidity 核心基础",
    description: "从类型到安全的 Solidity 入门卡包。",
    subject: "Solidity",
    language: "zh-CN",
    level: "beginner",
    version: "1.0.0",
    chapterCount: 1,
    cardCount: 5,
    estimatedMinutes: 12,
    license: "CC BY 4.0",
    attribution: "Mindmark",
    installedProjectId: null,
  };
}

class RecordingCardPackStore implements CardPackStore {
  calls: Array<{ action: string; owner: string | null; target?: string | null }> = [];

  async listPublished(address: `0x${string}` | null) {
    this.calls.push({ action: "list", owner: address });
    return { packs: [catalogItem()] };
  }

  async getPublished(target: string, address: `0x${string}` | null) {
    this.calls.push({ action: "get", owner: address, target });
    return {
      ...catalogItem(),
      chapters: [{
        chapterId: 0,
        position: 0,
        slug: "types",
        title: "类型",
        summary: "理解类型。",
        estimatedMinutes: 12,
        cardCount: 5,
        cards: Array.from({ length: 5 }, (_, position) => ({
          packCardId: `types-card-${position}`,
          position,
          type: position === 4 ? "misconception" : "concept",
          question: `第 ${position + 1} 个问题是什么？`,
          answer: "这是卡片答案。",
          keyPoint: "这是关键点。",
          source: { kind: "pack_reference", label: "Solidity Docs" },
          tags: ["类型"],
          importance: 4,
          initialDifficulty: 2,
        })),
      }],
    };
  }

  async install(address: `0x${string}`, target: string, folderId: string | null) {
    this.calls.push({ action: "install", owner: address, target: `${target}:${folderId}` });
    return {
      installationId,
      projectId,
      projectKind: "PACK",
      packVersionId,
      status: "READY",
      chapterCount: 1,
      cardCount: 5,
      idempotent: false,
    };
  }

  async deleteInstallation(address: `0x${string}`, target: string) {
    this.calls.push({ action: "delete", owner: address, target });
  }
}

describe("Card Pack application module", () => {
  it("allows anonymous catalog browsing and owner-aware details", async () => {
    const store = new RecordingCardPackStore();
    await expect(listPublishedCardPacks(null, store)).resolves.toMatchObject({
      packs: [{ slug: "solidity-foundations" }],
    });
    await expect(getPublishedCardPack(packVersionId, owner, store)).resolves.toMatchObject({
      chapters: [{ cardCount: 5 }],
    });
    expect(store.calls).toEqual([
      { action: "list", owner: null },
      { action: "get", owner, target: packVersionId },
    ]);
  });

  it("scopes installation ownership to the wallet session", async () => {
    const store = new RecordingCardPackStore();
    await expect(installCardPackForOwner(owner, packVersionId, { folderId: null }, store)).resolves.toMatchObject({
      projectId,
      projectKind: "PACK",
      idempotent: false,
    });
    expect(store.calls).toEqual([{
      action: "install",
      owner,
      target: `${packVersionId}:null`,
    }]);
  });

  it("filters installed packs through the same owner-scoped catalog", async () => {
    const store = new RecordingCardPackStore();
    store.listPublished = async () => ({ packs: [{ ...catalogItem(), installedProjectId: projectId }] });
    const installed = await listInstalledCardPacks(owner, store);
    expect(installed.packs).toHaveLength(1);
  });
});
