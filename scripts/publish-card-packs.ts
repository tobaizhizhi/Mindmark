import { readFile, readdir } from "node:fs/promises";
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

async function loadBundles(): Promise<CardPackBundle[]> {
  const result: CardPackBundle[] = [];
  const packs = (await readdir(contentRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  for (const pack of packs) {
    const packDir = path.join(contentRoot, pack.name);
    const versions = (await readdir(packDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const version of versions) {
      const versionDir = path.join(packDir, version.name);
      const manifest = PackManifestSchema.parse(await readJson(path.join(versionDir, "manifest.json")));
      const chapters = await Promise.all(manifest.chapters.map(async (chapter) => (
        PackChapterSchema.parse(await readJson(path.join(versionDir, chapter.cardsFile)))
      )));
      result.push({ manifest, chapters });
    }
  }
  return result;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/u, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  for (const bundle of await loadBundles()) {
    const artifact = buildCardPackArtifact(bundle);
    const majorVersion = Number(artifact.manifest.version.split(".")[0]);
    const publisher = majorVersion >= 5
      ? "publish_card_pack_v5"
      : majorVersion >= 4
        ? "publish_card_pack_v4"
      : majorVersion >= 3
        ? "publish_card_pack_v3"
        : majorVersion >= 2
          ? "publish_card_pack_v2"
          : "publish_card_pack_v1";
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${publisher}`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_manifest: artifact.manifest,
        p_chapters: artifact.chapters,
        p_manifest_hash: artifact.manifestHash,
        p_content_hash: artifact.contentHash,
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Could not publish ${artifact.manifest.slug}@${artifact.manifest.version}: ${body}`);
    }
    process.stdout.write(`${artifact.manifest.slug}@${artifact.manifest.version}: ${body}\n`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
