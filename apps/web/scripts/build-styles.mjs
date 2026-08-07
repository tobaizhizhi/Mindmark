import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(webRoot, "app/globals.css");
const outputPath = join(webRoot, "app/generated-globals.css");
const source = await readFile(sourcePath, "utf8");
const result = await postcss([tailwindcss()]).process(source, {
  from: sourcePath,
  to: outputPath,
});

await writeFile(outputPath, result.css);
