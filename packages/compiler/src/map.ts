// Source maps for the text-rewriting compilers: @reactre/compiler, @reactre/compat/compiler and
// @reactre/plugin's rename of oxc's output.
//
// Each of them builds its output by copying slices of its input among text of its own. To map the
// output back, a compile that wants a map puts a mark in the output before each piece it copies:
// the piece's offset in the input, between two characters from Unicode's private use area.
// `unmark` then takes the marks out, which leaves the code a compile without marks prints, and
// turns them into a version 3 source map: one segment per mark, at the mark's place in the code,
// pointing at its offset's line and column in the input.
//
// Design decisions:
//   - Marks, not an edit list built alongside the output. The compilers assemble their output from
//     strings nested in template literals, so a piece's final place is known only at the end; a
//     mark travels with its piece through every concatenation.
//   - A compile without a map puts no marks and runs no other code, so its output is as before,
//     byte for byte. Where a compiler reads its own output again (the compat compiler's free-name
//     analysis), it reads it with the marks taken out (`plain`), so its decisions, and so its code,
//     are the same with marks as without.
//   - One segment per copied token, so a stack frame's column lands on the token it names. Text a
//     compiler writes itself maps to the place of the mark before it.
//   - An input that already holds a mark's characters gets no map (`hasMarks`), rather than a
//     wrong one.

/** Opens a mark; the offset follows in decimal. */
const OPEN = "";
/** Closes a mark. */
const CLOSE = "";
const MARKS = /(\d+)/g;

/** A version 3 source map, as bundlers take it. */
export interface SourceMapV3 {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

/** The mark for input offset `at`, which a mapped compile puts before the text it copies from there. */
export const mark = (at: number): string => OPEN + at + CLOSE;

/** Whether `src` holds a mark's characters, so a compile of it cannot be mapped. */
export const hasMarks = (src: string): boolean => src.includes(OPEN) || src.includes(CLOSE);

/** `src` with its marks taken out. */
export const plain = (src: string): string => (src.includes(OPEN) ? src.replace(MARKS, "") : src);

/**
 * Take the marks out of `marked` and map each one's place in what is left to its offset in
 * `input`.
 *
 * @param source The input's name in the map's `sources`.
 * @returns The code without marks, and its map back to `input`.
 */
export function unmark(marked: string, input: string, source = ""): { code: string; map: SourceMapV3 } {
  // Where each of the input's lines starts, to turn an offset into a line and a column.
  const starts = [0];
  for (let i = input.indexOf("\n"); i >= 0; i = input.indexOf("\n", i + 1)) starts.push(i + 1);
  // Per generated line, its segments as [column, source line, source column].
  const lines: [number, number, number][][] = [[]];
  let code = "",
    lineStart = 0,
    last = 0;
  const copy = (text: string) => {
    for (let n = text.indexOf("\n"); n >= 0; n = text.indexOf("\n", n + 1)) {
      lines.push([]);
      lineStart = code.length + n + 1;
    }
    code += text;
  };
  for (const m of marked.matchAll(MARKS)) {
    copy(marked.slice(last, m.index));
    last = m.index + m[0].length;
    const at = Number(m[1]);
    // The last line that starts at or before `at`. Marks are not in input order (the compilers
    // move code), so each one is searched for.
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    const segs = lines[lines.length - 1]!;
    const col = code.length - lineStart;
    // Two marks at one place (an empty piece between them): the later one wins.
    if (segs.at(-1)?.[0] === col) segs.pop();
    segs.push([col, lo, at - starts[lo]!]);
  }
  copy(marked.slice(last));
  // Each field is relative to the previous segment's, the column to the previous one on its line.
  let mappings = "",
    srcLine = 0,
    srcCol = 0;
  lines.forEach((segs, n) => {
    if (n > 0) mappings += ";";
    let col = 0;
    segs.forEach(([c, l, sc], k) => {
      mappings += (k > 0 ? "," : "") + vlq(c - col) + "A" + vlq(l - srcLine) + vlq(sc - srcCol);
      col = c;
      srcLine = l;
      srcCol = sc;
    });
  });
  return { code, map: { version: 3, sources: [source], sourcesContent: [input], names: [], mappings } };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A number in base64 VLQ, as source maps write their fields. */
function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1,
    out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}
