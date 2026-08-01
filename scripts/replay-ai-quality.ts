import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replayQualityCorpusFixture,
  type QualityCorpusFixture,
} from "../packages/shared/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = path.join(root, "fixtures", "ai-quality");

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function loadFixture(name: string): Promise<QualityCorpusFixture> {
  const directory = path.join(corpusRoot, name);
  const [source, expectedInventory, blueprintRequirements, candidateCases, expectedMetrics] = await Promise.all([
    readJson(path.join(directory, "source.json")),
    readJson(path.join(directory, "expected-inventory.json")),
    readJson(path.join(directory, "blueprint-requirements.json")),
    readJson(path.join(directory, "candidate-cases.json")),
    readJson(path.join(directory, "expected-metrics.json")),
  ]);
  return {
    source: source as QualityCorpusFixture["source"],
    expectedInventory: expectedInventory as QualityCorpusFixture["expectedInventory"],
    blueprintRequirements: blueprintRequirements as QualityCorpusFixture["blueprintRequirements"],
    candidateCases: candidateCases as QualityCorpusFixture["candidateCases"],
    expectedMetrics: expectedMetrics as QualityCorpusFixture["expectedMetrics"],
  };
}

async function main(): Promise<void> {
  const fixtureNames = (await readdir(corpusRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const reports = await Promise.all(fixtureNames.map(async (name) => replayQualityCorpusFixture(await loadFixture(name))));
  const totalCases = reports.reduce((total, report) => total + report.caseCount, 0);
  const report = {
    fixtureCount: reports.length,
    totalCases,
    expectationAccuracy: reports.reduce(
      (total, item) => total + item.expectationAccuracy * item.caseCount,
      0,
    ) / totalCases,
    violationDetectionRate: reports.reduce(
      (total, item) => total + item.violationDetectionRate * item.caseCount,
      0,
    ) / totalCases,
    fixtures: reports,
  };
  console.log(JSON.stringify(report, null, 2));
  if (reports.some((item) => !item.passesExpectedRanges)) process.exitCode = 1;
}

void main();
