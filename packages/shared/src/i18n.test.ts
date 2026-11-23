import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DE } from "./i18n/de";
import { format, placeholders, translate } from "./i18n";

/**
 * Every text the app translates has a German version with the same
 * placeholders (tests/test_i18n.py of the Django version). Translated texts
 * are the first argument of `t("…")` calls in the server, the web app and
 * this package, and the texts in `TRANSLATED_ELSEWHERE` lists.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SOURCES = ["apps/server/src", "apps/web/src", "packages/shared/src"];
const CALL = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$\\]*)`)/g;

function files(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/i18n/de.ts")
      ? [full]
      : [];
  });
}

function unescape(text: string): string {
  return JSON.parse(`"${text.replace(/\\'/g, "'").replace(/"/g, '\\"').replace(/\\\\"/g, '\\"')}"`) as string;
}

function translatedTexts(): Set<string> {
  const texts = new Set<string>();
  for (const directory of SOURCES) {
    for (const file of files(path.join(ROOT, directory))) {
      // Comments may show calls as examples.
      const content = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of content.matchAll(CALL)) {
        const raw = match[1] ?? match[2] ?? match[3] ?? "";
        texts.add(match[3] !== undefined ? raw : unescape(raw));
      }
      // Lists of texts translated where they are shown: `// translated: "…"` markers and
      // TRANSLATED_ELSEWHERE arrays hold them as string literals.
      for (const block of content.matchAll(/TRANSLATED_ELSEWHERE[^=]*=\s*\[([\s\S]*?)\];/g)) {
        for (const literal of block[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) texts.add(unescape(literal[1]!));
      }
    }
  }
  return texts;
}

describe("German texts", () => {
  it("has a German version of every translated text", () => {
    const missing = [...translatedTexts()].filter((text) => !(text in DE)).sort();
    expect(missing).toEqual([]);
  });

  // TODO(integration): enable once every module that shows these texts is ported.
  it.skip("has no unused texts", () => {
    const used = translatedTexts();
    expect(Object.keys(DE).filter((text) => !used.has(text))).toEqual([]);
  });

  it("keeps the placeholders", () => {
    const changed = Object.entries(DE).filter(
      ([text, german]) => [...placeholders(text)].sort().join() !== [...placeholders(german)].sort().join(),
    );
    expect(changed).toEqual([]);
  });
});

describe("translate", () => {
  it("fills placeholders in the language's text", () => {
    expect(translate("de", "Return on {date}", { date: "01.02.2026" })).toBe("Rückfahrt am 01.02.2026");
    expect(translate("en", "Return on {date}", { date: "2026-02-01" })).toBe("Return on 2026-02-01");
  });

  it("keeps doubled braces as braces and refuses a missing value", () => {
    expect(format("{{literal}} {name}", { name: "x" })).toBe("{literal} x");
    expect(() => format("{name}", {})).toThrow();
  });
});
