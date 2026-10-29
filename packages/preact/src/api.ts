// Switching APIs off (@reactre/preact/compiler's `off` option): the keys, the module an app's
// `preact` and `react` imports resolve to when some are off, and the scan that fails the build
// when code uses one.
//
// Design decisions, as @reactre/plugin's for @reactre/compat:
//   - A key is a name an app imports from `preact`, `preact/hooks`, `preact/compat` or `react`.
//     What every app needs (createElement and h, Fragment, render, options, the JSX runtime and
//     the compiled-template helpers) is not a key.
//   - A switched-off name stays exported as a function that throws, so a library's
//     `typeof x === "function"` check passes and a use the scan cannot see still fails loudly.
//   - "Component" is class support: off, the engine's class-only code leaves the bundle, an import
//     of Component fails the build as any other key's does, and a class the scan cannot see
//     throws when it renders, naming the fix. A class-based API (PureComponent, compat's Suspense)
//     needs it.
//   - The scan parses with oxc and reads what a module takes from those modules: named imports
//     and re-exports, `x.name` through a default or namespace import, and `require(...)`.

import { parseSync } from "oxc-parser";

/** The modules whose exports are keys: Preact's and React's client entries. */
export const SOURCES: RegExp = /^(?:preact(?:\/hooks|\/compat(?:\/client)?)?|react(?:-dom)?(?:\/client)?)$/;

/** Exports every build keeps. */
export const ALWAYS: ReadonlySet<string> = new Set([
  "default",
  "createElement",
  "h",
  "Fragment",
  "render",
  "options",
  "version",
  "jsx",
  "jsxs",
  "jsxDEV",
  "__block",
  "__template",
  "REACT_ELEMENT_TYPE",
  "REACT_FORWARD_SYMBOL",
  "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED",
]);

/** Groups of keys, written where a key may be. */
export const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "@classes": ["Component", "PureComponent"],
  "@suspense": ["Suspense", "lazy", "use"],
  "@transitions": ["startTransition", "useTransition", "useDeferredValue"],
};

/** Keys that need another: with it off, they are off. */
export const REQUIRES: Readonly<Record<string, string>> = { PureComponent: "Component", Suspense: "Component" };

/** The keys `off` names (groups expanded, and what needs them), or an error naming an unknown one. */
export function offKeys(off: readonly string[], known: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const k of off) {
    const group = GROUPS[k];
    if (group) for (const g of group) out.add(g);
    else if (known.has(k)) out.add(k);
    else
      throw new Error(
        `@reactre/preact/compiler: "${k}" is not an API key. Keys are the names an app imports from preact, ` +
          `preact/hooks, preact/compat and react, other than ${[...ALWAYS].join(", ")}; groups are ` +
          `${Object.keys(GROUPS).join(", ")}.`,
      );
  }
  for (const [k, whole] of Object.entries(REQUIRES)) if (out.has(whole)) out.add(k);
  return out;
}

/** The module an app's imports of `entry` resolve to, with `off`'s names throwing. */
export function entrySource(entry: string, exports: readonly string[], off: ReadonlySet<string>): string {
  const stubs = exports.filter((k) => off.has(k));
  return (
    `// Written by @reactre/preact/compiler. Switched off: ${[...off].join(", ")}.\n` +
    `export * from ${JSON.stringify(entry)};\n` +
    (exports.includes("default") ? `export { default } from ${JSON.stringify(entry)};\n` : "") +
    `function off(name) {\n` +
    `  return function () {\n` +
    `    throw new Error(name + " is switched off by @reactre/preact/compiler's off option. Remove it from the option to use it.");\n` +
    `  };\n` +
    `}\n` +
    stubs.map((k) => `export const ${k} = /* @__PURE__ */ off(${JSON.stringify(k)});\n`).join("")
  );
}

/** Throws where `code`, the module at `path`, uses a key of `off`, naming the file and the key. */
export function checkOff(code: string, path: string, off: ReadonlySet<string>): void {
  for (const k of usedApis(code, path))
    if (off.has(k)) throw new Error(`${path}: uses ${k}, which @reactre/preact/compiler's off option switches off.`);
}

/**
 * The engine's or compat's code with class support off: its CLASSES constants false, so a
 * minifier drops the class-only code. A top-level `if` on one is rewritten too, since Bun does
 * not fold the constant there. Reads the sources (`const X: boolean = true;`) and the dist build
 * (`var X = true;`).
 */
export function classesOff(code: string): string {
  return code
    .replace(/\b(const|let|var) (CLASSES\w*)(: boolean)? = true;/g, "$1 $2$3 = false;")
    .replace("if (CLASSES_COMPAT)", "if (false)");
}

// biome-ignore lint: ESTree nodes are read loosely here.
type Node = any;

/** Whether `node` is a `require(...)` of one of the SOURCES. */
function isRequire(node: Node): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments.length === 1 &&
    typeof node.arguments[0].value === "string" &&
    SOURCES.test(node.arguments[0].value)
  );
}

/** Call `visit` on every node under `node`, depth first. */
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const key in node) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c !== null && typeof c === "object" && typeof c.type === "string") walk(c, visit);
    } else if (v !== null && typeof v === "object" && typeof v.type === "string") walk(v, visit);
  }
}

/** The plain keys of an object pattern, as `{ useState, useEffect: e }` has. */
function patternKeys(pattern: Node, out: Set<string>): void {
  for (const p of pattern.properties)
    if (p.type === "Property" && !p.computed && p.key.type === "Identifier") out.add(p.key.name);
}

/** The names `file`'s code reads from the SOURCES. Code that does not parse reads nothing. */
export function usedApis(code: string, file: string): Set<string> {
  const used = new Set<string>();
  const lang = /\.[cm]?ts$/.test(file) ? "ts" : /\.tsx$/.test(file) ? "tsx" : "jsx";
  const r = parseSync(file, code, { lang, sourceType: "unambiguous" });
  if (r.errors.length > 0) return used;
  // Bindings that hold a whole module: default and namespace imports, and `require(...)`.
  const modules = new Set<string>();
  for (const imp of r.module.staticImports) {
    if (!SOURCES.test(imp.moduleRequest.value)) continue;
    for (const e of imp.entries) {
      if (e.isType) continue;
      if (e.importName.kind === "Name") used.add(e.importName.name!);
      else modules.add(e.localName.value);
    }
  }
  for (const exp of r.module.staticExports)
    for (const e of exp.entries)
      if (e.moduleRequest !== null && SOURCES.test(e.moduleRequest.value) && !e.isType && e.importName.kind === "Name")
        used.add(e.importName.name!);
  walk(r.program, (n) => {
    if (n.type === "VariableDeclarator" && isRequire(n.init)) {
      if (n.id.type === "Identifier") modules.add(n.id.name);
      else if (n.id.type === "ObjectPattern") patternKeys(n.id, used);
    }
  });
  walk(r.program, (n) => {
    if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
      const o = n.object;
      if ((o.type === "Identifier" && modules.has(o.name)) || isRequire(o)) used.add(n.property.name);
    } else if (
      n.type === "VariableDeclarator" &&
      n.id.type === "ObjectPattern" &&
      n.init?.type === "Identifier" &&
      modules.has(n.init.name)
    )
      patternKeys(n.id, used);
  });
  return used;
}
