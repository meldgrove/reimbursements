/**
 * Template field patterns keep their Python meaning (review I4/A7). The
 * expected results are what Python 3.13's re.fullmatch answers, as the
 * Django version matched them.
 */
import { describe, expect, it } from "vitest";
import { pythonFullmatch } from "./python-regex";

describe("pythonFullmatch", () => {
  it.each([
    ["(?i)kst-\\d{4}", "KST-1234", true],
    ["(?i)kst-\\d{4}", "kst-1234", true],
    ["(?i)kst-\\d{4}", "KST-123", false],
    ["(?i)kst-\\d{4}", "KST-12345", false],
    ["\\d{4}", "1234", true],
    ["\\d{4}", "١٢٣٤", true],
    ["\\d{4}", "12a4", false],
    ["\\d{4}", "1234\n", false],
    ["(?a)\\d{4}", "1234", true],
    ["(?a)\\d{4}", "١٢٣٤", false],
    ["\\w+", "Kostenträger", true],
    ["\\w+", "abc_1", true],
    ["\\w+", "a-b", false],
    ["\\w+", "Ⅻ", true],
    ["[\\w-]+", "a-b", true],
    ["[\\w-]+", "ä-ö", true],
    ["[\\w-]+", "a b", false],
    ["\\s?x", " x", true],
    ["\\s?x", "\u001cx", true],
    ["\\s?x", "﻿x", false],
    ["\\s?x", "x", true],
    ["\\AKST\\Z", "KST", true],
    ["\\AKST\\Z", "KST\n", false],
    ["KST$", "KST", true],
    ["^KST$", "KST", true],
    ["(?P<p>[A-Z]{2})-(?P=p)", "AB-AB", true],
    ["(?P<p>[A-Z]{2})-(?P=p)", "AB-CD", false],
    ["a{,2}", "", true],
    ["a{,2}", "aa", true],
    ["a{,2}", "aaa", false],
    ["a{,}", "aaaa", true],
    ["a{2}", "aa", true],
    ["a{2}", "a", false],
    ["{x}", "{x}", true],
    ["a{}", "a{}", true],
    ["x}", "x}", true],
    ["[]a]+", "]a]", true],
    ["[]a]+", "b", false],
    ["[^]a]", "b", true],
    ["[^]a]", "]", false],
    ["(?x) \\d{2} # two digits", "12", true],
    ["(?x) \\d{2} # two digits", "1 2", false],
    ["(?x)[ ]a", " a", true],
    ["(?x)[ ]a", "a", false],
    ["(?s)a.b", "a\nb", true],
    ["a.b", "a\nb", false],
    ["a.b", "a\rb", true],
    ["a.b", "a-b", true],
    ["(?i:ab)c", "ABc", true],
    ["(?i:ab)c", "ABC", false],
    ["\\bKST\\b", "KST", true],
    ["K\\.T", "K.T", true],
    ["K\\.T", "KxT", false],
    ["K\\-T", "K-T", true],
    ["K\\:T", "K:T", true],
    ["\\x41Ä\\U0001F600", "AÄ😀", true],
    ["\\101", "A", true],
    ["\\0", "\u0000", true],
    ["(a)\\1", "aa", true],
    ["(a)\\1", "ab", false],
    ["(?#note)ab", "ab", true],
    ["(?i)straße", "STRASSE", false],
    ["(?i)straße", "Straße", true],
    ["(?i)straße", "STRAßE", true],
    ["[A-Z]{2}\\d{2}", "DE12", true],
    ["[A-Z]{2}\\d{2}", "de12", false],
    ["\\D+", "abc", true],
    ["\\D+", "a1", false],
    ["[\\D]+", "abc", true],
    ["[\\D]+", "a1", false],
    ["\\W", "-", true],
    ["\\W", "a", false],
    ["\\S+", "ab", true],
    ["\\S+", "a b", false],
  ] as const)("%s on %j is %s, as in Python", (pattern, value, expected) => {
    expect(pythonFullmatch(pattern)?.test(value)).toBe(expected);
  });

  // Invalid in Python, or without a JavaScript form: refused at template save.
  it.each(["a++", "(?>a)", "\\q", "(?L)a", "[", "a)"])("%s has no translation", (pattern) => {
    expect(pythonFullmatch(pattern)).toBeNull();
  });
});
