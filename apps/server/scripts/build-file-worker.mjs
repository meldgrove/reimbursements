// Bundles the document child (src/documents/file-worker.ts) into
// <outdir>/file-worker.mjs, on its own: it shares no chunk with the server.
// Its parsers (sharp, pdf-lib, PDFium, pdfmake) must load only after the
// child's lockdown(), through the dynamic import in file-worker.ts; the build
// fails when one of them would load with the entry itself, or when a module
// loaded with it could load one through createRequire().
//
// scripts/build.mjs calls it for dist/; the sandbox tests for a bundle of their own.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const PARSERS = ["sharp", "pdf-lib", "@embedpdf/pdfium", "pdfmake"];
// createRequire() loads modules the metafile does not list (it records only
// node:module): before lockdown() only the add-on's loader may use it.
const REQUIRE_LOADERS = new Set([path.join(root, "src/documents/sandbox.ts")]);

export async function buildFileWorker(outdir, options = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@reimbursements/"));
  const entryPoint = options.entry ?? path.join(root, "src/documents/file-worker.ts");
  const result = await build({
    entryPoints: { "file-worker": entryPoint },
    outdir,
    outExtension: { ".js": ".mjs" },
    splitting: true,
    chunkNames: "file-worker-chunks/[name]-[hash]",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    external,
    sourcemap: options.sourcemap ?? true,
    legalComments: "none",
    logLevel: options.logLevel ?? "info",
    metafile: true,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const entry = Object.entries(result.metafile.outputs).find(
    ([, output]) =>
      // Metafile paths are relative to the working directory.
      output.entryPoint && path.resolve(output.entryPoint) === path.resolve(entryPoint),
  );
  const early = new Set();
  const visit = (file) => {
    for (const imported of result.metafile.outputs[file]?.imports ?? []) {
      // Every kind loads at once (import, require) except the dynamic import after lockdown().
      if (imported.kind === "dynamic-import") continue;
      if (imported.external) {
        if (PARSERS.some((name) => imported.path === name || imported.path.startsWith(`${name}/`)))
          early.add(imported.path);
      } else {
        visit(imported.path);
      }
    }
  };
  if (!entry) throw new Error("The document child's entry is missing from its build.");
  visit(entry[0]);
  // The same walk over the source modules (metafile paths are relative to the working directory).
  const seen = new Set();
  const visitInput = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const imported of result.metafile.inputs[file]?.imports ?? []) {
      if (imported.kind === "dynamic-import") continue;
      if (!imported.external) visitInput(imported.path);
      else if (
        (imported.path === "node:module" || imported.path === "module") &&
        !REQUIRE_LOADERS.has(path.resolve(file))
      )
        early.add(`${imported.path} (createRequire in ${path.relative(root, path.resolve(file))})`);
    }
  };
  const entryInput = Object.keys(result.metafile.inputs).find(
    (file) => path.resolve(file) === path.resolve(entryPoint),
  );
  if (!entryInput) throw new Error("The document child's entry is missing from its build inputs.");
  visitInput(entryInput);
  if (early.size > 0) {
    throw new Error(`The document child would load parsers before its lockdown: ${[...early].join(", ")}`);
  }
  return path.join(outdir, "file-worker.mjs");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildFileWorker(process.argv[2] ?? path.join(root, "dist"));
}
