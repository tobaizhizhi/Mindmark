import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

const { invalidateProjectFileCacheForOwner } = vi.hoisted(() => ({
  invalidateProjectFileCacheForOwner: vi.fn(),
}));
vi.mock("@/lib/server/project-files", () => ({ invalidateProjectFileCacheForOwner }));

import {
  deleteProjectForOwner,
  type DeletableProject,
  type ProjectDeletionStore,
} from "@/lib/server/project-deletion";

const projectId = `0x${"72".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;

class RecordingDeletionStore implements ProjectDeletionStore {
  events: string[] = [];
  project: DeletableProject | null = {
    projectId,
    projectKind: "UPLOAD",
    sourceStorageBucket: "learning-source-files",
    sourceStoragePath: `${owner}/${projectId}/source.pdf`,
  };
  storageError: Error | null = null;

  async loadOwned() {
    this.events.push("load");
    return this.project;
  }

  async removeSourceFile(bucket: string, path: string) {
    this.events.push(`remove:${bucket}:${path}`);
    if (this.storageError) throw this.storageError;
  }

  async deleteOwned() {
    this.events.push("delete");
    return true;
  }
}

describe("Project deletion", () => {
  it("removes a private source PDF before deleting the owner-scoped Project", async () => {
    const store = new RecordingDeletionStore();

    await deleteProjectForOwner(projectId, owner, store);

    expect(store.events).toEqual([
      "load",
      `remove:learning-source-files:${owner}/${projectId}/source.pdf`,
      "delete",
    ]);
    expect(invalidateProjectFileCacheForOwner).toHaveBeenCalledWith(projectId, owner);
  });

  it("deletes an installed Card Pack without attempting file storage cleanup", async () => {
    const store = new RecordingDeletionStore();
    store.project = {
      projectId,
      projectKind: "PACK",
      sourceStorageBucket: "unexpected-bucket",
      sourceStoragePath: "unexpected-file.pdf",
    };

    await deleteProjectForOwner(projectId, owner, store);

    expect(store.events).toEqual(["load", "delete"]);
  });

  it("does not delete the database Project when source file removal fails", async () => {
    const store = new RecordingDeletionStore();
    store.storageError = new Error("storage unavailable");

    await expect(deleteProjectForOwner(projectId, owner, store)).rejects.toThrow("storage unavailable");
    expect(store.events).not.toContain("delete");
  });

  it("does not reveal whether another owner's Project exists", async () => {
    const store = new RecordingDeletionStore();
    store.project = null;

    await expect(deleteProjectForOwner(projectId, owner, store)).rejects.toMatchObject({
      status: 404,
      code: "project_not_found",
    });
    expect(store.events).toEqual(["load"]);
  });
});
