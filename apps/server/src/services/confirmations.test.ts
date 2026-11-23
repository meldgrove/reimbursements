// The placeholder rule of a confirmation's subject and text (placeholder_problem of
// portal/services/confirmations.py in the Django version), with Python's answers.
import { describe, expect, it } from "vitest";
import { collapseSpaces, placeholderProblem, standardTexts, stripSpaces } from "./confirmations";

const BRACE = "Write a single brace as {{ or }}; braces otherwise enclose a placeholder.";
const KNOWN = "{name}, {form}, {reference}, {payment_timing}, {support}, {app_name}";
const unknown = (field: string) => `{${field}} is not a placeholder. Use ${KNOWN}.`;
const spec = (field: string) => `Write the placeholder as {${field}}, without “:” or “!”.`;

describe("confirmation placeholders", () => {
  // Each answer computed with python3: string.Formatter().parse as placeholder_problem reads it.
  it.each([
    ["Hallo {name}", ""],
    ["Eingang {referenz}", unknown("referenz")],
    ["Hi {name!r}", spec("name")],
    ["Hi } there", BRACE],
    ["Hi { there", BRACE],
    ["{{Klammern}}", ""],
    ["{}", unknown("")],
    ["{0}", unknown("0")],
    ["{name:>10}", spec("name")],
    ["{name!}", BRACE],
    ["{name!r:x}", spec("name")],
    ["{name.attr}", unknown("name.attr")],
    ["{name[0]}", unknown("name[0]")],
    ["{ name }", unknown(" name ")],
    ["a {name} b {form} {unknown", BRACE],
    ["{a{b}c}", BRACE],
    ["{name:{form}}", spec("name")],
    ["}}{{", ""],
    ["{name}}", BRACE],
    ["{{name}", BRACE],
    ["x}y", BRACE],
    ["{na}me}", BRACE],
    ["{name!rr}", BRACE],
    ["{name[}", BRACE],
    ["{name[}]}", unknown("name[}]")],
    ["{!r}", unknown("")],
    ["{:x}", unknown("")],
    ["{payment_timing}{app_name}", ""],
    ["{zz} }", BRACE],
    ["{name} {nope!r}", unknown("nope")],
    ["{nope!r} {name}", unknown("nope")],
  ])("%s", (text, problem) => {
    expect(placeholderProblem(text)).toBe(problem);
  });

  it("accepts the standard texts in both languages", () => {
    for (const code of ["de", "en"] as const) {
      for (const text of standardTexts(code)) expect(placeholderProblem(text)).toBe("");
    }
  });
});

describe("spaces as Python splits and strips them", () => {
  it("collapses and strips Python's whitespace", () => {
    expect(collapseSpaces("  Got   it: {reference}\u001c ")).toBe("Got it: {reference}");
    expect(stripSpaces("\u0085 Text 　")).toBe("Text");
    // Not whitespace for Python: the zero-width no-break space stays.
    expect(collapseSpaces("﻿Text")).toBe("﻿Text");
  });
});
