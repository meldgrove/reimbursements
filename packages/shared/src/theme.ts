/**
 * The accent color from the Appearance settings, over the shared colors.
 *
 * `@meldgrove/ui`'s tokens hold the standard palette: without an accent of
 * the app's own, the app looks like every other Meldgrove app (near-black
 * buttons and links, near-white in dark mode). A chosen accent color sets
 * `--mg-accent`: light pages use it as chosen, and dark pages (class "dark"
 * on <html>) lighten it until it reads on their dark background. Text on the
 * accent is white or near-black, whichever contrasts more.
 */
export const HEX_COLOR = /^#[0-9a-f]{6}$/;
/** The primary color of light and dark pages without an accent (the shared tokens). */
export const STANDARD_ACCENT = "#171717";
export const STANDARD_DARK_ACCENT = "#e5e5e5";
export const WHITE = "#ffffff";
/** About the foreground and dark background of the shared tokens. */
export const NEAR_BLACK = "#09090b";
/** Contrast to the dark background the accent needs on dark pages (WCAG AAA for text). */
export const DARK_CONTRAST = 7.0;
/** Contrast to white below which links in the accent are hard to read (WCAG AA for text). */
export const READABLE_CONTRAST = 4.5;
export const ACCENT_PROPERTY = "--mg-accent";
export const FOREGROUND_PROPERTY = "--mg-accent-foreground";

/** `value` as a #rrggbb color, from 3 or 6 hex digits with or without #; null if invalid. */
export function normalize(value: string): string | null {
  let digits = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(digits)) digits = [...digits].map((digit) => digit + digit).join("");
  return /^[0-9a-f]{6}$/.test(digits) ? `#${digits}` : null;
}

const channels = (color: string): [number, number, number] => [
  parseInt(color.slice(1, 3), 16) / 255,
  parseInt(color.slice(3, 5), 16) / 255,
  parseInt(color.slice(5, 7), 16) / 255,
];

const hex = (values: number[]) =>
  "#" +
  values
    .map((channel) =>
      // Python's round(): half to even.
      pythonRound(Math.min(Math.max(channel, 0), 1) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference > 0.5) return floor + 1;
  if (difference < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const linear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const gamma = (channel: number) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

function luminance(color: string): number {
  const [r, g, b] = channels(color).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two #rrggbb colors, from 1 to 21. */
export function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** White or near-black, whichever reads better on `color`. */
export function foreground(color: string): string {
  return contrast(color, WHITE) >= contrast(color, NEAR_BLACK) ? WHITE : NEAR_BLACK;
}

function oklab(color: string): [number, number, number] {
  const [r, g, b] = channels(color).map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function linearRgb(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707612709 * s,
  ];
}

/** The sRGB color of an OKLCH lightness and hue, with as much of `chroma` as fits. */
function oklchColor(lightness: number, chroma: number, hue: number): string {
  const at = (c: number) => linearRgb(lightness, c * Math.cos(hue), c * Math.sin(hue));
  const fits = (c: number) => at(c).every((channel) => channel >= -1e-9 && channel <= 1 + 1e-9);
  let low = 0;
  let high = chroma;
  if (!fits(high)) {
    for (let step = 0; step < 24; step += 1) {
      const middle = (low + high) / 2;
      if (fits(middle)) low = middle;
      else high = middle;
    }
    high = low;
  }
  return hex(at(high).map((channel) => gamma(Math.min(Math.max(channel, 0), 1))));
}

/**
 * `color` for dark pages: as chosen, or lighter until it reads on the dark
 * background. Lightening keeps the hue and as much of the chroma as sRGB
 * allows, so a deep blue becomes a light blue rather than a gray.
 */
export function darkAccent(color: string): string {
  if (contrast(color, NEAR_BLACK) >= DARK_CONTRAST) return color;
  const [lightness, a, b] = oklab(color);
  const chroma = Math.hypot(a, b);
  const hue = Math.atan2(b, a);
  const steps = 200;
  for (let step = 1; step <= steps; step += 1) {
    const lighter = oklchColor(lightness + ((1 - lightness) * step) / steps, chroma, hue);
    if (contrast(lighter, NEAR_BLACK) >= DARK_CONTRAST) return lighter;
  }
  return WHITE;
}

/** The custom properties that make `color` the accent: light (:root) and dark (.dark). */
export function accentProperties(color: string): {
  light: Record<string, string>;
  dark: Record<string, string>;
} {
  const dark = darkAccent(color);
  return {
    light: { [ACCENT_PROPERTY]: color, [FOREGROUND_PROPERTY]: foreground(color) },
    dark: { [ACCENT_PROPERTY]: dark, [FOREGROUND_PROPERTY]: foreground(dark) },
  };
}

/** The stylesheet that makes `color` the accent of light and dark pages. */
export function stylesheet(color: string): string {
  const rule = (selector: string, accent: string) =>
    `${selector} {\n  ${ACCENT_PROPERTY}: ${accent};\n  ${FOREGROUND_PROPERTY}: ${foreground(accent)};\n}\n`;
  return (
    "/* The accent color from the Appearance settings, over the shared colors. */\n" +
    rule(":root", color) +
    rule(".dark", darkAccent(color))
  );
}

/** Whether links in the accent are hard to read on white (the Appearance settings warn). */
export function hardToRead(color: string): boolean {
  return contrast(color, WHITE) < READABLE_CONTRAST;
}
