// Per-API options for compat mode (`compat.apis` and `compat.exclude`): the module `react`
// resolves to when the options turn APIs off, and the scan that finds a switched-off API in the
// code being bundled. The keys and their rules are @reactre/compat's manifest (@reactre/compat/api).
//
// Design decisions:
//   - The module is a real file, written under the app's node_modules/.cache, so every bundler and
//     Vite's dependency optimizer load it as they load any dependency. Its name carries a hash of
//     its contents, so options that change write a new file instead of editing one in use.
//   - It builds on @reactre/compat/core and imports the module of each key that has one and is on
//     (class support, component stacks, React's handling of repeated keys), which installs it.
//   - It imports only the names that are on, so a bundler can leave out what only the others
//     reach. A switched-off name is still exported, as a function that throws: a library's
//     `typeof React.x === "function"` check passes and the failure names the fix.
//   - The scan parses with oxc (it runs under Node too) and reads what a module takes from
//     `react` and `react-dom`: named imports and re-exports, `React.x` through a default or
//     namespace import, and `require("react")`. A use it cannot see still meets the throwing stub.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ALWAYS, BEHAVIOURS, KEYS, MODULES } from "@reactre/compat/api";
import { parseSync } from "oxc-parser";

/** A request for the client side of React: `react`, `react-dom` and their subpaths, not the server's. */
const CLIENT = /^react(?:-dom)?(?:\/(?!server|static).*)?$/;

/** The class keys: off, class support is not loaded, and core's own Component throws when a class renders. */
const CLASSES = new Set(["Component", "PureComponent"]);

/** The source of the module `react` resolves to, with the keys in `on` and the rest switched off. */
export function entrySource(on: ReadonlySet<string>): string {
  const from = "@reactre/compat/core";
  const imported = [...ALWAYS, ...KEYS.filter((k) => on.has(k) || CLASSES.has(k))];
  const off = KEYS.filter((k) => !on.has(k) && !CLASSES.has(k));
  const modules = Object.keys(MODULES).filter((k) => on.has(k));
  return (
    `// Written by @reactre/plugin from the app's compat options. Switched off: ${[...KEYS, ...BEHAVIOURS].filter((k) => !on.has(k)).join(", ")}.\n` +
    modules.map((k) => `import "${MODULES[k]}";\n`).join("") +
    `export * from "${from}";\n` +
    `import { ${imported.join(", ")} } from "${from}";\n` +
    `function off(name) {\n` +
    `  return function () {\n` +
    `    throw new Error("React's " + name + " is switched off by @reactre/plugin's compat options. Add \\"" + name + "\\" to compat.apis, or remove it from compat.exclude.");\n` +
    `  };\n` +
    `}\n` +
    off.map((k) => `export const ${k} = /* @__PURE__ */ off("${k}");\n`).join("") +
    `export default { ${[...ALWAYS, ...KEYS].join(", ")} };\n`
  );
}

/** Write `source` under `root`'s node_modules/.cache/reactre, once per content, and return its path. */
export function writeEntry(root: string, source: string): string {
  const dir = join(root, "node_modules", ".cache", "reactre");
  const file = join(dir, `compat-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.js`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, source);
  }
  return file;
}

// biome-ignore lint: ESTree nodes are read loosely here.
type Node = any;

/** The parser's language for a module, by its extension: JSX is allowed in plain JavaScript. */
function lang(file: string): "ts" | "tsx" | "jsx" {
  return /\.[cm]?ts$/.test(file) ? "ts" : /\.tsx$/.test(file) ? "tsx" : "jsx";
}

/** Whether `node` is `require("react")` or a require of another client entry. */
function isRequire(node: Node): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Literal" &&
    typeof node.arguments[0].value === "string" &&
    CLIENT.test(node.arguments[0].value)
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

/** The keys of an object pattern that are plain names, as `{ useState, useEffect: e }` has. */
function patternKeys(pattern: Node, out: Set<string>): void {
  for (const p of pattern.properties)
    if (p.type === "Property" && !p.computed && p.key.type === "Identifier") out.add(p.key.name);
}

/** The names `file` reads from React's client modules. Code that does not parse reads nothing. */
export function usedApis(code: string, file: string): Set<string> {
  const used = new Set<string>();
  const r = parseSync(file, code, { lang: lang(file), sourceType: "unambiguous" });
  if (r.errors.length > 0) return used;
  // Bindings that hold the whole module: default and namespace imports, and `require("react")`.
  const modules = new Set<string>();
  for (const imp of r.module.staticImports) {
    if (!CLIENT.test(imp.moduleRequest.value)) continue;
    for (const e of imp.entries) {
      if (e.isType) continue;
      if (e.importName.kind === "Name") used.add(e.importName.name!);
      else modules.add(e.localName.value);
    }
  }
  for (const exp of r.module.staticExports)
    for (const e of exp.entries)
      if (e.moduleRequest !== null && CLIENT.test(e.moduleRequest.value) && !e.isType && e.importName.kind === "Name")
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

/** The error for `file` using `name`, which the options switch off. */
export function offError(file: string, name: string): Error {
  return new Error(
    `${file}: uses React's ${name}, which @reactre/plugin's compat options switch off. ` +
      `Add "${name}" to compat.apis, or remove it from compat.exclude.`,
  );
}
