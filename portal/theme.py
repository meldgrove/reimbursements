"""The accent color from the Appearance settings, as a stylesheet over the standard one.

ui.css holds the standard palette. A chosen accent color replaces its primary color:
light pages use it as chosen, and dark pages lighten it until it reads on their dark
background, as the standard palette does. Text on the accent is white or near-black,
whichever contrasts more.
"""

import hashlib
import math
import re
from functools import cache

HEX_COLOR = r"#[0-9a-f]{6}"
# The standard accent of light and dark pages in ui.css.
STANDARD_ACCENT = "#0f766e"
STANDARD_DARK_ACCENT = "#5eead4"
WHITE = "#ffffff"
# The foreground and dark background of ui.css.
NEAR_BLACK = "#09090b"
# Contrast to the dark background the accent needs on dark pages (WCAG AAA for text).
DARK_CONTRAST = 7.0
# Contrast to white below which links in the accent are hard to read (WCAG AA for text).
READABLE_CONTRAST = 4.5
# The custom properties ui.css derives from the primary color.
ACCENT_PROPERTIES = ("--brand", "--primary", "--ring", "--sidebar-primary", "--sidebar-ring")
FOREGROUND_PROPERTIES = ("--primary-foreground", "--sidebar-primary-foreground")


def normalize(value):
    """`value` as a #rrggbb color, from 3 or 6 hex digits with or without #; None if invalid."""
    digits = value.strip().removeprefix("#").lower()
    if re.fullmatch(r"[0-9a-f]{3}", digits):
        digits = "".join(digit * 2 for digit in digits)
    return f"#{digits}" if re.fullmatch(r"[0-9a-f]{6}", digits) else None


def _channels(color):
    return tuple(int(color[i : i + 2], 16) / 255 for i in (1, 3, 5))


def _hex(channels):
    return "#" + "".join(f"{round(min(max(c, 0), 1) * 255):02x}" for c in channels)


def _linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _gamma(channel):
    return 12.92 * channel if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055


def _luminance(color):
    r, g, b = (_linear(c) for c in _channels(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(first, second):
    """The WCAG contrast ratio of two #rrggbb colors, from 1 to 21."""
    lighter, darker = sorted((_luminance(first), _luminance(second)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def foreground(color):
    """White or near-black, whichever reads better on `color`."""
    return max((WHITE, NEAR_BLACK), key=lambda text: contrast(color, text))


def _oklab(color):
    r, g, b = (_linear(c) for c in _channels(color))
    lms = (
        (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3),
        (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3),
        (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3),
    )
    l_, m_, s_ = lms
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def _linear_rgb(lightness, a, b):
    l_ = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076127090 * s_,
    )


def _oklch_color(lightness, chroma, hue):
    """The sRGB color of an OKLCH lightness and hue, with as much of `chroma` as fits."""

    def channels(c):
        return _linear_rgb(lightness, c * math.cos(hue), c * math.sin(hue))

    def fits(c):
        return all(-1e-9 <= channel <= 1 + 1e-9 for channel in channels(c))

    low, high = 0.0, chroma
    if not fits(high):
        for _ in range(24):
            middle = (low + high) / 2
            low, high = (middle, high) if fits(middle) else (low, middle)
        high = low
    return _hex(_gamma(min(max(channel, 0), 1)) for channel in channels(high))


@cache
def dark_accent(color):
    """`color` for dark pages: as chosen, or lighter until it reads on the dark background.

    Lightening keeps the hue and as much of the chroma as sRGB allows, so a deep blue
    becomes a light blue rather than a gray.
    """
    if contrast(color, NEAR_BLACK) >= DARK_CONTRAST:
        return color
    lightness, a, b = _oklab(color)
    chroma, hue = math.hypot(a, b), math.atan2(b, a)
    steps = 200
    for step in range(1, steps + 1):
        lighter = _oklch_color(lightness + (1 - lightness) * step / steps, chroma, hue)
        if contrast(lighter, NEAR_BLACK) >= DARK_CONTRAST:
            return lighter
    return WHITE


def _root(accent, indent):
    text = foreground(accent)
    declarations = [f"{name}: {accent};" for name in ACCENT_PROPERTIES]
    declarations += [f"{name}: {text};" for name in FOREGROUND_PROPERTIES]
    lines = [":root {", *(f"  {line}" for line in declarations), "}"]
    return "".join(f"{indent}{line}\n" for line in lines)


@cache
def stylesheet(color):
    """The stylesheet that makes `color` the accent of light and dark pages."""
    return (
        "/* The accent color from the Appearance settings, over ui.css. */\n"
        + _root(color, "")
        + "@media (prefers-color-scheme: dark) {\n"
        + _root(dark_accent(color), "  ")
        + "}\n"
    )


def digest(color):
    """Names the stylesheet of `color` in its link, so browsers fetch a new one at once."""
    return hashlib.sha256(stylesheet(color).encode()).hexdigest()[:16]
