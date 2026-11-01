// The first step of both compilers off Bun: TypeScript stripped and JSX
// turned into the automatic runtime's calls by oxc, then printed the way
// Bun's transpiler prints them, which is what the compilers read.
//
// The compilers (@reactre/compiler and @reactre/compat/compiler) read
// JavaScript as text and find the runtime's calls by the names Bun gives
// them: jsx, jsxs, jsxDEV and Fragment with an 8-character suffix
// (jsx_w77yafs4), unbound. oxc imports the same helpers under its own names
// (`import { jsx as _jsx } from "react/jsx-runtime"`), so the import is
// dropped and each name is renamed to that shape.
//
// Design decisions:
//   - oxc, not Bun, so the plugin needs no Bun API. Its output compiles to the same code as
//     Bun's: test/transpile.test.ts compiles every JSX source in the repository both ways and
//     compares the results.
//   - oxc keeps comments and Bun drops them. Inside a jsx call a comment would land in a prop
//     value or between props, where the compilers expect only code, so comments there are
//     dropped. Comments elsewhere stay, since bundlers read some of them (`/* @vite-ignore */`,
//     `/* webpackChunkName: "x" */`).
//   - The scanner shared by the compilers finds the calls and skips strings, templates, regular
//     expressions and comments, so a name inside a string is never renamed.
//   - With a source map, the rename marks each token it copies with its place in oxc's output, as
//     the compilers do (@reactre/compiler/map), and its map is chained onto oxc's.

import remapping from "@jridgewell/remapping";
import { hasMarks, mark, type SourceMapV3, unmark } from "@reactre/compiler/map";
import { isIdent, skipToken, until } from "@reactre/compiler/scan";
import { transformSync } from "oxc-transform";

/** The suffix of the renamed helpers: 8 characters, as Bun's are. */
const SUFFIX = "reactre0";

/** The import oxc adds for the automatic runtime's helpers. */
const RUNTIME_IMPORT = /^import \{([^}]*)\} from "[^"\n]*\/jsx-(?:dev-)?runtime";\n/m;
/** The import oxc adds when an element needs the classic runtime (a key after a spread). */
const CLASSIC_IMPORT = /^import \{ createElement as \w+ \} from "[^"\n]*";$/m;

/** The result of transpiling one file. */
export interface Transpiled {
  /** JavaScript as Bun's transpiler prints it, for the compilers. */
  readonly code: string;
  /** Whether an element fell back to `createElement` (a `key` after a `{...spread}`). */
  readonly classic: boolean;
  /** With `sourcemap`, the map from `code` back to the source. */
  readonly map?: SourceMapV3;
}

/**
 * Strip TypeScript and turn JSX into the automatic runtime's calls, named as Bun names them.
 *
 * @param id The file's path; its extension picks the syntax (.tsx, .ts, else JSX).
 * @param importSource The runtime the calls belong to: `@reactre/core` or `react`.
 * @param sourcemap Whether to return a map from the code back to `source`: oxc's map, chained
 *   with the rename's when the helpers were renamed.
 * @throws Error with oxc's messages when the source does not parse.
 * @example
 *   transpile("a.tsx", `export const A = () => <p>hi</p>;`, "react").code;
 *   // `export const A = () => jsx_reactre0("p", { children: "hi" });`
 */
export function transpile(id: string, source: string, importSource: string, sourcemap = false): Transpiled {
  const lang = id.endsWith(".tsx") ? "tsx" : id.endsWith(".ts") || id.endsWith(".mts") ? "ts" : "jsx";
  const out = transformSync(id, source, {
    lang,
    sourceType: "module",
    jsx: { runtime: "automatic", importSource, pure: false },
    sourcemap,
  });
  if (out.errors.length > 0) {
    throw new Error(`${id}: ${out.errors.map((e) => e.message).join("\n")}`);
  }
  const names = new Map<string, string>();
  // The import is taken out; with a map, the walk's marks step over it.
  let cut = -1,
    cutLength = 0;
  const code = out.code.replace(RUNTIME_IMPORT, (whole: string, list: string, at: number) => {
    for (const part of list.split(",")) {
      const [name, local] = part.trim().split(" as ");
      if (name !== undefined && local !== undefined) names.set(local, `${name}_${SUFFIX}`);
    }
    cut = at;
    cutLength = whole.length;
    return "";
  });
  const classic = CLASSIC_IMPORT.test(code);
  const oxcMap = out.map as SourceMapV3 | undefined;
  if (oxcMap === undefined || (cut < 0 && names.size === 0) || hasMarks(out.code)) {
    // Unchanged from oxc's output, or a map this rewrite cannot mark: oxc's map, or none.
    const renamed = names.size > 0 ? rewrite(code, names, null) : code;
    return { code: renamed, classic, ...(oxcMap !== undefined && renamed === out.code ? { map: oxcMap } : {}) };
  }
  // In oxc's output, where a place in `code` came from.
  const from = (p: number) => (cut >= 0 && p >= cut ? p + cutLength : p);
  const { code: renamed, map } = unmark(rewrite(code, names, from), out.code, id);
  return { code: renamed, classic, map: remapping([map, oxcMap], () => null) as unknown as SourceMapV3 };
}

/**
 * Rename the helpers, and drop the comments inside their calls. The walk is the compilers' own
 * (skipToken for literals and comments, identifiers whole), copying everything else unchanged.
 *
 * @param from With a map: where a place in `src` is in oxc's output, for the marks before each
 *   token (@reactre/compiler/map). Null for no marks.
 */
function rewrite(src: string, names: ReadonlyMap<string, string>, from: ((p: number) => number) | null): string {
  let out = "",
    i = 0,
    prev = "",
    word = "",
    // Where the outermost jsx call that the walk is inside ends.
    callEnd = -1;
  while (i < src.length) {
    const j = skipToken(src, i, prev, word);
    if (j !== i) {
      const comment = src[i] === "/" && (src[i + 1] === "/" || src[i + 1] === "*");
      // A line comment's newline is not part of the token: the newline stays.
      if (!comment || i > callEnd) out += (from === null ? "" : mark(from(i))) + src.slice(i, j);
      prev = comment ? prev : "a";
      word = comment ? word : "";
      i = j;
      continue;
    }
    const c = src[i]!;
    if (isIdent(c) && !isIdent(src[i - 1])) {
      let e = i;
      while (isIdent(src[e])) e++;
      const name = src.slice(i, e);
      const renamed = src[i - 1] === "." ? undefined : names.get(name);
      if (renamed !== undefined && src[e] === "(" && i > callEnd) callEnd = until(src, e + 1, "");
      if (from !== null) out += mark(from(i));
      out += renamed ?? name;
      word = name;
      prev = "a";
      i = e;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = "";
      if (from !== null) out += mark(from(i));
    }
    out += c;
    i++;
  }
  return out;
}
