// The list of validation failure codes stays complete: every code the
// validation path raises is in it (0.4 read them from the sources with ast).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VALIDATION_FAILURE_CODES } from "./manifest";

const here = import.meta.dirname;

function raised(source: string): string[] {
  return [
    ...source.matchAll(/new (?:DocumentError|ProcessingError)\("([a-z_]+)"\)/g),
    ...source.matchAll(/error: "([a-z_]+)"/g),
  ].map((match) => match[1]!);
}

describe("validation failure codes", () => {
  it("lists every code the validation raises", () => {
    const convert = readFileSync(path.join(here, "convert.ts"), "utf8");
    const validation = convert.slice(0, convert.indexOf("export async function receiptImages"));
    const codes = new Set([
      ...raised(validation),
      ...raised(readFileSync(path.join(here, "file-worker.ts"), "utf8")),
      ...raised(readFileSync(path.join(here, "../services/documents.ts"), "utf8")),
    ]);
    expect(codes.size).toBeGreaterThan(10);
    expect(
      [...codes].filter((code) => !(VALIDATION_FAILURE_CODES as readonly string[]).includes(code)),
    ).toEqual([]);
  });
});
