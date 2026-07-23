import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  PrepareJourneyRequestSchema,
  hashGoal,
  prepareJourney,
  verifyMerkleProof,
} from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const journeyId = `0x${"42".repeat(32)}` as Hex;

describe("journey preparation", () => {
  it("deterministically splits the demo material into three meaningful chunks", async () => {
    const fixture = JSON.parse(
      await readFile(path.join(root, "fixtures/reentrancy-pages.json"), "utf8"),
    ) as { goal: string; pages: Array<{ pageNumber: number; text: string }> };
    const request = { goal: fixture.goal, pages: fixture.pages };
    const first = prepareJourney(request, journeyId);
    const second = prepareJourney(structuredClone(request), journeyId);

    expect(first).toEqual(second);
    expect(first.chunkCount).toBe(3);
    expect(first.chunks.map((chunk) => [chunk.content.pageStart, chunk.content.pageEnd])).toEqual([
      [1, 3],
      [4, 6],
      [7, 8],
    ]);
    expect(first.chunks[0]?.content.text).toContain("exploit");
    expect(first.chunks[1]?.content.text).toContain("Checks-Effects-Interactions");
    expect(first.chunks[2]?.content.text).toContain("invariant tests");

    const totalBudget = first.chunks.reduce((total, chunk) => total + chunk.cardBudget, 0);
    expect(totalBudget).toBeGreaterThanOrEqual(4);
    expect(totalBudget).toBeLessThanOrEqual(30);
    for (const chunk of first.chunks) {
      expect(
        verifyMerkleProof(
          first.chunkManifestRoot,
          // The leaf is reconstructed by buildChunkManifest in production; proof
          // validity is also covered by the golden-vector suite.
          (await import("../src/merkle.js")).manifestLeaf(
            journeyId,
            chunk.content.chunkId,
            chunk.sourceChunkHash,
          ),
          chunk.manifestProof,
        ),
      ).toBe(true);
    }
  });

  it("splits one-page short text into two semantic units", async () => {
    const fixture = JSON.parse(
      await readFile(path.join(root, "fixtures/short-text.json"), "utf8"),
    ) as { goal: string; pages: Array<{ pageNumber: number; text: string }> };
    const prepared = prepareJourney(fixture, journeyId);

    expect(prepared.chunkCount).toBe(2);
    expect(prepared.chunks.every((chunk) => chunk.content.pageStart === 1)).toBe(true);
    expect(prepared.chunks.every((chunk) => chunk.content.text.length > 20)).toBe(true);
  });

  it("hashes an omitted learning goal as a stable non-zero commitment", () => {
    expect(hashGoal("")).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(hashGoal("   ")).toBe(hashGoal(""));
  });

  it("rejects unordered, duplicate, and oversized page input", () => {
    expect(() =>
      PrepareJourneyRequestSchema.parse({
        pages: [
          { pageNumber: 2, text: "Second page" },
          { pageNumber: 1, text: "First page" },
        ],
      }),
    ).toThrow(/ordered/u);
    expect(() =>
      PrepareJourneyRequestSchema.parse({
        pages: [
          { pageNumber: 1, text: "First" },
          { pageNumber: 1, text: "Duplicate" },
        ],
      }),
    ).toThrow(/unique/u);
    expect(() =>
      PrepareJourneyRequestSchema.parse({
        pages: [{ pageNumber: 1, text: "x".repeat(20_001) }],
      }),
    ).toThrow();
  });
});

