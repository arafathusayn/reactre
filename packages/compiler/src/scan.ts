// A single-pass scanner for JavaScript source, shared by the two JSX compilers
// (@reactre/compiler and @reactre/compat/compiler): it skips literals, comments, templates and
// regular expressions, and finds the top-level parts of an argument list.
//
// Both compilers work on the JavaScript that Bun's transpiler prints, as text: they find jsx calls,
// split their argument lists and copy everything else through. That needs only a small part of a
// parser: skip string literals, template literals, comments and regular expressions (so a bracket
// or comma inside one is not mistaken for code), track bracket depth, and split an argument list
// at its top-level commas. A full parser would cost far more per file and would still have to
// print the code back out.
//
// Design decisions:
//   - No tokens or trees are built. Every function walks the string by index and returns an index
//     or slices, so scanning allocates little.
//   - Whether a slash starts a regular expression or divides is decided from the last significant
//     character or word before it, the usual heuristic. It suits the code Bun prints, which is all
//     the compilers read.
//   - Callers keep their own `prev` and `word` state while they walk, and pass it to skipToken, so
//     the same rules hold in every loop that scans source.

// #region Characters and words

/** Opening brackets, by position matching CLOSE. */
export const OPEN = "([{";
/** Closing brackets, by position matching OPEN. */
export const CLOSE = ")]}";

// After these characters, or these words, a slash starts a regular expression: each ends where an
// operand is expected. `)` and `]` are absent because an operand ends there, so a slash after them
// divides.
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);

/** Whether `c` can be part of an identifier (or a number); false past the end of the source. */
export const isIdent = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

// #endregion

// #region Scanning

/**
 * Skips the string literal, template literal, comment or regular expression that starts at `i`.
 *
 * @param prev The last significant character before `i`: `"a"` after an operand (a name, a number
 *   or a literal), `""` at the start.
 * @param word The identifier just before `i`, or `""` when the last token was not one.
 * @returns The index just past the literal, comment or template that starts at `i`, or `i` itself
 *   when none starts there. A line comment ends at its newline, which is left for the caller. An
 *   unterminated token runs to the end of the source.
 */
export function skipToken(src: string, i: number, prev: string, word: string): number {
  const c = src[i];
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === c) return j + 1;
    }
    return src.length;
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === "`") return j + 1;
      // A substitution is code: `until` finds its closing brace past any nested literals or
      // templates, and the loop's j++ steps over that brace.
      else if (src[j] === "$" && src[j + 1] === "{") j = until(src, j + 2, "}");
    }
    return src.length;
  }
  if (c === "/") {
    if (src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      return e < 0 ? src.length : e;
    }
    if (src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      return e < 0 ? src.length : e + 2;
    }
    // A regular expression only where an operand is expected; elsewhere the slash divides.
    if (prev === "" || REGEX_AFTER.has(prev) || REGEX_WORDS.has(word)) {
      // A slash inside a character class ([/]) does not end the expression.
      let inClass = false;
      for (let j = i + 1; j < src.length; j++) {
        const d = src[j];
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          j++;
          // The flags (g, i, m, ...) belong to the expression.
          while (isIdent(src[j])) j++;
          return j;
        }
      }
    }
  }
  return i;
}

/**
 * Walks `src` from `i` at bracket depth 0 and finds where an expression or argument ends.
 *
 * @param stops Characters to stop at, at depth 0 only. `""` stops at nothing, so the walk finds
 *   the bracket that closes the enclosing one.
 * @returns The index of the first of `stops` found at depth 0, or of the bracket that closes the
 *   enclosing one, or `src.length` when neither is found.
 */
export function until(src: string, i: number, stops: string): number {
  let depth = 0,
    prev = "",
    word = "";
  while (i < src.length) {
    const c = src[i]!;
    const j = skipToken(src, i, prev, word);
    if (j !== i) {
      prev = "a"; // a literal ends like an operand
      word = "";
      i = j;
      continue;
    }
    if (depth === 0 && stops.includes(c)) return i;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) return i;
      depth--;
    }
    // A whole name (or number) at once: a slash after it divides, unless the name is a keyword in
    // REGEX_WORDS, which skipToken checks through `word`.
    if (isIdent(c)) {
      let e = i;
      while (isIdent(src[e])) e++;
      word = src.slice(i, e);
      prev = "a";
      i = e;
      continue;
    }
    // Whitespace does not count as the previous character: after `x = ` a slash still starts a
    // regular expression.
    if (!/\s/.test(c)) {
      prev = c;
      word = "";
    }
    i++;
  }
  return i;
}

/**
 * The top-level comma-separated parts of `src[start, end)`, trimmed, with empty parts dropped (so
 * a trailing comma adds nothing). Commas inside brackets, literals, templates and comments do not
 * split.
 */
export function split(src: string, start: number, end: number): string[] {
  const out: string[] = [];
  let i = start;
  while (i < end) {
    const j = Math.min(until(src, i, ","), end);
    const part = src.slice(i, j).trim();
    if (part) out.push(part);
    i = j + 1;
  }
  return out;
}

// #endregion

// #region Literals

/** What `literal` returns for source that is not a literal it knows (undefined is a literal). */
export const NOT_LITERAL: unique symbol = Symbol("not a literal");

/**
 * The value of a string, number, boolean, null or undefined literal, or NOT_LITERAL.
 *
 * The compilers use it to put constant attributes and text straight into a template instead of a
 * hole. Anything it does not recognize stays an expression, which is always correct, only slower.
 */
export function literal(src: string): unknown {
  if (src === "true") return true;
  if (src === "false") return false;
  if (src === "null") return null;
  if (src === "undefined" || src === "void 0") return undefined;
  // Plain decimals only. Hex, exponents and separators stay expressions.
  if (/^-?\d+(\.\d+)?$/.test(src)) return Number(src);
  // Bun prints strings in double quotes, so JSON.parse decodes most of them. The scan rejects
  // source that only starts and ends with a quote, such as `"a")("b"`. An escape JSON lacks
  // (\x41, \') makes JSON.parse throw, and the value stays an expression.
  if (src.startsWith('"') && src.endsWith('"') && until(src, 0, "") === src.length) {
    try {
      return JSON.parse(src);
    } catch {
      return NOT_LITERAL;
    }
  }
  return NOT_LITERAL;
}

// #endregion
