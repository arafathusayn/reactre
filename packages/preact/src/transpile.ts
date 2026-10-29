// The first step of the compiler off Bun: TypeScript stripped and JSX turned into the automatic
// runtime's calls by oxc, then printed the way Bun's transpiler prints them, which is what
// compileJs (./compiler.ts) reads. The same step as @reactre/plugin's src/transpile.ts.
//
// compileJs finds the runtime's calls by the names Bun gives them: jsx, jsxs, jsxDEV and Fragment
// with an 8-character suffix (jsx_w77yafs4), unbound. oxc imports the same helpers under its own
// names (`import { jsx as _jsx } from "preact/jsx-runtime"`), so the import is dropped and each
// name is renamed to that shape. Comments inside a jsx call are dropped, as Bun drops them: there
// they would land between props, where the compiler expects only code. The walk is the
// compiler's own scanner, so a name inside a string, template or regular expression is never
// renamed.

import { isIdent, skipToken, until } from "@reactre/compiler/scan";
import { transformSync } from "oxc-transform";

/** The suffix of the renamed helpers: 8 characters, as Bun's are. */
const SUFFIX = "reactre0";

/** The import oxc adds for the automatic runtime's helpers. */
const RUNTIME_IMPORT = /^import \{([^}]*)\} from "[^"\n]*\/jsx-(?:dev-)?runtime";\n/m;

/**
 * Strip TypeScript and turn JSX into the automatic runtime's calls, named as Bun names them.
 *
 * @param id The file's path; its extension picks the syntax (.tsx, .ts, else JSX).
 * @param importSource The runtime the calls belong to: "preact" or "react".
 * @throws Error with oxc's messages when the source does not parse.
 * @example
 *   transpile("a.tsx", `export const A = () => <p>hi</p>;`, "preact");
 *   // `export const A = () => jsx_reactre0("p", { children: "hi" });`
 */
export function transpile(id: string, source: string, importSource: string): string {
  const lang = id.endsWith(".tsx") ? "tsx" : /\.[cm]?ts$/.test(id) ? "ts" : "jsx";
  const out = transformSync(id, source, {
    lang,
    sourceType: "module",
    jsx: { runtime: "automatic", importSource, pure: false },
  });
  if (out.errors.length > 0) throw new Error(`${id}: ${out.errors.map((e) => e.message).join("\n")}`);
  const names = new Map<string, string>();
  const code = out.code.replace(RUNTIME_IMPORT, (_, list: string) => {
    for (const part of list.split(",")) {
      const [name, local] = part.trim().split(" as ");
      if (name && local) names.set(local, `${name}_${SUFFIX}`);
    }
    return "";
  });
  return names.size > 0 ? rewrite(code, names) : code;
}

/** Rename the helpers, and drop the comments inside their calls. */
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
