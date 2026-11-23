// The document child's build refuses parsers that would load before lockdown(),
// by import and by require (only the dynamic import after lockdown() may load them).
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
