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
//   - oxc, not Bun, so the plugin runs under Node as well. Its output compiles to the same code as
//     Bun's: test/transpile.test.ts compiles every JSX source in the repository both ways and
//     compares the results.
//   - oxc keeps comments and Bun drops them. Inside a jsx call a comment would land in a prop
//     value or between props, where the compilers expect only code, so comments there are
//     dropped. Comments elsewhere stay, since bundlers read some of them (`/* @vite-ignore */`,
//     `/* webpackChunkName: "x" */`).
//   - The scanner shared by the compilers finds the calls and skips strings, templates, regular
//     expressions and comments, so a name inside a string is never renamed.

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
}

/**
 * Strip TypeScript and turn JSX into the automatic runtime's calls, named as Bun names them.
 *
 * @param id The file's path; its extension picks the syntax (.tsx, .ts, else JSX).
 * @param importSource The runtime the calls belong to: `@reactre/core` or `react`.
 * @throws Error with oxc's messages when the source does not parse.
 * @example
 *   transpile("a.tsx", `export const A = () => <p>hi</p>;`, "react").code;
 *   // `export const A = () => jsx_reactre0("p", { children: "hi" });`
 */
export function transpile(id: string, source: string, importSource: string): Transpiled {
  const lang = id.endsWith(".tsx") ? "tsx" : id.endsWith(".ts") || id.endsWith(".mts") ? "ts" : "jsx";
  const out = transformSync(id, source, {
    lang,
    sourceType: "module",
    jsx: { runtime: "automatic", importSource, pure: false },
  });
  if (out.errors.length > 0) {
    throw new Error(`${id}: ${out.errors.map((e) => e.message).join("\n")}`);
  }
  const names = new Map<string, string>();
  const code = out.code.replace(RUNTIME_IMPORT, (_, list: string) => {
    for (const part of list.split(",")) {
      const [name, local] = part.trim().split(" as ");
      if (name !== undefined && local !== undefined) names.set(local, `${name}_${SUFFIX}`);
    }
    return "";
  });
  return { code: names.size > 0 ? rewrite(code, names) : code, classic: CLASSIC_IMPORT.test(code) };
}

/**
 * Rename the helpers, and drop the comments inside their calls. The walk is the compilers' own
 * (skipToken for literals and comments, identifiers whole), copying everything else unchanged.
 */
function rewrite(src: string, names: ReadonlyMap<string, string>): string {
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
      if (!comment || i > callEnd) out += src.slice(i, j);
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
      out += renamed ?? name;
      word = name;
      prev = "a";
      i = e;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = "";
    }
    out += c;
    i++;
  }
  return out;
}
