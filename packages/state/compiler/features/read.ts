// Not a feature: what the features' file-level checks (`FeatureCompiler.file`, ../feature.ts) read
// from a file, once per file. Its imports, its shapes (`const door = setup({...})`, with the
// features their `use` lists) and its machines (`door.machine({...})`, with each node's config),
// and the handlers' parts the checks look at: the names a handler destructures, its steps, and its
// `enq` calls, each marked when it runs on every call of the handler (not under a condition).
//
// The core compiles the same machines (../index.ts) and reports what isn't written in place; this
// only reads what is, and passes over the rest.

import { visitorKeys } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  Expression,
  Function as FunctionNode,
  Node,
  ObjectProperty,
  Program,
} from "oxc-parser";

import { importedName, isFunction, keyName, stringValue } from "../syntax.ts";

export type Fn = ArrowFunctionExpression | FunctionNode;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
}

/** A node's children (TypeScript-only nodes skipped, except a cast's expression), as ../syntax.ts walks them. */
function children(node: Node): Node[] {
  const out: Node[] = [];
  const keys = node.type.startsWith("TS") ? ["expression"] : (visitorKeys[node.type] ?? []);
  for (const key of keys) {
    const value: unknown = Reflect.get(node, key);
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      for (const item of items) if (isNode(item)) out.push(item);
    } else if (isNode(value)) out.push(value);
  }
  return out;
}

/** Visit `node` and its descendants with their ancestors (nearest last); `visit` returns false to skip a node's children. */
export function walkUp(
  node: Node,
  visit: (node: Node, ancestors: readonly Node[]) => boolean,
  ancestors: Node[] = [],
): void {
  if (!visit(node, ancestors)) return;
  ancestors.push(node);
  for (const child of children(node)) walkUp(child, visit, ancestors);
  ancestors.pop();
}

/** A call's callee as a dotted name (`localStorage.setItem`, `enq.raise`), or null. */
export function calleeName(call: CallExpression | Node): string | null {
  const callee = call.type === "CallExpression" || call.type === "NewExpression" ? call.callee : call;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    const object = calleeName(callee.object);
    return object === null ? null : `${object}.${callee.property.name}`;
  }
  return null;
}

/** An object literal's properties by name (spreads and computed keys left out). */
export function propsOf(node: Node | null | undefined): Map<string, ObjectProperty> {
  const out = new Map<string, ObjectProperty>();
  if (node?.type !== "ObjectExpression") return out;
  for (const p of node.properties) {
    if (p.type !== "Property") continue;
    const name = keyName(p);
    if (name !== null) out.set(name, p);
  }
  return out;
}

/** A function's value: the function itself, or null. */
export function fnOf(node: Node | null | undefined): Fn | null {
  return node !== null && node !== undefined && isFunction(node) ? node : null;
}

/** An import: where from, and the name it imports (`*` for a default or namespace import). */
export interface Imported {
  readonly source: string;
  readonly imported: string;
}

/** A file's shape: `const <name> = setup({...})`. */
export interface FileShape {
  readonly name: string;
  readonly call: CallExpression;
  /** Setup's argument, by key. */
  readonly options: ReadonlyMap<string, ObjectProperty>;
  /** The features its `use` lists, by feature name (`effects`). */
  readonly uses: ReadonlySet<string>;
}

/** A file's machine: `<shape>.machine({...})`. */
export interface FileMachine {
  /** The const it is the value of, if any. */
  readonly name: string | null;
  readonly shape: FileShape;
  readonly call: CallExpression;
  readonly start: Fn | null;
  /** Each node's config, by node name, as written (object literals only). */
  readonly nodes: ReadonlyMap<string, ReadonlyMap<string, ObjectProperty>>;
}

/** What the checks read from a file. */
export interface FileFacts {
  /** The file's imports, by local name. */
  readonly imports: ReadonlyMap<string, Imported>;
  /** The module-level names declared with `let` or `var`. */
  readonly mutable: ReadonlySet<string>;
  /** The module-level consts, by name, with their values. */
  readonly consts: ReadonlyMap<string, Expression | null>;
  /** The module-level functions (declarations and consts holding one), by name. */
  readonly functions: ReadonlyMap<string, Fn>;
  readonly shapes: ReadonlyMap<string, FileShape>;
  readonly machines: readonly FileMachine[];
}

const facts = new WeakMap<Program, FileFacts>();

/** The local names `imported` is imported under from a module `source` matches. */
export function localsOf(file: FileFacts, source: (s: string) => boolean, imported: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [local, i] of file.imports) if (i.imported === imported && source(i.source)) out.add(local);
  return out;
}

/** A module of @reactre/state: the package or one of its entries. */
export const fromState = (source: string): boolean =>
  source === "@reactre/state" || source.startsWith("@reactre/state/");

/** What the checks read from `program`, read once. */
export function factsOf(program: Program): FileFacts {
  const known = facts.get(program);
  if (known !== undefined) return known;
  const imports = new Map<string, Imported>();
  const mutable = new Set<string>();
  const consts = new Map<string, Expression | null>();
  const functions = new Map<string, Fn>();
  for (const top of program.body) {
    const s = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (s.type === "ImportDeclaration" && s.importKind !== "type")
      for (const i of s.specifiers) {
        if (i.type === "ImportSpecifier" && i.importKind === "type") continue;
        imports.set(i.local.name, {
          source: s.source.value,
          imported: i.type === "ImportSpecifier" ? importedName(i) : "*",
        });
      }
    if (s.type === "VariableDeclaration")
      for (const d of s.declarations) {
        if (d.id.type !== "Identifier") continue;
        if (s.kind === "const") {
          consts.set(d.id.name, d.init);
          const fn = fnOf(d.init);
          if (fn !== null) functions.set(d.id.name, fn);
        } else mutable.add(d.id.name);
      }
    if (s.type === "FunctionDeclaration" && s.id !== null) functions.set(s.id.name, s);
  }
  const setups = new Set(
    [...imports].flatMap(([l, i]) => (i.source === "@reactre/state" && i.imported === "setup" ? [l] : [])),
  );
  // A feature's import: `import { effects } from "@reactre/state/effects"`.
  const featureOf = (local: string): string | null => {
    const i = imports.get(local);
    const entry = i === undefined ? undefined : /^@reactre\/state\/([\w-]+)$/.exec(i.source)?.[1];
    return entry !== undefined && i?.imported === entry ? entry : null;
  };
  const shapes = new Map<string, FileShape>();
  for (const [name, init] of consts) {
    if (init?.type !== "CallExpression" || init.callee.type !== "Identifier" || !setups.has(init.callee.name)) continue;
    const options = propsOf(init.arguments[0]);
    const list = options.get("use")?.value;
    const uses = new Set(
      list?.type === "ArrayExpression"
        ? list.elements.flatMap((e) => {
            const f = e?.type === "Identifier" ? featureOf(e.name) : null;
            return f === null ? [] : [f];
          })
        : [],
    );
    shapes.set(name, { name, call: init, options, uses });
  }
  const machines: FileMachine[] = [];
  walkUp(program, (node, ancestors) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return true;
    const { object, property } = node.callee;
    const shape = object.type === "Identifier" ? shapes.get(object.name) : undefined;
    if (shape === undefined || property.type !== "Identifier" || property.name !== "machine") return true;
    const config = propsOf(node.arguments[0]);
    const nodes = new Map<string, ReadonlyMap<string, ObjectProperty>>();
    for (const [n, p] of propsOf(config.get("states")?.value)) nodes.set(n, propsOf(p.value));
    const parent = ancestors.at(-1);
    machines.push({
      name: parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : null,
      shape,
      call: node,
      start: fnOf(config.get("start")?.value),
      nodes,
    });
    return false;
  });
  const out: FileFacts = { imports, mutable, consts, functions, shapes, machines };
  facts.set(program, out);
  return out;
}

/** The names a handler destructures from its argument, by key: `({ to, enq: q })` gives to -> to, enq -> q. */
export function argNames(fn: Fn): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const first = fn.params[0];
  const pattern = first?.type === "AssignmentPattern" ? first.left : first;
  if (pattern?.type !== "ObjectPattern") return out;
  for (const p of pattern.properties) {
    if (p.type === "RestElement") continue;
    const key = keyName(p);
    const value = p.value.type === "AssignmentPattern" ? p.value.left : p.value;
    if (key !== null && value.type === "Identifier") out.set(key, value.name);
  }
  return out;
}

/**
 * Whether a node, inside a function's body, runs on every call of it: its ancestors up to the body
 * are statements and sequences only (no condition, loop, `&&`, or nested function).
 */
function always(ancestors: readonly Node[], body: Node): boolean {
  if (ancestors.length === 0) return true; // the body itself
  const from = ancestors.indexOf(body);
  if (from === -1) return false;
  for (const a of ancestors.slice(from + 1))
    if (
      a.type !== "SequenceExpression" &&
      a.type !== "ExpressionStatement" &&
      a.type !== "ReturnStatement" &&
      a.type !== "BlockStatement" &&
      a.type !== "AwaitExpression" &&
      a.type !== "ChainExpression" &&
      a.type !== "VariableDeclaration" &&
      a.type !== "VariableDeclarator"
    )
      return false;
  return true;
}

/** A step a handler takes: `to(state, data)` or `keep(state, data)`. */
export interface Step {
  readonly kind: "to" | "keep";
  /** The state, as written; null when it isn't a string. */
  readonly state: string | null;
  readonly data: Node | undefined;
  readonly call: CallExpression;
}

/** A call of `enq` (method null) or of one of its methods, in a handler's body. */
export interface EnqCall {
  readonly method: string | null;
  readonly call: CallExpression;
  /** It runs on every call of the handler. */
  readonly always: boolean;
}

/** A handler's parts, read once per function. */
export interface Handler {
  readonly fn: Fn;
  readonly names: ReadonlyMap<string, string>;
  readonly steps: readonly Step[];
  /** Some return is `null` (or there is no step): the handler may decline. */
  readonly declines: boolean;
  readonly enq: readonly EnqCall[];
}

const handlers = new WeakMap<Fn, Handler>();

/** A handler's steps and `enq` calls, outside the functions inside it (an effect's is its own). */
export function handlerOf(fn: Fn): Handler {
  const known = handlers.get(fn);
  if (known !== undefined) return known;
  const names = argNames(fn);
  const to = names.get("to");
  const keep = names.get("keep");
  const enq = names.get("enq");
  const steps: Step[] = [];
  const calls: EnqCall[] = [];
  let declines = false;
  const body = fn.body;
  if (body !== null) {
    walkUp(body, (node, ancestors) => {
      if (node !== body && isFunction(node)) return false;
      if (node.type === "Literal" && node.value === null && node.raw === "null") {
        const parent = ancestors.at(-1);
        if (parent?.type === "ReturnStatement" || parent?.type === "ConditionalExpression" || node === body)
          declines = true;
      }
      if (node.type !== "CallExpression") return true;
      const callee = node.callee;
      if (callee.type === "Identifier" && (callee.name === to || callee.name === keep))
        steps.push({
          kind: callee.name === to ? "to" : "keep",
          state: stringValue(node.arguments[0]),
          data: node.arguments[1],
          call: node,
        });
      if (enq !== undefined) {
        const method =
          callee.type === "Identifier" && callee.name === enq
            ? null
            : callee.type === "MemberExpression" &&
                !callee.computed &&
                callee.object.type === "Identifier" &&
                callee.object.name === enq &&
                callee.property.type === "Identifier"
              ? callee.property.name
              : undefined;
        if (method !== undefined) calls.push({ method, call: node, always: always(ancestors, body) });
      }
      return true;
    });
  }
  const out: Handler = { fn, names, steps, declines: declines || steps.length === 0, enq: calls };
  handlers.set(fn, out);
  return out;
}

/** An event written in place, `{ type: "ring", ... }`: its type. */
export function eventType(node: Node | undefined): string | null {
  return stringValue(propsOf(node).get("type")?.value);
}

/** The nodes a leaf runs in: itself, then its parents (`a.b.c`, `a.b`, `a`). */
export function lineage(leaf: string): string[] {
  const parts = leaf.split(".");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("."));
}

/** Whether node `node`'s own `on` (a wildcard there included) handles `event`. */
export function handlesHere(machine: FileMachine, node: string, event: string): boolean {
  for (const key of propsOf(machine.nodes.get(node)?.get("on")?.value).keys())
    if (key === event || key === "*" || (key.endsWith(".*") && event.startsWith(key.slice(0, -1)))) return true;
  return false;
}

/** Whether node `state` (or a parent, or a wildcard there) of `machine` handles `event`. */
export function handles(machine: FileMachine, state: string, event: string): boolean {
  return lineage(state).some((n) => handlesHere(machine, n, event));
}

/** Every handler of a machine with where it is: its node, its kind (`on`, `entry`, ...) and event or key. */
export interface Placed {
  readonly node: string | null;
  readonly kind: string;
  readonly key: string | null;
  readonly handler: Handler;
}

/** A machine's handlers: `start`, and each node's `on`, `after`, `always`, `choice`, `entry` and `exit`. */
export function handlersOf(machine: FileMachine): Placed[] {
  const out: Placed[] = [];
  if (machine.start !== null) out.push({ node: null, kind: "start", key: null, handler: handlerOf(machine.start) });
  for (const [node, config] of machine.nodes) {
    for (const kind of ["on", "after"])
      for (const [key, p] of propsOf(config.get(kind)?.value)) {
        const fn = fnOf(p.value);
        if (fn !== null) out.push({ node, kind, key, handler: handlerOf(fn) });
      }
    for (const kind of ["always", "choice", "entry", "exit"]) {
      const fn = fnOf(config.get(kind)?.value);
      if (fn !== null) out.push({ node, kind, key: null, handler: handlerOf(fn) });
    }
  }
  return out;
}

/** Whether a node of `program` is inside a `try` block (not its catch or finally), within `ancestors`. */
export function inTry(ancestors: readonly Node[], node: Node): boolean {
  const chain = [...ancestors, node];
  return chain.some((a, i) => a.type === "TryStatement" && chain[i + 1] === a.block);
}

/** A call's options argument when written in place (an object literal), by name. */
export function optionsOf(call: CallExpression, index: number): ReadonlyMap<string, ObjectProperty> {
  return propsOf(call.arguments[index]);
}

/**
 * A read of the clock or of chance: `Date.now`, `new Date()`, `Date()`, `performance.now`,
 * `Math.random`, `crypto.randomUUID` (any of crypto's), named as written; else null. `new Date(at)`
 * reads no clock.
 */
export function chance(node: Node): { readonly what: string; readonly clock: boolean } | null {
  if (
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "Date" &&
    node.arguments.length === 0
  )
    return { what: "new Date()", clock: true };
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "Date")
    return { what: "Date()", clock: true };
  if (node.type !== "MemberExpression" || node.computed || node.object.type !== "Identifier") return null;
  if (node.property.type !== "Identifier") return null;
  const what = `${node.object.name}.${node.property.name}`;
  if (what === "Date.now" || what === "performance.now") return { what, clock: true };
  if (what === "Math.random" || node.object.name === "crypto") return { what, clock: false };
  return null;
}

/** Whether a node is inside a loop (or a callback of `map`, `forEach` and the like) below `top`. */
export function inLoop(ancestors: readonly Node[], top: Node): boolean {
  const from = ancestors.indexOf(top);
  return ancestors.slice(from + 1).some((a, i, rest) => {
    if (
      a.type === "ForStatement" ||
      a.type === "ForOfStatement" ||
      a.type === "ForInStatement" ||
      a.type === "WhileStatement" ||
      a.type === "DoWhileStatement"
    )
      return true;
    const next = rest[i + 1];
    if (a.type !== "CallExpression" || next === undefined || !isFunction(next)) return false;
    const method =
      a.callee.type === "MemberExpression" && a.callee.property.type === "Identifier" ? a.callee.property.name : "";
    return ["map", "forEach", "flatMap", "filter", "reduce", "some", "every"].includes(method);
  });
}
