import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PackChapterSchema,
  PackManifestSchema,
  buildCardPackArtifact,
  type CardPackBundle,
} from "../packages/shared/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(root, "content/card-packs");

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function versionDirectories(): Promise<string[]> {
  const packEntries = await readdir(contentRoot, { withFileTypes: true });
  const result: string[] = [];
  for (const pack of packEntries.filter((entry) => entry.isDirectory())) {
    const packDir = path.join(contentRoot, pack.name);
    const versions = await readdir(packDir, { withFileTypes: true });
    result.push(...versions.filter((entry) => entry.isDirectory()).map((entry) => path.join(packDir, entry.name)));
  }
  return result.sort();
}

async function loadBundle(versionDir: string): Promise<CardPackBundle> {
  const manifest = PackManifestSchema.parse(await readJson(path.join(versionDir, "manifest.json")));
  const chapters = await Promise.all(manifest.chapters.map(async (chapter) => (
    PackChapterSchema.parse(await readJson(path.join(versionDir, chapter.cardsFile)))
  )));
  return { manifest, chapters };
}

async function main(): Promise<void> {
  const writeArtifacts = process.argv.includes("--write");
  const artifactDir = path.join(root, "artifacts/card-packs");
  if (writeArtifacts) await mkdir(artifactDir, { recursive: true });

  for (const versionDir of await versionDirectories()) {
    const artifact = buildCardPackArtifact(await loadBundle(versionDir));
    const summary = {
      slug: artifact.manifest.slug,
      version: artifact.manifest.version,
      chapterCount: artifact.chapterCount,
      cardCount: artifact.cardCount,
      manifestHash: artifact.manifestHash,
      contentHash: artifact.contentHash,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (writeArtifacts) {
      const filename = `${artifact.manifest.slug}-${artifact.manifest.version}.json`;
      await writeFile(path.join(artifactDir, filename), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
