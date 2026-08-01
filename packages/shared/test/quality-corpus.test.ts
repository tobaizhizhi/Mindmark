import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replayQualityCorpusFixture, type QualityCorpusFixture } from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const corpusRoot = path.join(root, "fixtures", "ai-quality");

async function loadFixture(name: string): Promise<QualityCorpusFixture> {
  const directory = path.join(corpusRoot, name);
  const names = [
    "source.json",
    "expected-inventory.json",
    "blueprint-requirements.json",
    "candidate-cases.json",
    "expected-metrics.json",
  ] as const;
  const values = await Promise.all(names.map(async (file) =>
    JSON.parse(await readFile(path.join(directory, file), "utf8")) as unknown,
  ));
  return {
    source: values[0] as QualityCorpusFixture["source"],
    expectedInventory: values[1] as QualityCorpusFixture["expectedInventory"],
    blueprintRequirements: values[2] as QualityCorpusFixture["blueprintRequirements"],
    candidateCases: values[3] as QualityCorpusFixture["candidateCases"],
    expectedMetrics: values[4] as QualityCorpusFixture["expectedMetrics"],
  };
}

describe("AI quality corpus", () => {
  it("replays synthetic fixtures with complete expected hard-gate detection", async () => {
    const fixtureNames = (await readdir(corpusRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const reports = await Promise.all(fixtureNames.map(async (name) =>
      replayQualityCorpusFixture(await loadFixture(name)),
    ));

    expect(reports).toHaveLength(6);
    expect(reports.every((report) => report.passesExpectedRanges)).toBe(true);
    expect(reports.flatMap((report) => report.cases.filter(
      (candidate) => candidate.predictedDecision !== candidate.expectedDecision,
    ))).toEqual([]);
    expect(reports.flatMap((report) => report.cases.map((candidate) => candidate.detectedFailureCodes)))
      .toContainEqual(expect.arrayContaining(["CITATION_INVALID"]));
    expect(reports.flatMap((report) => report.cases.map((candidate) => candidate.detectedFailureCodes)))
      .toContainEqual(expect.arrayContaining(["DUPLICATE_CANDIDATE"]));
  });
});
