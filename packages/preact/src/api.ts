// Switching APIs off (@reactre/preact/compiler's `off` option): the keys, the module an app's
// `preact` and `react` imports resolve to when some are off, and the scan that fails the build
// when code uses one.
//
// Design decisions, as @reactre/plugin's for @reactre/compat:
//   - A key is a name an app imports from `preact`, `preact/hooks`, `preact/compat` or `react`.
//     What every app needs (createElement and h, Fragment, render, options, the JSX runtime and
//     the compiled-template helpers) is not a key.
//   - A switched-off name stays exported as a function that throws, so a library's
//     `typeof x === "function"` check passes and a use in an allowed file still fails loudly.
//   - "Component" is class support: off, the engine's class-only code leaves the bundle, an import
//     of Component fails the build as any other key's does, and a class the scan cannot see
//     throws when it renders, naming the fix. A class-based API (PureComponent, compat's Suspense)
//     needs it.
//   - The scan parses with oxc and reads what a module takes from those modules: named imports
//     and re-exports, `x.name` and `<x.Name>` through a default or namespace import, and
//     `require(...)`. A computed key the build can work out (`x["use" + "Id"]`, a `const`) is a
//     name too.
//   - Every use is either proven or fails the build: a module object read in a way the build
//     cannot follow (`x[k]` with a key known only at run time, `{ ...x }`, `f(x)`, `export *`)
//     fails it too, naming the place, since it could reach any API. A file the app allows
//     (`allowUnresolved`) builds, and its switched-off APIs throw when called.

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

/**
 * Throws where `code`, the module at `path`, uses a key of `off`, naming the file and the key; or,
 * unless `allow` accepts the file, where it reads a module object in a way the build cannot follow,
 * naming the place.
 */
export function checkOff(
  code: string,
  path: string,
  off: ReadonlySet<string>,
  allow?: (path: string) => boolean,
): void {
  const { used, unresolved } = scanApis(code, path);
  for (const k of used)
    if (off.has(k)) throw new Error(`${path}: uses ${k}, which @reactre/preact/compiler's off option switches off.`);
  const u = unresolved[0];
  if (u === undefined || allow?.(path)) return;
  const lines = code.slice(0, u.at).split("\n");
  throw new Error(
    `${path}:${lines.length}:${lines.at(-1)!.length + 1}: ${u.why}, so it cannot prove that the switched-off APIs ` +
      `(${[...off].join(", ")}) stay unused. Import the names it uses, or allow the file with the allowUnresolved option.`,
  );
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

/** Call `visit` on every node under `node`, depth first, with its parent. */
function walk(node: Node, visit: (node: Node, parent: Node) => void, parent: Node = null): void {
  visit(node, parent);
  for (const key in node) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c !== null && typeof c === "object" && typeof c.type === "string") walk(c, visit, node);
    } else if (v !== null && typeof v === "object" && typeof v.type === "string") walk(v, visit, node);
  }
}

/** What a module reads from the SOURCES. */
export interface Scan {
  /** The names it uses. */
  readonly used: Set<string>;
  /** Reads of a whole module the build cannot follow: where (an offset into the code) and what. */
  readonly unresolved: { at: number; why: string }[];
}

/** Wrappers that leave an expression's value as it is: parentheses and TypeScript's casts. */
const TRANSPARENT = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

/** The names a binding pattern declares. */
function bound(pattern: Node, out: (name: string) => void): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") out(pattern.name);
  else if (pattern.type === "ObjectPattern") for (const p of pattern.properties) bound(p.value ?? p.argument, out);
  else if (pattern.type === "ArrayPattern") for (const e of pattern.elements) bound(e, out);
  else if (pattern.type === "RestElement") bound(pattern.argument, out);
  else if (pattern.type === "AssignmentPattern") bound(pattern.left, out);
  else if (pattern.type === "TSParameterProperty") bound(pattern.parameter, out);
}

/**
 * The names `file`'s code reads from the SOURCES, and the reads of a whole module it cannot
 * follow. A key the build can work out counts as a name: a string, a template, a `const` declared
 * once, a `+` of those, or `.toString()` of one. A module object read with any other key, or used
 * as a value (passed, spread, exported, iterated), is unresolved, as are `export *` of a source
 * and `import()` of one. `typeof` and types read nothing. Code that does not parse reads nothing.
 */
export function scanApis(code: string, file: string): Scan {
  const scan: Scan = { used: new Set(), unresolved: [] };
  const { used, unresolved } = scan;
  const lang = /\.[cm]?ts$/.test(file) ? "ts" : /\.tsx$/.test(file) ? "tsx" : "jsx";
  const r = parseSync(file, code, { lang, sourceType: "unambiguous" });
  if (r.errors.length > 0) return scan;
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
      if (e.moduleRequest !== null && SOURCES.test(e.moduleRequest.value) && !e.isType) {
        if (e.importName.kind === "Name") used.add(e.importName.name!);
        else unresolved.push({ at: exp.start, why: "re-exports a whole module" });
      }

  // Each node's parent, how often each name is declared, and the `const`s' values.
  const parents = new Map<Node, Node>();
  const declared = new Map<string, number>();
  const consts = new Map<string, Node>();
  const declare = (name: string) => declared.set(name, (declared.get(name) ?? 0) + 1);
  walk(r.program, (n, parent) => {
    parents.set(n, parent);
    if (n.type === "VariableDeclarator") {
      bound(n.id, declare);
      if (n.id.type === "Identifier" && parent.kind === "const") consts.set(n.id.name, n.init);
      if (isRequire(n.init) && n.id.type === "Identifier") modules.add(n.id.name);
    } else if (/Function/.test(n.type)) {
      bound(n.id, declare);
      for (const p of n.params ?? []) bound(p, declare);
    } else if (n.type === "CatchClause") bound(n.param, declare);
  });

  /** The string a key always is, or undefined when the build cannot tell. */
  const constant = (node: Node, depth = 0): string | undefined => {
    while (TRANSPARENT.has(node?.type)) node = node.expression;
    if (!node || depth > 20) return undefined;
    switch (node.type) {
      case "Literal":
        return typeof node.value === "string" ? node.value : undefined;
      case "TemplateLiteral": {
        let s = node.quasis[0].value.cooked;
        for (let i = 0; i < node.expressions.length; i++) {
          const v = constant(node.expressions[i], depth + 1);
          if (v === undefined) return undefined;
          s += v + node.quasis[i + 1].value.cooked;
        }
        return s;
      }
      case "BinaryExpression": {
        if (node.operator !== "+") return undefined;
        const a = constant(node.left, depth + 1),
          b = constant(node.right, depth + 1);
        return a === undefined || b === undefined ? undefined : a + b;
      }
      case "Identifier":
        return declared.get(node.name) === 1 ? constant(consts.get(node.name), depth + 1) : undefined;
      case "CallExpression": {
        const c = node.callee;
        return node.arguments.length === 0 &&
          c.type === "MemberExpression" &&
          !c.computed &&
          /^(toString|valueOf)$/.test(c.property.name)
          ? constant(c.object, depth + 1)
          : undefined;
      }
    }
    return undefined;
  };

  /** A key read off a module object: a use, or unresolved. */
  const key = (k: Node, computed: boolean, at: number, why: string): void => {
    const name = computed ? constant(k) : k.type === "Identifier" ? k.name : constant(k);
    if (name !== undefined) used.add(name);
    else unresolved.push({ at, why });
  };

  /** What the code does with a module object at `ref`. */
  const follow = (ref: Node): void => {
    let n = ref,
      p = parents.get(n);
    while (TRANSPARENT.has(p.type)) p = parents.get((n = p));
    if (p.type === "MemberExpression" && p.object === n)
      key(p.property, p.computed, ref.start, "reads a module object with a key the build cannot work out");
    else if (p.type === "VariableDeclarator" && p.init === n && p.id.type === "ObjectPattern") {
      for (const prop of p.id.properties)
        if (prop.type === "RestElement") unresolved.push({ at: ref.start, why: "takes the rest of a module object" });
        else
          key(prop.key, prop.computed, ref.start, "destructures a module object with a key the build cannot work out");
    } else if (
      !(p.type === "UnaryExpression" && p.operator === "typeof") &&
      !(p.type === "VariableDeclarator" && p.init === n && isRequire(n))
    )
      unresolved.push({ at: ref.start, why: "hands a module object to code the build cannot follow" });
  };

  walk(r.program, (n, parent) => {
    if (n.type === "Identifier" && modules.has(n.name)) {
      // A declaration, a property name, or a type: not a read of the module.
      if (/^Import/.test(parent.type) || (/^TS/.test(parent.type) && !TRANSPARENT.has(parent.type))) return;
      if (parent.type === "VariableDeclarator" && parent.id === n) return;
      if (parent.type === "MemberExpression" && parent.property === n && !parent.computed) return;
      if (parent.type === "Property" && parent.key === n && !parent.computed && parent.value !== n) return;
      if (parent.type === "ExportSpecifier" && parent.exported === n && parent.local !== n) return;
      follow(n);
    } else if (isRequire(n)) follow(n);
    else if (n.type === "ImportExpression" && SOURCES.test(constant(n.source) ?? ""))
      unresolved.push({ at: n.start, why: "imports a module at run time" });
    else if (n.type === "JSXMemberExpression" && n.object.type === "JSXIdentifier" && modules.has(n.object.name))
      used.add(n.property.name);
  });
  return scan;
}
