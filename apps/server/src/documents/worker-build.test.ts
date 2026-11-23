// The document child's build refuses parsers that would load before lockdown(),
// by import, by require and through createRequire() (only the dynamic import
// after lockdown() may load them).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { workerBuild } from "./sandbox-test-support";

let directory: string;
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("refuses a parser that a require would load before lockdown()", async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "worker-build-"));
  const entry = path.join(directory, "eager.ts");
  writeFileSync(
    entry,
    'declare const require: (name: string) => unknown;\nexport const sharp = require("sharp");\n',
  );
  await expect(
    (await workerBuild()).buildFileWorker(path.join(directory, "out"), { logLevel: "silent", entry }),
  ).rejects.toThrow(/before its lockdown: sharp/);
});

it("refuses createRequire() before lockdown(), which could load a parser unseen", async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "worker-build-"));
  const entry = path.join(directory, "eager.ts");
  writeFileSync(
    entry,
    'import { createRequire } from "node:module";\nexport const sharp = createRequire(import.meta.url)("sharp");\n',
  );
  await expect(
    (await workerBuild()).buildFileWorker(path.join(directory, "out"), { logLevel: "silent", entry }),
  ).rejects.toThrow(/before its lockdown: node:module \(createRequire in /);
});

it("builds the document child, whose add-on loader may use createRequire()", async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "worker-build-"));
  const out = path.join(directory, "out");
  await expect((await workerBuild()).buildFileWorker(out, { logLevel: "silent" })).resolves.toBe(
    path.join(out, "file-worker.mjs"),
  );
});
