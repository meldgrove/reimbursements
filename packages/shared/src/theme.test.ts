import { describe, expect, it } from "vitest";
import {
  contrast,
  darkAccent,
  DARK_CONTRAST,
  foreground,
  hardToRead,
  NEAR_BLACK,
  normalize,
  stylesheet,
  WHITE,
} from "./theme";

describe("accent color", () => {
  it.each(["#0f766e", "#1d4ed8", "#000000", "#b91c1c", "#facc15"])(
    "text on the accent %s reads in light and dark mode",
    (color) => {
      const dark = darkAccent(color);
      expect(contrast(dark, NEAR_BLACK)).toBeGreaterThanOrEqual(DARK_CONTRAST);
      for (const accent of [color, dark])
        expect(contrast(accent, foreground(accent))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("keeps the hue in dark mode", () => {
    // A deep blue becomes a light blue, not a gray.
    const dark = darkAccent("#1d4ed8");
    const [red, green, blue] = [1, 3, 5].map((index) => parseInt(dark.slice(index, index + 2), 16)) as [
      number,
      number,
      number,
    ];
    expect(blue > green && green > red && blue - red > 100).toBe(true);
    // Colors that already read on the dark background stay as chosen.
    expect(darkAccent("#facc15")).toBe("#facc15");
    expect(foreground("#facc15")).toBe(NEAR_BLACK);
    expect(foreground("#1d4ed8")).toBe(WHITE);
  });

  it("takes hex codes with or without # and three or six digits", () => {
    expect(normalize("0F766E")).toBe("#0f766e");
    expect(normalize("#abc")).toBe("#aabbcc");
    expect(normalize("teal")).toBeNull();
  });

  it("warns about light accents and writes the stylesheet", () => {
    expect(hardToRead("#facc15")).toBe(true);
    expect(hardToRead("#1d4ed8")).toBe(false);
    expect(stylesheet("#0f766e")).toContain("--mg-accent: #0f766e;");
  });
});
