/** Dates of mileage rows as Django's parse_date reads them. */
import { describe, expect, it } from "vitest";
import { parseDjangoDate } from "./claim-validation";

describe("parseDjangoDate", () => {
  it.each([
    ["2026-11-05", "2026-11-05"],
    ["20261105", "2026-11-05"],
    ["2026-1-5", "2026-01-05"],
  ])("reads %s", (value, expected) => {
    expect(parseDjangoDate(value)).toBe(expected);
  });

  // Review I13: Django refuses a date with only one of its separators.
  it.each(["2026-1105", "202611-05", "2026-02-30", "26-11-05"])("refuses %s", (value) => {
    expect(() => parseDjangoDate(value)).toThrow();
  });
});
