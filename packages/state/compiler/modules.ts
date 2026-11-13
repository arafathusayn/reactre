// What the compiler reads beside the file it compiles: the compiler still compiles one file at a
// time, and only looks at another for a fact the file's own rules need.
//
//   - A relative import's first lines, for the `"use pure"` mark: a transition may call a function
//     imported from a module marked pure (its first statement is the directive `"use pure";`), and
//     the compiler checks that module's functions by a transition's rules when it compiles it.
//   - A relative import's exported shapes: `door.machine({...})` on a shape from another file fails
//     at runtime (S4), so the build says so where it can see the import.
//   - The nearest tsconfig.json (and the ones it extends), for `"strict": false`, which turns the
//     type layer's rules off for every machine under it, and for the flags strict doesn't set that
//     a machine's checks lean on (`configProblems`).
//   - A relative import's exported function, for a task's `run` that passes a fetch response to it:
//     whether it looks at the response's status (./run.ts).
//
// Each file is read once per process. A file that can't be read is treated as unmarked.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseSync } from "oxc-parser";
import type { ArrowFunctionExpression, Function as FunctionNode, Program } from "oxc-parser";

import { importedName, isFunction } from "./syntax.ts";

/**
 * The functions the compiler can see, by the name they're called by: each with the functions it
 * can see in turn (its own module's).
 */
export type Seen = (
  name: string,
) => { readonly fn: ArrowFunctionExpression | FunctionNode; readonly seen: Seen } | null;

/** A module's functions, by local name (its own, and its relative imports'), and its exports' local names. */
interface Module {
  readonly local: Seen;
  readonly exports: ReadonlyMap<string, string>;
}

const modules = new Map<string, Module>();

function moduleAt(path: string): Module {
  const known = modules.get(path);
  if (known !== undefined) return known;
  const { program } = parseSync(path, read(path) ?? "", {
    sourceType: "module",
    lang: path.endsWith("x") ? "tsx" : "ts",
  });
  const functions = new Map<string, ArrowFunctionExpression | FunctionNode>();
  const imports = new Map<string, { readonly source: string; readonly imported: string }>();
  const exports = new Map<string, string>();
  for (const top of program.body) {
    const s = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    const names: string[] = [];
    if (s.type === "FunctionDeclaration" && s.id !== null) {
      functions.set(s.id.name, s);
      names.push(s.id.name);
    }
    if (s.type === "VariableDeclaration")
      for (const d of s.declarations)
        if (d.id.type === "Identifier" && d.init !== null && isFunction(d.init)) {
          functions.set(d.id.name, d.init);
          names.push(d.id.name);
        }
    if (s !== top) for (const n of names) exports.set(n, n);
    if (s.type === "ImportDeclaration")
      for (const i of s.specifiers)
        if (i.type === "ImportSpecifier")
          imports.set(i.local.name, { source: s.source.value, imported: importedName(i) });
    // `export { check }`, `export { check as ensureOk }`.
    if (top.type === "ExportNamedDeclaration" && top.source === null)
      for (const e of top.specifiers)
        if (e.local.type === "Identifier" && e.exported.type === "Identifier")
          exports.set(e.exported.name, e.local.name);
  }
  const local: Seen = (name) => {
    const fn = functions.get(name);
    if (fn !== undefined) return { fn, seen: local };
    const i = imports.get(name);
    return i === undefined ? null : exportedFunction(path, i.source, i.imported);
  };
  const module = { local, exports };
  modules.set(path, module);
  return module;
}

/** The function the relative import `specifier` (from `file`) exports as `name`, if the compiler can see it. */
export function exportedFunction(file: string, specifier: string, name: string): ReturnType<Seen> {
  const path = resolveImport(file, specifier);
  if (path === null) return null;
  const module = moduleAt(path);
  const local = module.exports.get(name);
  return local === undefined ? null : module.local(local);
}

const texts = new Map<string, string | null>();
const parsed = new Map<string, { readonly text: string; readonly program: Program }>();

/** A relative import's file (from `file`), read and parsed once: its text and program, or null. */
export function importedModule(
  file: string,
  specifier: string,
): { readonly path: string; readonly text: string; readonly program: Program } | null {
  const path = resolveImport(file, specifier);
  if (path === null) return null;
  let module = parsed.get(path);
  if (module === undefined) {
    // resolveImport gives only a file it could read.
    const text = read(path) ?? "";
    module = {
      text,
      program: parseSync(path, text, { sourceType: "module", lang: path.endsWith("x") ? "tsx" : "ts" }).program,
    };
    parsed.set(path, module);
  }
  return { path, ...module };
}

/** A file's text, or null when it can't be read. */
function read(path: string): string | null {
  let text = texts.get(path);
  if (text === undefined) {
    text = existsSync(path) ? readFileSync(path, "utf8") : null;
    texts.set(path, text);
  }
  return text;
}

/** The file a relative import names, from the importing file: as written, or with a TypeScript extension. */
export function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.[cm]?js$/, ".ts"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find((c) => /\.[cm]?[jt]sx?$/.test(c) && read(c) !== null) ?? null;
}

/** The directive that marks a module pure. */
export const PURE = "use pure";

/** `"use pure";` as a module's first statement: after comments only. */
const MARK = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*(["'])use pure\1/;

/** Whether the relative import `specifier` (from `file`) is a module marked pure. */
export function importIsPure(file: string, specifier: string): boolean {
  const path = resolveImport(file, specifier);
  return MARK.test(path === null ? "" : (read(path) ?? ""));
}

const shapes = new Map<string, ReadonlySet<string>>();

/** The names a file exports shapes under (`export const door = setup({...})`), as far as it can see. */
export function exportedShapes(file: string, specifier: string): ReadonlySet<string> {
  const path = resolveImport(file, specifier);
  if (path === null) return new Set();
  let names = shapes.get(path);
  if (names === undefined) {
    names = shapesIn(path, read(path) ?? "");
    shapes.set(path, names);
  }
  return names;
}

function shapesIn(path: string, text: string): ReadonlySet<string> {
  const { program } = parseSync(path, text, { sourceType: "module", lang: path.endsWith("x") ? "tsx" : "ts" });
  const setups = new Set<string>();
  for (const s of program.body)
    if (s.type === "ImportDeclaration" && s.source.value === "@reactre/state")
      for (const i of s.specifiers)
        if (i.type === "ImportSpecifier" && importedName(i) === "setup") setups.add(i.local.name);
  // Module-level consts made by setup, by name, and whether `export const` exports them.
  const consts = new Map<string, boolean>();
  for (const top of program.body) {
    const s = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (s.type === "VariableDeclaration")
      for (const d of s.declarations)
        if (d.id.type === "Identifier" && d.init?.type === "CallExpression" && d.init.callee.type === "Identifier")
          if (setups.has(d.init.callee.name)) consts.set(d.id.name, s !== top);
  }
  const out = new Set([...consts].flatMap(([name, exported]) => (exported ? [name] : [])));
  // `export { door }` and `export { door as shape }`: importers use the exported name.
  for (const top of program.body)
    if (top.type === "ExportNamedDeclaration")
      for (const e of top.specifiers)
        if (e.local.type === "Identifier" && e.exported.type === "Identifier" && consts.has(e.local.name))
          out.add(e.exported.name);
  return out;
}

function strictIn(config: string, seen: Set<string>): boolean {
  return flagIn(config, "strict", seen) === false;
}

/**
 * A boolean compiler option as the config (or the one it extends) sets it: true, false, or null
 * when no config in the chain sets it. A package's preset can't be read (the compiler doesn't
 * resolve packages), so a chain that reaches one is read as setting it the way the machine needs:
 * `undefined`.
 */
function flagIn(config: string, flag: string, seen: Set<string>): boolean | null | undefined {
  seen.add(config);
  const text = read(config) ?? "";
  const set = new RegExp(`"${flag}"\\s*:\\s*(true|false)`).exec(text);
  if (set !== null) return set[1] === "true";
  const parent = /"extends"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (parent === undefined) return null;
  if (!parent.startsWith(".")) return undefined;
  const path = resolve(dirname(config), parent);
  if (seen.has(path) || read(path) === null) return undefined;
  return flagIn(path, flag, seen);
}

/**
 * The type checks a machine needs from the nearest tsconfig.json, each one off a problem with the
 * fix: `strict` (the contracts), and the flags its rules lean on that strict doesn't turn on:
 * `noUncheckedIndexedAccess` (an index read in a transition may be undefined, M14),
 * `noFallthroughCasesInSwitch` (a case falling into the next one's step), and
 * `useUnknownInCatchVariables` (strict's, unless turned off: `catch (e)` in a task's run is `unknown`).
 * A file with no tsconfig.json above it has none to read: nothing to report.
 */
export function configProblems(file: string): string[] {
  let config: string | null = null;
  for (let dir = dirname(resolve(file)); config === null; dir = dirname(dir)) {
    if (read(join(dir, "tsconfig.json")) !== null) config = join(dir, "tsconfig.json");
    else if (dirname(dir) === dir) return [];
  }
  if (strictIn(config, new Set()))
    return [
      'the tsconfig.json for this file turns strict off, and with it the type checks a machine\'s contracts need: set "strict": true',
    ];
  const out: string[] = [];
  const at = config;
  const flag = (name: string): boolean | null | undefined => flagIn(at, name, new Set());
  const indexed = flag("noUncheckedIndexedAccess");
  if (indexed === false || indexed === null)
    out.push(
      `the tsconfig.json for this file ${indexed === false ? "turns noUncheckedIndexedAccess off" : "lacks noUncheckedIndexedAccess"}: set "noUncheckedIndexedAccess": true, an index read in a transition needs it`,
    );
  const fallthrough = flag("noFallthroughCasesInSwitch");
  if (fallthrough === false || fallthrough === null)
    out.push(
      `the tsconfig.json for this file ${fallthrough === false ? "turns noFallthroughCasesInSwitch off" : "lacks noFallthroughCasesInSwitch"}: set "noFallthroughCasesInSwitch": true, a switch in a transition needs it`,
    );
  if (flag("useUnknownInCatchVariables") === false)
    out.push(
      "the tsconfig.json for this file turns useUnknownInCatchVariables off: remove \"useUnknownInCatchVariables\": false, the error's type in a task's catch needs it",
    );
  return out;
}
