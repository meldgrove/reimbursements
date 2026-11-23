// Writes gzip and brotli copies (.gz, .br) of built text files next to them:
//   node scripts/compress-assets.mjs <directory>...
// The server sends them to browsers that accept them (apps/server/src/http/static.ts).
// Runs after inject-debug-ids.mjs, which changes the bundles. Source maps are
// left out: they are uploaded to Sentry, never served.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".txt"]);
/** Smaller files gain too little. */
const MIN_BYTES = 1024;

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

const directories = process.argv.slice(2);
if (directories.length === 0) throw new Error("Name the directories with the built files.");

async function compress(file) {
  const data = await readFile(file);
  if (data.byteLength < MIN_BYTES) return 0;
  const [br, gz] = await Promise.all([
    brotli(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
      },
    }),
    gzipped(data, { level: constants.Z_BEST_COMPRESSION }),
  ]);
  let written = 0;
  for (const [extension, compressed] of [
    [".br", br],
    [".gz", gz],
  ]) {
    if (compressed.byteLength >= data.byteLength) continue;
    await writeFile(`${file}${extension}`, compressed);
    written += 1;
  }
  return written;
}

for (const directory of directories) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.join(entry.parentPath, entry.name));
  const written = await Promise.all(files.map(compress));
  process.stdout.write(`${directory}: ${written.reduce((sum, count) => sum + count, 0)} compressed copies\n`);
}
