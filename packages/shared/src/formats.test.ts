import { describe, expect, it } from "vitest";
import {
  DATE_FORMATS,
  formatDate,
  formatDateTime,
  formatShortDateTime,
  parseDate,
  zoneName,
  zonedInstant,
} from "./dates";
import { example, formatAmount, fromCents, NUMBER_FORMATS, toCents, toFixedDecimal } from "./numbers";

describe("dates", () => {
  it("labels each format with an example", () => {
    expect(DATE_FORMATS["d.m.Y"].label).toBe("31.12.2026 (DD.MM.YYYY)");
    expect(DATE_FORMATS["m/d/Y"].label).toBe("12/31/2026 (MM/DD/YYYY)");
  });

  it("follows the app date format and timezone", () => {
    const closes = new Date(Date.UTC(2099, 11, 31, 22, 30));
    expect(formatDateTime(closes, "d.m.Y", "Europe/Berlin")).toBe("31.12.2099, 23:30");
    expect(zoneName(closes, "Europe/Berlin")).toBe("CET");
    expect(formatDateTime(closes, "Y-m-d", "America/New_York")).toBe("2099-12-31, 17:30");
    expect(zoneName(closes, "America/New_York")).toBe("EST");
    expect(formatDateTime(closes, "m/d/Y", "Europe/Berlin")).toBe("12/31/2099, 23:30");
    expect(formatShortDateTime(closes, "d.m.Y", "Europe/Berlin")).toBe("31.12.2099 23:30");
    expect(formatDate("2099-10-20", "m/d/Y")).toBe("10/20/2099");
  });

  it("reads dates in the app date format or ISO", () => {
    expect(parseDate("10/20/2099", "m/d/Y")).toBe("2099-10-20");
    expect(parseDate("20.10.2099", "d.m.Y")).toBe("2099-10-20");
    expect(parseDate("2099-10-20", "d.m.Y")).toBe("2099-10-20");
    expect(parseDate("31.02.2099", "d.m.Y")).toBeNull();
    expect(parseDate("20/10/2099", "m/d/Y")).toBeNull();
  });

  it("turns a wall-clock time of the app timezone into an instant", () => {
    expect(zonedInstant("2099-12-31", "23:30", "Europe/Berlin")?.toISOString()).toBe(
      "2099-12-31T22:30:00.000Z",
    );
    expect(zonedInstant("2026-07-01", "12:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-07-01T10:00:00.000Z",
    );
  });
});

describe("numbers", () => {
  it("has a decimal comma unless the US format is chosen", () => {
    expect(formatAmount("12.50", "european")).toBe("12,50");
    expect(formatAmount("12.50", "us")).toBe("12.50");
    expect(formatAmount("1234.5", "european", { grouping: true })).toBe("1.234,50");
    expect(example("european")).toBe("12,50");
    expect(NUMBER_FORMATS.european.label).toBe("1.234,56 (European)");
    expect(NUMBER_FORMATS.us.label).toBe("1,234.56 (US)");
  });

  it("rounds decimal strings without floats", () => {
    expect(toFixedDecimal("0.305", 2)).toBe("0.31");
    expect(toFixedDecimal("12", 2)).toBe("12.00");
    expect(toCents("9999999999.99")).toBe(999999999999n);
    expect(fromCents(1250n)).toBe("12.50");
    expect(fromCents(5)).toBe("0.05");
  });
});
