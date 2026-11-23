/**
 * Template field patterns were written for Python's `re` (the Django version
 * matched them with re.fullmatch on str values), and installations keep them.
 * This translates such a pattern into a JavaScript RegExp (unicodeSets mode,
 * `v`) with the same meaning, or returns null when JavaScript has no
 * equivalent:
 *
 * - leading global flags (?aimsux) and scoped ones (?aimsux-imsx:…);
 * - \A, \Z, ^ and $ (Python's $ also matches before a final newline), . (no
 *   newline unless (?s));
 * - \d, \w, \s, \b and their negations are Unicode-aware, as for Python str
 *   patterns ((?a) makes them ASCII), also inside classes ([\W_]);
 * - case-insensitive matching as Python's: Unicode case folding plus Python's
 *   own pairs (İ and ı match i and I); with (?a) only ASCII letters fold;
 * - (?P<name>…), (?P=name) and \1 when the group takes part in every match
 *   that reaches the reference (JavaScript matches a missing group as empty,
 *   Python fails); (?#…) comments, verbose mode (?x);
 * - Python's escapes (\a, \U, octal) and its literal braces;
 * - possessive quantifiers, atomic groups, conditionals, \N{…}, (?L) and
 *   other backreferences have no translation (null).
 */

const UNICODE_DIGIT = "\\p{Nd}";
const UNICODE_WORD = "\\p{L}\\p{N}_";
// str.isspace(): the whitespace Python's \s matches.
const UNICODE_SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const ASCII_DIGIT = "0-9";
const ASCII_WORD = "A-Za-z0-9_";
const ASCII_SPACE = " \\t\\n\\r\\f\\v";

/** Characters escaped outside a class (JavaScript's syntax characters). */
const SYNTAX = new Set("^$\\.*+?()[]{}|/".split(""));
/** Characters escaped inside a `v` class: the syntax characters and the reserved punctuators. */
const CLASS_SYNTAX = new Set([...SYNTAX, ..."&-!#%,:;<=>@`~".split("")]);

/** i, I, İ (U+0130) and ı (U+0131): one class under Python's IGNORECASE, two in JavaScript's folding. */
const DOTTED_I = [0x69, 0x49, 0x130, 0x131];

type Flags = { ascii: boolean; ignoreCase: boolean; multiline: boolean; dotAll: boolean; verbose: boolean };

/** A group of the pattern: whether it may be skipped, or never be part of a match. */
type Frame = { optional: boolean; lookaround: boolean };
/** A sequence of alternatives (the pattern, or a group's body). */
type Sequence = { alternatives: boolean };
type Capture = { frames: Frame[]; sequences: Sequence[]; closed: boolean };
type Reference = { target: number | string; closedThen: boolean };

/** One item of a class: a single character, or a set such as \w. */
type ClassItem = { char: number } | { set: string };

class Untranslatable extends Error {}

function codePoint(value: number): string {
  return `\\u{${value.toString(16)}}`;
}

/** A literal character, escaped where JavaScript needs it. */
function literal(value: number, inClass = false): string {
  const char = String.fromCodePoint(value);
  if ((inClass ? CLASS_SYNTAX : SYNTAX).has(char)) return `\\${char}`;
  return value < 0x20 || value === 0x7f ? codePoint(value) : char;
}

const isAsciiUpper = (value: number) => value >= 0x41 && value <= 0x5a;
const isAsciiLower = (value: number) => value >= 0x61 && value <= 0x7a;

class Translator {
  private at = 0;
  private readonly chars: string[];
  /** Whether JavaScript's own case folding (the `i` modifier) is on where the translator is now. */
  private foldCase = false;
  private readonly frames: Frame[] = [];
  private readonly sequences: Sequence[] = [];
  private readonly captures: Capture[] = [];
  private readonly names = new Map<string, number>();
  private readonly references: Reference[] = [];

  constructor(
    pattern: string,
    private flags: Flags,
  ) {
    this.chars = Array.from(pattern);
  }

  private peek(offset = 0): string | undefined {
    return this.chars[this.at + offset];
  }

  private classes() {
    return this.flags.ascii
      ? { digit: ASCII_DIGIT, word: ASCII_WORD, space: ASCII_SPACE }
      : { digit: UNICODE_DIGIT, word: UNICODE_WORD, space: UNICODE_SPACE };
  }

  /** The leading global flags, e.g. (?i) or (?ax). */
  globalFlags() {
    while (this.peek() === "(" && this.peek(1) === "?") {
      let end = this.at + 2;
      while (end < this.chars.length && /[aiLmsux]/.test(this.chars[end]!)) end += 1;
      if (this.chars[end] !== ")" || end === this.at + 2) return;
      for (const flag of this.chars.slice(this.at + 2, end)) {
        if (flag === "a") this.flags.ascii = true;
        else if (flag === "i") this.flags.ignoreCase = true;
        else if (flag === "m") this.flags.multiline = true;
        else if (flag === "s") this.flags.dotAll = true;
        else if (flag === "x") this.flags.verbose = true;
        else if (flag === "L") throw new Untranslatable("locale flag");
      }
      this.at = end + 1;
    }
  }

  translate(): string {
    const fold = this.flags.ignoreCase && !this.flags.ascii;
    this.foldCase = fold;
    const out = this.sequence();
    // A ) without its ( is an error in Python too.
    if (this.at < this.chars.length) throw new Untranslatable("unbalanced parenthesis");
    this.checkReferences();
    return fold ? `(?i:${out})` : out;
  }

  /**
   * Python fails a reference to a group that did not take part in the match;
   * JavaScript matches it as empty. A reference is kept only when its group
   * closed before it and takes part in every match: not optional, not in a
   * lookaround, and with no alternative beside it at any level.
   */
  private checkReferences() {
    for (const reference of this.references) {
      const index =
        typeof reference.target === "number" ? reference.target : this.names.get(reference.target);
      const capture = index === undefined ? undefined : this.captures[index - 1];
      if (!capture || !reference.closedThen) throw new Untranslatable("invalid group reference");
      const uncertain =
        capture.frames.some((frame) => frame.optional || frame.lookaround) ||
        capture.sequences.some((sequence) => sequence.alternatives);
      if (uncertain) throw new Untranslatable("reference to a group that may not take part");
    }
  }

  /** Atoms up to the ) that closes the current group (not consumed). */
  private sequence(): string {
    const sequence: Sequence = { alternatives: false };
    this.sequences.push(sequence);
    let out = "";
    while (this.at < this.chars.length && this.chars[this.at] !== ")") out += this.atom(sequence);
    this.sequences.pop();
    return out;
  }

  /** The rest of a group after its opening, with its closing parenthesis. */
  private body(frame: Frame): string {
    this.frames.push(frame);
    const out = this.sequence();
    this.frames.pop();
    if (this.chars[this.at] !== ")") throw new Untranslatable("unterminated group");
    this.at += 1;
    // A quantifier that allows no repetition makes the group optional.
    let next = this.at;
    while (this.flags.verbose && next < this.chars.length && /\s/.test(this.chars[next]!)) next += 1;
    const rest = this.chars.slice(next, next + 12).join("");
    if (/^[?*]/.test(rest) || /^\{(0*,|,|0+\}|0+,)/.test(rest)) frame.optional = true;
    return out;
  }

  private atom(sequence: Sequence): string {
    const char = this.chars[this.at]!;
    if (this.flags.verbose) {
      if (/\s/.test(char)) {
        this.at += 1;
        return "";
      }
      if (char === "#") {
        while (this.at < this.chars.length && this.chars[this.at] !== "\n") this.at += 1;
        return "";
      }
    }
    switch (char) {
      case "\\": {
        const item = this.escape(false);
        return "set" in item ? item.set : this.char(item.char);
      }
      case "[":
        return this.characterClass();
      case "(":
        return this.group();
      case ".":
        this.at += 1;
        return this.flags.dotAll ? "[\\s\\S]" : "[^\\n]";
      case "^":
        this.at += 1;
        return this.flags.multiline ? "(?:^|(?<=\\n))" : "^";
      case "$":
        this.at += 1;
        return this.flags.multiline ? "(?=\\n|$)" : "(?=\\n?$)";
      case "{":
        return this.brace();
      case "}":
        this.at += 1;
        return "\\}";
      case "|":
        this.at += 1;
        sequence.alternatives = true;
        return "|";
      case "*":
      case "+":
      case "?":
        this.at += 1;
        // Possessive quantifiers (Python 3.11) have no JavaScript form.
        if (this.peek() === "+") throw new Untranslatable("possessive quantifier");
        return char;
      default:
        this.at += 1;
        return this.char(char.codePointAt(0)!);
    }
  }

  /** A literal character outside a class, folding case as Python does. */
  private char(value: number): string {
    if (this.flags.ignoreCase && this.flags.ascii) {
      if (isAsciiUpper(value)) return `[${literal(value, true)}${literal(value + 32, true)}]`;
      if (isAsciiLower(value)) return `[${literal(value - 32, true)}${literal(value, true)}]`;
    } else if (this.flags.ignoreCase && DOTTED_I.includes(value)) {
      return `[${DOTTED_I.map((point) => literal(point, true)).join("")}]`;
    }
    return literal(value);
  }

  /** A quantifier {m}, {m,}, {m,n} or {,n}; any other brace is a literal one, as in Python. */
  private brace(): string {
    const rest = this.chars.slice(this.at).join("");
    const match = /^\{(\d*)(,?)(\d*)\}/.exec(rest);
    // {} and braces that are not a quantifier are literal ones; {,n} and {,} start at 0.
    if (!match || (!match[1] && !match[2])) {
      this.at += 1;
      return "\\{";
    }
    this.at += match[0].length;
    if (this.peek() === "+") throw new Untranslatable("possessive quantifier");
    return match[2] ? `{${match[1] || "0"},${match[3]}}` : `{${match[1]}}`;
  }

  /** A capturing group: its number, the groups and sequences it sits in. */
  private capture(frame: Frame, name?: string): Capture {
    const capture: Capture = {
      frames: [...this.frames, frame],
      sequences: [...this.sequences],
      closed: false,
    };
    this.captures.push(capture);
    if (name !== undefined) {
      if (this.names.has(name)) throw new Untranslatable("redefinition of a group name");
      this.names.set(name, this.captures.length);
    }
    return capture;
  }

  private reference(target: number | string): void {
    const index = typeof target === "number" ? target : this.names.get(target);
    const capture = index === undefined ? undefined : this.captures[index - 1];
    this.references.push({ target, closedThen: capture?.closed ?? false });
  }

  private group(): string {
    const frame: Frame = { optional: false, lookaround: false };
    if (this.peek(1) !== "?") {
      this.at += 1;
      const capture = this.capture(frame);
      const inner = this.body(frame);
      capture.closed = true;
      return `(${inner})`;
    }
    const rest = this.chars.slice(this.at).join("");
    let match: RegExpExecArray | null;
    if ((match = /^\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest))) {
      this.at += match[0].length;
      const capture = this.capture(frame, match[1]!);
      const inner = this.body(frame);
      capture.closed = true;
      return `(?<${match[1]}>${inner})`;
    }
    if ((match = /^\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/.exec(rest))) {
      this.at += match[0].length;
      this.reference(match[1]!);
      return `\\k<${match[1]}>`;
    }
    if (rest.startsWith("(?#")) {
      const end = rest.indexOf(")");
      if (end < 0) throw new Untranslatable("unterminated comment");
      this.at += end + 1;
      return "";
    }
    for (const prefix of ["(?:", "(?=", "(?!", "(?<=", "(?<!"]) {
      if (rest.startsWith(prefix)) {
        this.at += prefix.length;
        frame.lookaround = prefix !== "(?:";
        return `${prefix}${this.body(frame)})`;
      }
    }
    // Scoped flags (?aimsux-imsx:…).
    if ((match = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?:/.exec(rest))) {
      const on = match[1] ?? "";
      const off = match[2] ?? "";
      if (/[^aimsux]/.test(on) || /[^imsx]/.test(off) || (!on && !off))
        throw new Untranslatable("scoped flag");
      this.at += match[0].length;
      const saved = { ...this.flags };
      const savedFold = this.foldCase;
      for (const flag of on) {
        if (flag === "a") this.flags.ascii = true;
        else if (flag === "i") this.flags.ignoreCase = true;
        else if (flag === "m") this.flags.multiline = true;
        else if (flag === "s") this.flags.dotAll = true;
        else if (flag === "x") this.flags.verbose = true;
      }
      for (const flag of off) {
        if (flag === "i") this.flags.ignoreCase = false;
        else if (flag === "m") this.flags.multiline = false;
        else if (flag === "s") this.flags.dotAll = false;
        else if (flag === "x") this.flags.verbose = false;
      }
      const fold = this.flags.ignoreCase && !this.flags.ascii;
      this.foldCase = fold;
      const inner = this.body(frame);
      this.flags = saved;
      this.foldCase = savedFold;
      if (fold === savedFold) return `(?:${inner})`;
      return fold ? `(?i:${inner})` : `(?-i:${inner})`;
    }
    // Atomic groups, conditionals and anything else.
    throw new Untranslatable("group");
  }

  /** One item of a class; a ] right after [ or [^ is a literal one, as in Python. */
  private classItem(): ClassItem {
    const char = this.chars[this.at]!;
    if (char === "\\") return this.escape(true);
    this.at += 1;
    return { char: char.codePointAt(0)! };
  }

  private characterClass(): string {
    this.at += 1;
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.at += 1;
    }
    const parts: string[] = [];
    const ranges: [number, number][] = [];
    let first = true;
    while (this.at < this.chars.length && (first || this.chars[this.at] !== "]")) {
      first = false;
      const item = this.classItem();
      if ("set" in item) {
        parts.push(item.set);
        continue;
      }
      // a-z is a range; a - at the start or end (or after a range) is a literal one.
      if (this.peek() === "-" && this.peek(1) !== undefined && this.peek(1) !== "]") {
        this.at += 1;
        const end = this.classItem();
        if ("set" in end || end.char < item.char) throw new Untranslatable("bad character range");
        parts.push(`${literal(item.char, true)}-${literal(end.char, true)}`);
        ranges.push([item.char, end.char]);
      } else {
        parts.push(literal(item.char, true));
        ranges.push([item.char, item.char]);
      }
    }
    if (this.chars[this.at] !== "]") throw new Untranslatable("unterminated class");
    this.at += 1;
    if (this.flags.ignoreCase && this.flags.ascii) {
      // Only ASCII letters fold under (?a).
      for (const [low, high] of ranges) {
        for (const [from, to, shift] of [
          [0x41, 0x5a, 32],
          [0x61, 0x7a, -32],
        ] as const) {
          const start = Math.max(low, from);
          const stop = Math.min(high, to);
          if (start <= stop) parts.push(`${literal(start + shift, true)}-${literal(stop + shift, true)}`);
        }
      }
    } else if (
      this.flags.ignoreCase &&
      ranges.some(([low, high]) => DOTTED_I.some((point) => low <= point && point <= high))
    ) {
      parts.push(...DOTTED_I.map((point) => literal(point, true)));
    }
    return `[${negated ? "^" : ""}${parts.join("")}]`;
  }

  /** An escape: one character, or a set or assertion (as JavaScript source). */
  private escape(inClass: boolean): ClassItem {
    const next = this.peek(1);
    if (next === undefined) throw new Untranslatable("trailing backslash");
    this.at += 2;
    const { digit, word, space } = this.classes();
    switch (next) {
      case "d":
        return { set: `[${digit}]` };
      case "w":
        return { set: `[${word}]` };
      case "s":
        return { set: `[${space}]` };
      case "D":
        return { set: `[^${digit}]` };
      case "W":
        return { set: `[^${word}]` };
      case "S":
        return { set: `[^${space}]` };
      case "b":
        if (inClass) return { char: 0x08 };
        return { set: `(?:(?<=[${word}])(?![${word}])|(?<![${word}])(?=[${word}]))` };
      case "B":
        if (inClass) throw new Untranslatable("\\B in a class");
        return { set: `(?:(?<=[${word}])(?=[${word}])|(?<![${word}])(?![${word}]))` };
      case "A":
        if (inClass) throw new Untranslatable("\\A in a class");
        return { set: "^" };
      case "Z":
        if (inClass) throw new Untranslatable("\\Z in a class");
        return { set: "$" };
      case "a":
        return { char: 0x07 };
      case "f":
        return { char: 0x0c };
      case "n":
        return { char: 0x0a };
      case "r":
        return { char: 0x0d };
      case "t":
        return { char: 0x09 };
      case "v":
        return { char: 0x0b };
      case "x": {
        const hex = this.chars.slice(this.at, this.at + 2).join("");
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Untranslatable("bad \\x escape");
        this.at += 2;
        return { char: parseInt(hex, 16) };
      }
      case "u":
      case "U": {
        const length = next === "u" ? 4 : 8;
        const hex = this.chars.slice(this.at, this.at + length).join("");
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new Untranslatable("bad \\u escape");
        const value = parseInt(hex, 16);
        if (value > 0x10ffff) throw new Untranslatable("bad \\U escape");
        this.at += length;
        return { char: value };
      }
      default:
        break;
    }
    if (
      /[0-7]/.test(next) &&
      (next === "0" || /^[0-7]{2}$/.test(this.chars.slice(this.at, this.at + 2).join("")))
    ) {
      // Octal: \0 with up to two more digits, or three octal digits.
      let digits = next;
      for (let index = 0; index < 2 && /[0-7]/.test(this.peek() ?? ""); index += 1) {
        digits += this.peek();
        this.at += 1;
      }
      const value = parseInt(digits, 8);
      if (value > 0o377) throw new Untranslatable("octal escape");
      return { char: value };
    }
    if (/[1-9]/.test(next)) {
      if (inClass) throw new Untranslatable("numeric escape in a class");
      let digits = next;
      if (/[0-9]/.test(this.peek() ?? "")) {
        digits += this.peek();
        this.at += 1;
      }
      this.reference(Number(digits));
      return { set: `(?:\\${digits})` };
    }
    // Python refuses unknown ASCII letter escapes (re.error); other characters stand for themselves.
    if (/[A-Za-z0-9]/.test(next)) throw new Untranslatable(`bad escape \\${next}`);
    return { char: next.codePointAt(0)! };
  }
}

const cache = new Map<string, RegExp | null>();

/**
 * A Python `re` pattern as a JavaScript RegExp that matches whole values
 * (re.fullmatch), or null when it cannot be translated or compiled.
 */
export function pythonFullmatch(pattern: string): RegExp | null {
  if (cache.has(pattern)) return cache.get(pattern)!;
  let result: RegExp | null;
  try {
    const flags: Flags = { ascii: false, ignoreCase: false, multiline: false, dotAll: false, verbose: false };
    const translator = new Translator(pattern, flags);
    translator.globalFlags();
    const source = translator.translate();
    result = new RegExp(`^(?:${source})$`, "v");
  } catch {
    result = null;
  }
  if (cache.size > 1000) cache.clear();
  cache.set(pattern, result);
  return result;
}
