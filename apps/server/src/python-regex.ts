/**
 * Template field patterns were written for Python's `re` (the Django version
 * matched them with re.fullmatch on str values), and installations keep them.
 * This translates such a pattern into a JavaScript RegExp with the same
 * meaning, or returns null when JavaScript has no equivalent:
 *
 * - leading global flags (?aimsx) and scoped (?i:…), (?-i:…), (?s:…);
 * - \A, \Z, ^ and $ (Python's $ also matches before a final newline), . (no
 *   newline unless (?s));
 * - \d, \w, \s, \b and their negations are Unicode-aware, as for Python str
 *   patterns ((?a) makes them ASCII);
 * - (?P<name>…), (?P=name), (?#…) comments, verbose mode (?x);
 * - Python's escapes (\a, \U, octal) and its literal braces;
 * - possessive quantifiers, atomic groups, conditionals, \N{…} and scoped
 *   flags other than i and s have no translation (null).
 */

const UNICODE_DIGIT = "\\p{Nd}";
const UNICODE_WORD = "\\p{L}\\p{N}_";
// str.isspace(): the whitespace Python's \s matches.
const UNICODE_SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const ASCII_DIGIT = "0-9";
const ASCII_WORD = "A-Za-z0-9_";
const ASCII_SPACE = " \\t\\n\\r\\f\\v";

/** Characters that may be escaped in a JavaScript `u` pattern as themselves. */
const SYNTAX = new Set("^$\\.*+?()[]{}|/".split(""));

type Flags = { ascii: boolean; ignoreCase: boolean; multiline: boolean; dotAll: boolean; verbose: boolean };

class Untranslatable extends Error {}

function codePoint(value: number): string {
  return `\\u{${value.toString(16)}}`;
}

/** A literal character (`-` needs its escape only inside a class). */
function literal(char: string, inClass = false): string {
  if (SYNTAX.has(char) || (inClass && char === "-")) return `\\${char}`;
  const value = char.codePointAt(0)!;
  return value < 0x20 || value === 0x7f ? codePoint(value) : char;
}

class Translator {
  private at = 0;
  private readonly chars: string[];

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
    const out = this.sequence();
    // A ) without its ( is an error in Python too.
    if (this.at < this.chars.length) throw new Untranslatable("unbalanced parenthesis");
    return out;
  }

  /** Atoms up to the ) that closes the current group (not consumed). */
  private sequence(): string {
    let out = "";
    while (this.at < this.chars.length && this.chars[this.at] !== ")") out += this.atom();
    return out;
  }

  /** The rest of a group after its opening, with its closing parenthesis. */
  private body(): string {
    const out = this.sequence();
    if (this.chars[this.at] !== ")") throw new Untranslatable("unterminated group");
    this.at += 1;
    return out;
  }

  private atom(): string {
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
      case "\\":
        return this.escape(false);
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
      case "*":
      case "+":
      case "?":
        this.at += 1;
        // Possessive quantifiers (Python 3.11) have no JavaScript form.
        if (this.peek() === "+") throw new Untranslatable("possessive quantifier");
        return char;
      default:
        this.at += 1;
        return char === "|" ? char : literal(char);
    }
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

  private group(): string {
    if (this.peek(1) !== "?") {
      this.at += 1;
      return `(${this.body()})`;
    }
    const rest = this.chars.slice(this.at).join("");
    let match: RegExpExecArray | null;
    if ((match = /^\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest))) {
      this.at += match[0].length;
      return `(?<${match[1]}>${this.body()})`;
    }
    if ((match = /^\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/.exec(rest))) {
      this.at += match[0].length;
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
        return `${prefix}${this.body()})`;
      }
    }
    // Scoped flags: JavaScript has modifiers for i; s is translated here.
    if ((match = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?:/.exec(rest))) {
      const on = match[1] ?? "";
      const off = match[2] ?? "";
      if (/[^is]/.test(on + off) || (!on && !off)) throw new Untranslatable("scoped flag");
      this.at += match[0].length;
      const saved = { ...this.flags };
      if (on.includes("s")) this.flags.dotAll = true;
      if (off.includes("s")) this.flags.dotAll = false;
      const inner = this.body();
      this.flags = saved;
      const modifiers = `${on.includes("i") ? "i" : ""}${off.includes("i") ? "-i" : ""}`;
      return `(?${modifiers}:${inner})`;
    }
    // Atomic groups, conditionals and anything else.
    throw new Untranslatable("group");
  }

  private characterClass(): string {
    this.at += 1;
    let out = "[";
    if (this.peek() === "^") {
      out += "^";
      this.at += 1;
    }
    // A ] right after [ or [^ is a literal one in Python.
    if (this.peek() === "]") {
      out += "\\]";
      this.at += 1;
    }
    while (this.at < this.chars.length && this.chars[this.at] !== "]") {
      const char = this.chars[this.at]!;
      if (char === "\\") out += this.escape(true);
      else if (char === "[") {
        out += "\\[";
        this.at += 1;
      } else if (char === "-") {
        out += "-";
        this.at += 1;
      } else {
        out += literal(char, true);
        this.at += 1;
      }
    }
    if (this.chars[this.at] !== "]") throw new Untranslatable("unterminated class");
    this.at += 1;
    return `${out}]`;
  }

  private escape(inClass: boolean): string {
    const next = this.peek(1);
    if (next === undefined) throw new Untranslatable("trailing backslash");
    this.at += 2;
    const { digit, word, space } = this.classes();
    switch (next) {
      case "d":
        return inClass ? digit : `[${digit}]`;
      case "w":
        return inClass ? word : `[${word}]`;
      case "s":
        return inClass ? space : `[${space}]`;
      case "D":
      case "W":
      case "S": {
        const set = next === "D" ? digit : next === "W" ? word : space;
        if (inClass) {
          if (next === "D" && !this.flags.ascii) return "\\P{Nd}";
          throw new Untranslatable("negated class in a class");
        }
        return `[^${set}]`;
      }
      case "b":
        if (inClass) return "\\x08";
        return `(?:(?<=[${word}])(?![${word}])|(?<![${word}])(?=[${word}]))`;
      case "B":
        if (inClass) throw new Untranslatable("\\B in a class");
        return `(?:(?<=[${word}])(?=[${word}])|(?<![${word}])(?![${word}]))`;
      case "A":
        if (inClass) throw new Untranslatable("\\A in a class");
        return "^";
      case "Z":
        if (inClass) throw new Untranslatable("\\Z in a class");
        return "$";
      case "a":
        return "\\x07";
      case "f":
      case "n":
      case "r":
      case "t":
      case "v":
        return `\\${next}`;
      case "x": {
        const hex = this.chars.slice(this.at, this.at + 2).join("");
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Untranslatable("bad \\x escape");
        this.at += 2;
        return codePoint(parseInt(hex, 16));
      }
      case "u":
      case "U": {
        const length = next === "u" ? 4 : 8;
        const hex = this.chars.slice(this.at, this.at + length).join("");
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new Untranslatable("bad \\u escape");
        const value = parseInt(hex, 16);
        if (value > 0x10ffff) throw new Untranslatable("bad \\U escape");
        this.at += length;
        return codePoint(value);
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
      return codePoint(value);
    }
    if (/[1-9]/.test(next)) {
      if (inClass) throw new Untranslatable("backreference in a class");
      let digits = next;
      if (/[0-9]/.test(this.peek() ?? "")) {
        digits += this.peek();
        this.at += 1;
      }
      return `(?:\\${digits})`;
    }
    // Python refuses unknown ASCII letter escapes (re.error); other characters stand for themselves.
    if (/[A-Za-z0-9]/.test(next)) throw new Untranslatable(`bad escape \\${next}`);
    return literal(next, inClass);
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
    result = new RegExp(`^(?:${source})$`, flags.ignoreCase ? "iu" : "u");
  } catch {
    result = null;
  }
  if (cache.size > 1000) cache.clear();
  cache.set(pattern, result);
  return result;
}
