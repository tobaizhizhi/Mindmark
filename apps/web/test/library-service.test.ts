import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  createFolderForOwner,
  getDocumentLibraryForOwner,
  moveProjectForOwner,
  type DocumentLibraryStore,
} from "@/lib/server/library";

const owner = `0x${"ab".repeat(20)}` as `0x${string}`;
const projectId = `0x${"71".repeat(32)}` as Hex;
const folderId = "123e4567-e89b-42d3-a456-426614174000";

class RecordingLibraryStore implements DocumentLibraryStore {
  calls: Array<{ action: string; owner: string; target?: string | null }> = [];

  async load(address: `0x${string}`, selectedFolderId: string | null) {
    this.calls.push({ action: "load", owner: address, target: selectedFolderId });
    return {
      folders: [{
        folderId,
        name: "Solidity",
        parentFolderId: null,
        documentCount: 1,
        updatedAt: "2026-07-27T08:00:00.000Z",
      }],
      documents: [{
        projectId,
        folderId: selectedFolderId,
        title: "重入安全",
        sourceFilename: "reentrancy.pdf",
        sourceMimeType: "application/pdf",
        sourcePageCount: 12,
        status: "READY",
        chapterCount: 3,
        readyChapterCount: 3,
        cardCount: 18,
        dueCount: 4,
        updatedAt: "2026-07-27T08:00:00.000Z",
      }],
    };
  }

  async createFolder(address: `0x${string}`, _name: string, parentFolderId: string | null) {
    this.calls.push({ action: "create", owner: address, target: parentFolderId });
    return folderId;
  }

  async renameFolder() {}

  async moveProject(address: `0x${string}`, targetProjectId: Hex, selectedFolderId: string | null) {
    this.calls.push({ action: "move", owner: address, target: `${targetProjectId}:${selectedFolderId}` });
  }

  async deleteFolder() {}
}

describe("document library service", () => {
  it("maps folder and PDF rows into a bounded library response", async () => {
    const store = new RecordingLibraryStore();
    const result = await getDocumentLibraryForOwner(owner, folderId, store, new Date("2026-07-27T09:00:00.000Z"));
    expect(result.currentFolderId).toBe(folderId);
    expect(result.documents[0]).toMatchObject({ projectId, sourceFilename: "reentrancy.pdf", chapterCount: 3 });
    expect(store.calls[0]).toEqual({ action: "load", owner, target: folderId });
  });

  it("always scopes folder creation and Project movement to the session owner", async () => {
    const store = new RecordingLibraryStore();
    await expect(createFolderForOwner(owner, { name: "  合约安全  ", parentFolderId: null }, store)).resolves.toEqual({
      folderId,
      name: "合约安全",
      parentFolderId: null,
    });
    await moveProjectForOwner(owner, projectId, folderId, store);
    expect(store.calls).toEqual([
      { action: "create", owner, target: null },
      { action: "move", owner, target: `${projectId}:${folderId}` },
    ]);
  });
});
