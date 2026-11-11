// @reactre/state's compiler: checks what the type checker can't see, and compiles each machine to
// a table of plain functions, so `setup`, `types` and `to` cost nothing at runtime.
//
// The type checker (`bun check`, with the types in ../src) holds a machine to its shape: targets,
// exact data (through spreads too), payloads, JSON contracts, the graph. The compiler doesn't
// repeat any of that: a mistake the type checker reports, the compiler passes over. It adds what
// types can't express, because types describe values and not the code that makes them:
//
//   - Pure transitions. `start`, `on`, `after` and a task's `error` read only their arguments,
//     module constants, imports and pure globals. No clock (`Date`), no `Math.random`, no
//     module-level `let`, no other global, no `new`, no `import`, and no write to anything but
//     their own locals. So a machine replays the same way from the same events. A function they
//     call is held to the same rules: one declared in the file, transitively; one imported, only
//     from a module marked pure (`"use pure"` as its first line, or a package in the `pure`
//     option); a module value's method, never. A migration step is a transition too.
//   - Nothing hides a broken contract: no cast (`as const` and `satisfies` are fine) or non-null
//     `!` in a transition, no `@ts-` suppression in a file with machines, and none of them on a
//     line that calls @reactre/state (`createActor(machine)`), in any file. `createActor(m as any)`
//     is the type checker's: the call's `this` refuses an `any` machine or snapshot.
//   - Data's keys at runtime are its type's keys. A type says a value has at least its keys; an
//     object from elsewhere (a helper's result, an object spread in) can carry more, which a
//     snapshot would then save. So data is an object literal (or a local const holding one, used
//     only as data and read by field) or the handler's `data`, and spreads only `data`, whose keys
//     were checked when it was built. A module-level object in data would be shared by every actor.
//   - A task's `run` ends with its state, its failures reach `error`, and a response's body is
//     read after a look at its status (./run.ts).
//   - Where the file uses an actor: a send whose result is dropped is one that can't be ignored
//     (of an event some state of a flat machine in this file doesn't handle, or after the actor's
//     `stop()`); `await actor.send(...)` waits for nothing (`waitFor` does); a listener doesn't
//     throw (send would throw it at the sender); and a switch over a snapshot's state has no
//     `default:` but the `never` check, so a new state is a type error.
//   - A state isn't written twice under two names: sibling states with the same data and the same
//     handlers, whose names differ by a flag (`approved_by_manager`, `approved_by_director`), are
//     one state with the flag in its data (./mirror.ts).
//   - A saved snapshot fits its machine: a persisted (or durable) setup keeps `shape: "<hash>"`,
//     the hash of its version and the contracts written in place (./hash.ts), so changing them
//     without a new version fails the build.
//   - The parts it compiles are written in place: `const shape = setup({...})`, `shape.machine({...})`
//     at module level in the same file, object literals for states and handlers, handlers that
//     destructure their argument, `to("state", ...)` called with the state's name, durations and
//     the version as literals.
//
// Design decisions:
//   - Every problem is collected before failing, each with file:line:column, the line and the fix,
//     so one build shows a model everything to change.
//   - The compiler compiles one file at a time. It reads another only for one fact: whether a
//     relative import is marked pure, or exports a shape, and the nearest tsconfig's `strict`
//     (./modules.ts).
//   - The output is still TypeScript (annotations inside handlers stay), for the next compiler (or
//     the bundler) to strip. The machine becomes an object literal: no runtime call builds it.
//   - Tasks and timers are a runtime module of their own (`@reactre/state/tasks`), imported only by
//     a file whose machine has one: a machine of plain transitions ships the actor alone. A flat
//     machine whose only runners are tasks and timers gets the lean lifecycle (`r: __lean`); a
//     hierarchy, children, persist or effects get the general one (`r: __run([...])`, /run).
//   - A shape and its machines stay in one file, so the compiler sees them together. An exported
//     shape becomes `__shape()`, whose `machine` throws naming the fix, for code that calls it
//     from another file. Contracts' types can come from anywhere: the type checker reads them.
//   - Every other feature is opted into by setup's `use`: an array, written in place, of the
//     features imported by name from their entries (`import { nested } from "@reactre/state/nested"`,
//     `use: [nested]`). The import stays, and the table reads the feature value's hooks from it
//     (`g: nested.g`), so a bundle holds a feature's code only when the app imports it. Each
//     feature's compiler is its own module (./features/<feature>.ts, listed in ./features.ts), on
//     the API in ./feature.ts.

import { type Comment, parseSync } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  Expression,
  Function as FunctionNode,
  ImportDeclaration,
  Node,
  ObjectExpression,
  ObjectProperty,
  Program,
} from "oxc-parser";

import type { FeatureMachine, FeatureShape, HandlerContext, Kind, Report } from "./feature.ts";
import { FEATURES } from "./features.ts";
import { hash, normalize, shapeText } from "./hash.ts";
import { MIRROR_TODO, mirrored } from "./mirror.ts";
import { configProblems, exportedFunction, exportedShapes, importIsPure, PURE, type Seen } from "./modules.ts";
import { checkReact } from "./react.ts";
import { checkRun, returnsPromise } from "./run.ts";
import {
  type Admits,
  admits,
  boundNames,
  type Field,
  fieldsOf,
  hides,
  importedName,
  isFunction,
  keyName,
  returned,
  rootName,
  stringValue,
  typeArgument,
  walk,
  walkType,
} from "./syntax.ts";
import { checkTesting } from "./testing.ts";
import { checkUseSites, type SiteContext } from "./usesites.ts";
import { staticNode, staticValue } from "./values.ts";

/** Options of `compile`. */
export interface CompileOptions {
  /** Development output: snapshots' data frozen, so a mutation throws. */
  readonly dev?: boolean;
  /**
   * Packages whose exports are pure (they only compute from their arguments), so a transition may
   * call them: `["date-fns"]` covers `date-fns` and `date-fns/addDays`. A file of the app's own is
   * marked pure by `"use pure";` as its first line instead.
   */
  readonly pure?: readonly string[];
}

/** A problem the compiler found, at its place in the source. */
export interface Problem {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** The build fails with this: every problem in the file, each with its place, its line and the fix. */
export class StateCompileError extends Error {
  readonly problems: readonly Problem[];
  constructor(file: string, source: string, problems: readonly Problem[]) {
    const lines = source.split("\n");
    const text = problems
      .map((p) => {
        const code = lines[p.line - 1] ?? "";
        return `${file}:${p.line}:${p.column}: ${p.message}\n  ${code}\n  ${" ".repeat(p.column - 1)}^`;
      })
      .join("\n\n");
    super(`@reactre/state: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n\n${text}`);
    this.name = "StateCompileError";
    this.problems = problems;
  }
}

/**
 * An object literal's properties by name; spreads and computed keys are reported. A number for a
 * key (`after: { 5000: ... }`) is a name where `numbers` says so: the type checker says what to write.
 */
function propertiesOf(
  object: ObjectExpression,
  report: Report,
  what: string,
  numbers = false,
): Map<string, ObjectProperty> {
  const out = new Map<string, ObjectProperty>();
  for (const p of object.properties) {
    if (p.type === "SpreadElement") {
      report(p, `${what} can't be spread: write its keys in place, so the compiler can compile them`);
      continue;
    }
    const name =
      numbers && p.key.type === "Literal" && typeof p.key.value === "number" ? String(p.key.value) : keyName(p);
    const resolved = name;
    if (p.kind !== "init" || (name === null && resolved === null)) report(p, `${what} takes keys written as names`);
    else out.set(name ?? resolved ?? "", p);
  }
  return out;
}

const PURE_GLOBALS = new Set([
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "undefined",
  "NaN",
  "Infinity",
  "encodeURIComponent",
  "decodeURIComponent",
]);

/** @reactre/state's functions a transition may call: they only compute from their arguments. */
const LIBRARY_PURE = new Set([
  "isIn",
  "initial",
  "transition",
  "assertEvent",
  "can",
  "getMeta",
  "getNextTransitions",
  "getStateNodes",
  "hasTag",
  "isUnhandled",
  "mapState",
  "matches",
  "matchesState",
  "select",
]);

/**
 * @reactre/state's functions that take a machine, an actor or a snapshot, from any entry: the use
 * sites, where nothing may hide a broken contract from the type checker.
 */
const USES = new Set([
  "createActor",
  "restoreActor",
  "transition",
  "initial",
  "initialTransition",
  "isIn",
  "useActor",
  "useActorRef",
  "useSelector",
  "persist",
  "migrations",
  "processEvent",
  "provide",
  "child",
  "on",
  "trigger",
  "can",
  "getNextTransitions",
  "getStateNodes",
  "getMeta",
  "hasTag",
  "select",
  "toPromise",
  "waitFor",
  "getShortestPaths",
  "getSimplePaths",
  "getPathsFromEvents",
  "getAdjacencyMap",
  "toDirectedGraph",
  "modelPaths",
  "testPaths",
  "propertyTest",
  "machineToJSON",
  "machineConfigToJSON",
  "serializationDiagnostics",
]);

/**
 * The use sites whose `this` refuses an argument typed `any` (../src/index.ts, `NotAny`), by entry
 * and name, with the arguments it checks: there `machine as any` is the type checker's to report.
 */
const REFUSES_ANY: ReadonlyMap<string, readonly number[]> = new Map([
  ["@reactre/state createActor", [0]],
  ["@reactre/state initial", [0]],
  ["@reactre/state transition", [0, 1]],
  ["@reactre/state restoreActor", [0, 1]],
  ["@reactre/state/react useActor", [0]],
  ["@reactre/state/react useActorRef", [0]],
  // The development entry the plugin rewrites `@reactre/state/react` to (dev: true): the same
  // functions, so the same `this` refuses an `any` argument there too.
  ["@reactre/state/react/dev useActor", [0]],
  ["@reactre/state/react/dev useActorRef", [0]],
  ["@reactre/state/signals useActor", [0]],
]);

/** Methods that change the array, Map, Set or object they're called on. */
const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
  "assign",
  "defineProperty",
  "setPrototypeOf",
]);

/** Methods (and `Object.keys`, `Array.from` and the like) whose result is an array: always truthy. */
const ARRAYS = new Set([
  "split",
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
  "keys",
  "values",
  "entries",
  "from",
  "of",
  "toSorted",
  "toReversed",
  "toSpliced",
]);

/**
 * A comment that is a TypeScript directive, as TypeScript reads one: the directive first in it
 * (`// @ts-ignore`), not a mention of one in prose.
 */
const SUPPRESSION = /^[\s/*]*@ts-(ignore|nocheck|expect-error)/;
/** A linter's directive, first in its comment: ESLint's, Biome's, Oxlint's, Deno's. */
const LINT_SUPPRESSION = /^[\s/*]*(eslint-disable|biome-ignore|oxlint-disable|deno-lint-ignore)/;

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT: { readonly [unit: string]: number } = { ms: 1, s: 1e3, m: 6e4, h: 36e5 };

/**
 * What a handler is: the destructured names it takes, in their positional order (`to` and the
 * features' moves are compiled away), matching the compiled table's functions
 * (../src/internal.ts), and whether it decides a transition. The core's, then each feature's.
 */
const KINDS: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ["start", { params: ["input"], moves: true }],
  ["on", { params: ["data", "event", "state"], moves: true }],
  ["after", { params: ["data", "state"], moves: true, outside: "a timer" }],
  ["error", { params: ["data", "error", "state"], moves: true, outside: "a task's error" }],
  ["run", { params: ["data", "signal", "state"], moves: false }],
  ...[...FEATURES.values()].flatMap((f) => Object.entries(f.kinds ?? {})),
]);

/** Each feature's handler arguments: the moves (`back`) and values (`enq`), by name. */
const MOVES = new Map([...FEATURES].flatMap(([name, f]) => (f.moves ?? []).map((m) => [m, name] as const)));
const VALUES = new Map([...FEATURES].flatMap(([name, f]) => (f.values ?? []).map((v) => [v, name] as const)));
/** Each feature's node keys. */
// wave1-statecharts: a key may have several owners (`done`: parallel's on a parallel node, output's
// on another parent; `on`: wildcards reads it too), each of which decides whether the node is its own.
const KEYS = new Map<string, string[]>();
for (const [name, f] of FEATURES) for (const k of f.keys ?? []) KEYS.set(k, [...(KEYS.get(k) ?? []), name]);

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A shape, as far as the output needs it. */
interface Shape {
  readonly version: number;
  /** The events callers send. */
  readonly events: readonly string[];
  /** The leaves. */
  readonly states: readonly string[];
  /** Each leaf's contract, as written (normalized: ./hash.ts). */
  readonly contracts: ReadonlyMap<string, string>;
  /** The events the machine's tasks send it (setup's `internal`). */
  readonly internal: readonly string[];
  /** Each leaf's data and each event's payload, where written as a type literal (`types<{ by: string }>()`). */
  readonly data: ReadonlyMap<string, ReadonlyMap<string, Field>>;
  readonly payloads: ReadonlyMap<string, ReadonlyMap<string, Field>>;
  /** Each event's entry in setup (external and internal), where a problem with the event is reported. */
  readonly eventNodes: ReadonlyMap<string, ObjectProperty>;
  /** Each feature's part, in the feature table's order, with its import's local name when in use. */
  readonly features: readonly { readonly name: string; readonly local: string | null; readonly shape: FeatureShape }[];
}

/**
 * Where the core compiles a handler: the shape, the node (its leaf, when it is one) and the event
 * it handles, and the node's task: whether it has one, and the fields of the data its `run` reads
 * (`*` for all: the data passed on whole).
 */
interface Site {
  readonly shape: Shape;
  readonly state: string | null;
  readonly event: string | null;
  readonly task: boolean;
  /** The node has a task or a timer (`after`, `timeout`), which `keep` leaves running. */
  readonly timed: boolean;
  readonly reads: ReadonlySet<string>;
}

/**
 * A module-level name, as far as a transition's purity needs it: an import (by its source and the
 * name it imports), a function written in the file, a constant holding a primitive, one holding an
 * object or array literal with no functions in it (data), or anything else (a value: a call's
 * result, a class, an object with methods).
 */
type Binding =
  | { readonly kind: "import"; readonly source: string; readonly imported: string }
  | { readonly kind: "function"; readonly node: ArrowFunctionExpression | FunctionNode }
  | { readonly kind: "primitive" | "data" | "value" };

/**
 * What a handler's data is checked with (`checkKeys`): its `data` and `event` locals, every name it
 * declares, and the object literal a local const holds, when that const is the data it builds.
 */
interface Keys {
  readonly data: string | null;
  readonly event: string | null;
  readonly local: ReadonlySet<string>;
  readonly built: (name: string) => ObjectExpression | null;
}

/**
 * The object literal a handler builds its data in, `const next = { ... }; return to("open", next)`:
 * one const of the name, whose every use is a read of a field or a move's data. Passed anywhere
 * else (`Object.assign(next, extra)`, another name for it), it could gain keys its type doesn't list.
 */
function builtIn(
  fn: ArrowFunctionExpression | FunctionNode,
  name: string,
  isMove: (node: Node) => node is CallExpression,
): ObjectExpression | null {
  const inits: (Expression | null)[] = [];
  const consts = new Set<Node>();
  let escapes = false;
  walk(fn, (node, parent, key) => {
    if (node.type === "VariableDeclaration" && node.kind === "const") for (const d of node.declarations) consts.add(d);
    if (node.type !== "Identifier" || node.name !== name) return !escapes;
    if (parent?.type === "VariableDeclarator" && key === "id") inits.push(consts.has(parent) ? parent.init : null);
    else if (
      // A name (`x.next`, `{ next: 1 }`), a field read (`next.by`), or the data of a move.
      !(parent?.type === "MemberExpression" && (key === "object" || !parent.computed)) &&
      !(parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand) &&
      !(parent !== null && isMove(parent) && parent.arguments[1] === node)
    )
      escapes = true;
    return !escapes;
  });
  const [init] = inits;
  return inits.length === 1 && !escapes && init?.type === "ObjectExpression" ? init : null;
}

/** What a constant's initializer makes it. */
function bindingOf(init: Expression | null): Binding {
  let value = init;
  while (value?.type === "TSAsExpression" || value?.type === "TSSatisfiesExpression") value = value.expression;
  if (value === null || value === undefined) return { kind: "value" };
  if (isFunction(value)) return { kind: "function", node: value };
  if (
    (value.type === "Literal" && !(value.value instanceof RegExp)) ||
    (value.type === "TemplateLiteral" && value.expressions.length === 0) ||
    (value.type === "UnaryExpression" && value.argument.type === "Literal")
  )
    return { kind: "primitive" };
  if (value.type !== "ObjectExpression" && value.type !== "ArrayExpression") return { kind: "value" };
  let functions = false;
  walk(value, (n) => {
    if (isFunction(n) || (n.type === "Property" && n.kind !== "init")) functions = true;
    return !functions;
  });
  return { kind: functions ? "value" : "data" };
}

/** The names a function's body binds: its parameters, and every local it declares, at any depth. */
function localsOf(fn: ArrowFunctionExpression | FunctionNode): Set<string> {
  const out = new Set<string>(fn.params.flatMap((p) => boundNames(p)));
  if (fn.body !== null)
    walk(fn.body, (node) => {
      if (node.type === "VariableDeclarator") for (const n of boundNames(node.id)) out.add(n);
      if (isFunction(node)) for (const p of node.params) for (const n of boundNames(p)) out.add(n);
      if (node.type === "FunctionDeclaration" && node.id !== null) out.add(node.id.name);
      if (node.type === "CatchClause" && node.param !== null) for (const n of boundNames(node.param)) out.add(n);
      return true;
    });
  return out;
}

/** Whether a function's own body (not a nested function's) has JSX: it is a component. */
function rendersJSX(fn: Node): boolean {
  let found = false;
  walk(fn, (node) => {
    if (node !== fn && isFunction(node)) return false;
    if (node.type === "JSXElement" || node.type === "JSXFragment") found = true;
    return !found;
  });
  return found;
}

/** The calls that run a callback later: a send in one runs after the code that follows it. */
const TIMERS = new Set(["setTimeout", "setInterval", "queueMicrotask"]);

/** The `throw`s a function's body may end with: outside nested functions, and outside a `try` that catches. */
function throwsIn(body: Node): Node[] {
  const out: Node[] = [];
  walk(body, (node) => {
    if (node !== body && isFunction(node)) return false;
    if (node.type === "ThrowStatement") out.push(node);
    if (node.type !== "TryStatement" || node.handler === null) return true;
    out.push(...throwsIn(node.handler.body), ...(node.finalizer === null ? [] : throwsIn(node.finalizer)));
    return false;
  });
  return out;
}

function langOf(file: string): "ts" | "tsx" | "js" | "jsx" {
  return file.endsWith(".tsx") ? "tsx" : file.endsWith(".jsx") ? "jsx" : /\.[cm]?js$/.test(file) ? "js" : "ts";
}

/**
 * Check and compile the machines in one file. Returns null for a file with no machine (no `setup`
 * imported from @reactre/state) and nothing to report, or that doesn't parse (the next step reports
 * that). A file without a machine is still checked: where it calls @reactre/state, and, marked
 * `"use pure"`, its functions.
 *
 * @throws StateCompileError with every problem found.
 */
export function compile(file: string, source: string, options: CompileOptions = {}): { readonly code: string } | null {
  if (!source.includes("@reactre/state") && !source.includes(PURE) && !source.includes(".machine(")) return null;
  // Without parentheses as nodes: `() => ({ type: "done" })` returns an object literal.
  const lang = langOf(file);
  const parsed = parseSync(file, source, { lang, sourceType: "module", preserveParens: false });
  if (parsed.errors.length > 0) return null;
  const program: Program = parsed.program;
  const comments: readonly Comment[] = parsed.comments;

  const problems: { at: number; message: string }[] = [];
  const report: Report = (at, message) => {
    problems.push({ at: typeof at === "number" ? at : at.start, message });
  };
  const edits: Edit[] = [];
  const src = (node: Node): string => source.slice(node.start, node.end);
  /** The casts and `!`s already reported (in a transition), so a use site doesn't report them again. */
  const hidden = new Set<number>();

  /** Throws with every problem found, if any. */
  const fail = (): void => {
    if (problems.length === 0) return;
    const located = problems
      .sort((a, b) => a.at - b.at)
      .map((p) => {
        const before = source.slice(0, p.at);
        const line = before.split("\n").length;
        return { line, column: p.at - before.lastIndexOf("\n"), message: p.message };
      });
    throw new StateCompileError(file, source, located);
  };

  // #region Imports and module bindings

  let setupLocal: string | null = null;
  let typesLocal: string | null = null;
  const stateNamespaces = new Set<string>();
  let stateImport: ImportDeclaration | null = null;
  const stateImports: ImportDeclaration[] = [];
  // The features imported by name from their entries: local name -> feature.
  const featureLocals = new Map<string, string>();
  // @reactre/state's functions that take a machine, an actor or a snapshot, from any entry, by local
  // name: the use sites.
  const library = new Map<string, string>();
  // Those whose `this` refuses `any`, by local name: the arguments it checks.
  const refusesAny = new Map<string, readonly number[]>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    const from = statement.source.value;
    const entry = /^@reactre\/state\/([\w-]+)$/.exec(from)?.[1];
    for (const s of statement.specifiers)
      if (s.type === "ImportSpecifier" && s.importKind !== "type") {
        const imported = importedName(s);
        if (entry !== undefined && FEATURES.has(entry) && imported === entry) featureLocals.set(s.local.name, entry);
        if ((from === "@reactre/state" || from.startsWith("@reactre/state/")) && USES.has(imported))
          library.set(s.local.name, imported);
        const checked = REFUSES_ANY.get(`${from} ${imported}`);
        if (checked !== undefined) refusesAny.set(s.local.name, checked);
      }
  }
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "@reactre/state") continue;
    if (statement.importKind === "type") continue;
    stateImports.push(statement);
    for (const s of statement.specifiers) {
      if (s.type === "ImportNamespaceSpecifier") {
        stateNamespaces.add(s.local.name);
        stateImport = statement;
        continue;
      }
      if (s.type === "ImportDefaultSpecifier") {
        report(
          s,
          'import @reactre/state\'s functions by name (`import { setup, types } from "@reactre/state"`), so the compiler finds them',
        );
        continue;
      }
      if (s.importKind === "type") continue;
      const imported = importedName(s);
      if (imported === "setup") setupLocal = s.local.name;
      if (imported === "types") typesLocal = s.local.name;
    }
    stateImport = statement;
  }

  /** A library function's local spelling, including a supported namespace import. */
  const imported = (node: Node, name: "setup" | "types"): boolean =>
    (node.type === "Identifier" && node.name === (name === "setup" ? setupLocal : typesLocal)) ||
    (node.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier" &&
      stateNamespaces.has(node.object.name) &&
      node.property.type === "Identifier" &&
      node.property.name === name);

  // Module-level names: constants, functions, classes and imports may be read by a transition;
  const constants = new Set<string>();
  const mutable = new Set<string>();
  const exported = new Set<string>();
  const bindings = new Map<string, Binding>();
  const enums = new Set<string>();
  for (const top of program.body) {
    const statement = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (top.type === "ExportNamedDeclaration") {
      for (const s of top.specifiers) if (s.local.type === "Identifier") exported.add(s.local.name);
    }
    if (statement.type === "ImportDeclaration")
      for (const s of statement.specifiers) {
        // A default or namespace import is the module as a whole ("*").
        constants.add(s.local.name);
        const imported = s.type === "ImportSpecifier" ? importedName(s) : "*";
        bindings.set(s.local.name, { kind: "import", source: statement.source.value, imported });
      }
    else if (statement.type === "VariableDeclaration")
      for (const d of statement.declarations) {
        for (const name of boundNames(d.id)) {
          (statement.kind === "const" ? constants : mutable).add(name);
          if (top !== statement) exported.add(name);
          if (statement.kind === "const")
            bindings.set(name, d.id.type === "Identifier" ? bindingOf(d.init) : { kind: "value" });
        }
      }
    else if (statement.type === "FunctionDeclaration" && statement.id !== null) {
      constants.add(statement.id.name);
      bindings.set(statement.id.name, { kind: "function", node: statement });
    } else if (statement.type === "ClassDeclaration" && statement.id !== null) {
      constants.add(statement.id.name);
      bindings.set(statement.id.name, { kind: "value" });
    } else if (statement.type === "TSEnumDeclaration") enums.add(statement.id.name);
  }
  /** The module-level constants that hold an object literal: a table a transition may index. */
  const tables = new Set<string>();
  for (const top of program.body) {
    const s = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (s.type === "VariableDeclaration" && s.kind === "const")
      for (const d of s.declarations) {
        let init = d.init;
        while (init?.type === "TSAsExpression" || init?.type === "TSSatisfiesExpression") init = init.expression;
        if (d.id.type === "Identifier" && init?.type === "ObjectExpression") tables.add(d.id.name);
      }
  }

  /** The throws in a switch's `default` that checks nothing is left (`const left: never = ...`): M308's and M499's fix. */
  const neverChecks = new Set<Node>();
  walk(program, (node) => {
    const fallback = node.type === "SwitchStatement" ? node.cases.find((c) => c.test === null) : undefined;
    if (fallback !== undefined && /\bnever\b/.test(src(fallback)))
      walk(fallback, (n) => {
        if (n.type === "ThrowStatement") neverChecks.add(n);
        return true;
      });
    return true;
  });

  /**
   * M424, M426: setup's contracts. A union of literals with their own primitive is the primitive,
   * so the literals check nothing; an enum is a value senders must import (and cast to), where a
   * string union is JSON.
   */
  const checkContracts = (
    maps: readonly ReadonlyMap<string, ObjectProperty>[],
    input: Expression | undefined,
  ): void => {
    const written = [
      ...maps.flatMap((m) => [...m.values()].map((p) => p.value)),
      ...(input === undefined ? [] : [input]),
    ];
    for (const value of written) {
      const type = typeArgument(value);
      if (type !== null)
        walkType(type, (t) => {
          if (t.type === "TSTypeReference" && t.typeName.type === "Identifier" && enums.has(t.typeName.name))
            report(
              t,
              `${t.typeName.name} is an enum in a contract: senders must import it and cast strings to it. Write a string union instead ("a" | "b"), which is JSON and needs no import`,
            );
          if (t.type !== "TSUnionType") return true;
          const literal = (kind: string): boolean =>
            t.types.some(
              (u) => u.type === "TSLiteralType" && u.literal.type === "Literal" && typeof u.literal.value === kind,
            );
          const keyword = { string: "TSStringKeyword", number: "TSNumberKeyword" } as const;
          const widened = (["string", "number"] as const).find(
            (kind) => literal(kind) && t.types.some((u) => u.type === keyword[kind]),
          );
          if (widened !== undefined)
            report(
              t,
              `\`${src(t)}\` is ${widened}: its literals check nothing. Drop them, or write \`${widened} & {}\` in place of ${widened} to keep them as hints`,
            );
          return true;
        });
    }
  };

  /** An import's source is pure: one of @reactre/state's pure functions, a file marked pure, or a package in `pure`. */
  const pureImport = (b: { readonly source: string; readonly imported: string }): boolean => {
    if (b.source === "@reactre/state" || b.source.startsWith("@reactre/state/")) return LIBRARY_PURE.has(b.imported);
    if (b.source.startsWith(".")) return importIsPure(file, b.source);
    return (options.pure ?? []).some((p) => b.source === p || b.source.startsWith(`${p}/`));
  };

  /** The functions the compiler can see by name: the file's, and those a relative import exports. */
  const seen: Seen = (name) => {
    const b = bindings.get(name);
    if (b?.kind === "function") return { fn: b.node, seen };
    return b?.kind === "import" ? exportedFunction(file, b.source, b.imported) : null;
  };

  // The module-level names that return a promise: async functions, and functions (or variables)
  // typed to return a Promise, as `let save: (text: string) => Promise<string>`.
  const asyncNames = new Set<string>();
  const promised = (type: Node | undefined): boolean => type !== undefined && /^Promise\s*</.test(src(type));
  for (const top of program.body) {
    const s = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (s.type === "FunctionDeclaration" && s.id !== null && returnsPromise(s, src)) asyncNames.add(s.id.name);
    if (s.type === "VariableDeclaration")
      for (const d of s.declarations) {
        if (d.id.type !== "Identifier") continue;
        const typed = d.id.typeAnnotation?.typeAnnotation;
        const fn = d.init !== null && isFunction(d.init) && returnsPromise(d.init, src);
        if (fn || (typed?.type === "TSFunctionType" && promised(typed.returnType.typeAnnotation)))
          asyncNames.add(d.id.name);
      }
  }
  /** Whether a name the compiler can see returns a promise: the file's, or a relative import's async function. */
  const promises = (name: string): boolean => {
    if (asyncNames.has(name)) return true;
    const b = bindings.get(name);
    return b?.kind === "import" && exportedFunction(file, b.source, b.imported)?.fn.async === true;
  };

  /** The fix for a call of an import that isn't pure. */
  const impure = (name: string, source: string): string => {
    if (source === "@reactre/state" || source.startsWith("@reactre/state/"))
      return `${name} isn't one of @reactre/state's pure functions: a transition only decides the next state. Call it in a task's run or an effect (enq)`;
    // A package's name: `date-fns` of `date-fns/addDays`, `@scope/name` of `@scope/name/sub`.
    const pkg = source
      .split("/")
      .slice(0, source.startsWith("@") ? 2 : 1)
      .join("/");
    const how = source.startsWith(".")
      ? `if it only computes from its arguments, put "${PURE}"; as the first line of ${source} (the compiler then holds its functions to a transition's rules)`
      : `if its exports only compute from their arguments, list it in the plugin's pure option: state({ pure: [${JSON.stringify(pkg)}] })`;
    return `${name} is imported from ${source}, which isn't marked pure, so the compiler can't check what it does: ${how}. Or call it in a task's run or an effect (enq)`;
  };

  // A suppression hides what the type checker would report: the contract break goes unseen.
  // M576: and so does a linter's, of the rules that hold the code to its types.
  if (setupLocal !== null || stateNamespaces.size > 0)
    for (const c of comments)
      if (SUPPRESSION.test(c.value))
        report(c.start, "a @ts- suppression in a file with machines hides a broken contract: fix the error it hides");
      else if (LINT_SUPPRESSION.test(c.value))
        report(
          c.start,
          "a lint suppression in a file with machines hides a broken rule: remove it, and fix what it hides",
        );

  // #endregion

  // #region Purity

  /** Where a purity check runs: the names it may write, and how it reports. */
  interface Scope {
    /** Names declared in the function: it may assign them. */
    readonly local: ReadonlySet<string>;
    /** A handler's arguments: readonly by type, so the type checker reports a write to them. */
    readonly given: ReadonlySet<string>;
    /** A called function's parameters: its caller's values, which it may not change. */
    readonly borrowed: ReadonlySet<string>;
    /** `to` and the features' moves, called only directly. */
    readonly moves: ReadonlySet<string>;
    readonly report: Report;
    /** In a handler: the contract of a field it reads (`event.by`, `data.items`), where written as a type literal. */
    readonly fields?: (node: Node) => Field | null;
    /** In a handler: its event's local name. */
    readonly event?: string | null;
    /** In a handler (not a function it calls): a throw is the transition's own. */
    readonly handler?: boolean;
    /** The locals that hold an array (`const parts = text.split(",")`). */
    readonly arrays?: ReadonlySet<string>;
  }

  /** What a field a handler reads admits, by its contract. */
  const typeOf = (node: Node, scope: Scope): Admits | null => {
    const field = scope.fields?.(node) ?? null;
    return field === null ? null : admits(field);
  };
  /** The name of the method of a call whose value is an array (`split(...)`, `Object.keys(...)`), if it is one. */
  const arrayCall = (node: Node): string | null => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return null;
    const method = node.callee.property.type === "Identifier" ? node.callee.property.name : "";
    const root = rootName(node.callee.object);
    const array = ["keys", "values", "entries", "from", "of"].includes(method)
      ? root === "Object" || root === "Array"
      : ARRAYS.has(method);
    return array ? method : null;
  };
  /** The value is an array: a literal, an array-making call, a local holding one, or a field typed as one. */
  const isArray = (node: Node, scope: Scope): boolean =>
    node.type === "ArrayExpression" ||
    arrayCall(node) !== null ||
    (node.type === "Identifier" && scope.arrays?.has(node.name) === true) ||
    typeOf(node, scope)?.array === true;
  /** A field typed as an object or an array, which `===` and `includes` compare by reference. */
  const byReference = (node: Node, scope: Scope): boolean => {
    const t = typeOf(node, scope);
    return t !== null && (t.object || t.array);
  };
  /** A number written in place (`30000`, `-1`). */
  const numberIn = (node: Node | undefined): number | null => {
    if (node?.type === "Literal" && typeof node.value === "number") return node.value;
    const inner = node?.type === "UnaryExpression" && node.operator === "-" ? numberIn(node.argument) : null;
    return inner === null ? null : -inner;
  };
  /** `Math.<name>(...)`'s name, for a call of one. */
  const mathCall = (node: Node): string | null =>
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Math" &&
    node.callee.property.type === "Identifier"
      ? node.callee.property.name
      : null;
  /** The methods that read the environment's locale, and the argument that names one. */
  const LOCALE: ReadonlyMap<string, number> = new Map([
    ["toLocaleUpperCase", 0],
    ["toLocaleLowerCase", 0],
    ["toLocaleString", 0],
    ["toLocaleDateString", 0],
    ["toLocaleTimeString", 0],
    ["localeCompare", 1],
  ]);
  /** The callbacks of these methods return to the method, not to the handler. */
  const CALLBACKS = new Set(["forEach", "map", "filter", "some", "every", "find", "findIndex", "flatMap", "reduce"]);

  /** A call in a transition: M488's reversed clamp, M489's locale, M491's holes, M415's `includes`. */
  function checkCall(node: CallExpression, scope: Scope): void {
    const callee = node.callee;
    // M491: `Array(n)` is n holes, which map and forEach skip.
    const [first] = node.arguments;
    if (
      callee.type === "Identifier" &&
      callee.name === "Array" &&
      node.arguments.length === 1 &&
      first !== undefined &&
      first.type !== "SpreadElement" &&
      stringValue(first) === null
    )
      scope.report(
        node,
        `Array(${src(first)}) is ${src(first)} holes, which map and forEach skip (and JSON saves as null): Array.from({ length: ${src(first)} }, () => ...)`,
      );
    // M488: min(max(x, a), b) with a > b is b, and max(min(x, a), b) with b > a is b.
    const outer = mathCall(node);
    if ((outer === "min" || outer === "max") && node.arguments.length === 2) {
      const inner = node.arguments.find((a) => mathCall(a) === (outer === "min" ? "max" : "min"));
      const bound = numberIn(node.arguments.find((a) => a !== inner));
      const other = inner?.type === "CallExpression" ? inner.arguments.map(numberIn).find((n) => n !== null) : null;
      if (bound !== null && other !== null && other !== undefined && (outer === "min" ? other > bound : other < bound))
        scope.report(
          node,
          `this Math.${outer} of Math.${outer === "min" ? "max" : "min"} always gives ${bound}: the bounds are swapped. Clamp with Math.min(Math.max(x, low), high), low below high`,
        );
    }
    if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;
    const method = callee.property.name;
    // M489: a locale method without a locale gives what the environment's locale says.
    const at = LOCALE.get(method);
    const locale = at === undefined ? undefined : node.arguments[at];
    if (at !== undefined && (locale === undefined || (locale.type === "Identifier" && locale.name === "undefined")))
      scope.report(
        node,
        method === "toLocaleUpperCase" || method === "toLocaleLowerCase"
          ? `${method} depends on the environment's locale, so the step differs from machine to machine: ${method === "toLocaleUpperCase" ? "toUpperCase" : "toLowerCase"}(), or pass the locale, ${method}("en-US")`
          : `${method} depends on the environment's locale, so the step differs from machine to machine: pass the locale${method === "localeCompare" ? " as its second argument" : ""} ("en-US"), and a timeZone for a date, or format it where you show it`,
      );
    if (
      (method === "includes" || method === "indexOf" || method === "lastIndexOf") &&
      first !== undefined &&
      byReference(first, scope)
    )
      scope.report(
        node,
        `${method} compares objects by reference, and every payload (and every restored value) is a new object: compare an id, ${src(callee.object)}.some((item) => item.id === ${src(first)}.id)`,
      );
  }

  /** M493: `x.splice(i, …)` inside a forward `for` over `x.length` skips the item after each removed one. */
  function checkSplices(loop: Node, problem: Report): void {
    if (loop.type !== "ForStatement" || loop.test?.type !== "BinaryExpression" || loop.update === null) return;
    const { test, update } = loop;
    const counter = test.left.type === "Identifier" ? test.left.name : null;
    const list =
      (test.operator === "<" || test.operator === "<=") &&
      test.right.type === "MemberExpression" &&
      !test.right.computed &&
      test.right.property.type === "Identifier" &&
      test.right.property.name === "length"
        ? rootName(test.right.object)
        : null;
    const forward =
      (update.type === "UpdateExpression" && update.operator === "++") ||
      (update.type === "AssignmentExpression" && update.operator === "+=");
    if (counter === null || list === null || !forward) return;
    walk(loop.body, (n) => {
      if (
        n.type === "CallExpression" &&
        n.callee.type === "MemberExpression" &&
        !n.callee.computed &&
        n.callee.property.type === "Identifier" &&
        n.callee.property.name === "splice" &&
        rootName(n.callee.object) === list &&
        n.arguments[0]?.type === "Identifier" &&
        n.arguments[0].name === counter
      )
        problem(
          n,
          `${list}.splice(${counter}, …) in a forward loop over ${list}.length skips the item after each one it removes: ${list}.filter((item) => ...) keeps the ones you want`,
        );
      return true;
    });
  }

  /** M496: a value that is never falsy by its contract (`event`, an array, literals with no falsy one). */
  const alwaysTruthy = (node: Node, scope: Scope): boolean => {
    if (node.type === "Identifier" && node.name === scope.event) return true;
    const t = typeOf(node, scope);
    return (
      t !== null &&
      !t.nullish &&
      !t.other &&
      !t.string &&
      !t.number &&
      !t.boolean &&
      t.literals.every(Boolean) &&
      (t.object || t.array || t.literals.length > 0)
    );
  };

  /** The file's own functions a transition calls, each checked once (so a cycle ends). */
  const checkedFunctions = new Set<string>();
  // Marked by its first statement, `"use pure";` (comments may come before it).
  const first = program.body[0];
  const pureModule = first?.type === "ExpressionStatement" && first.directive === PURE;

  /** Checks a function of this file a transition reaches, by a transition's rules, once. */
  function checkFunction(name: string, fn: ArrowFunctionExpression | FunctionNode): void {
    if (checkedFunctions.has(name) || fn.body === null) return;
    checkedFunctions.add(name);
    const where = pureModule ? `in ${name}, in a module marked "${PURE}"` : `in ${name}, which a transition calls`;
    const local = localsOf(fn);
    const scope: Scope = {
      local,
      given: new Set(),
      borrowed: new Set(fn.params.flatMap((p) => boundNames(p))),
      moves: new Set(),
      report: (at, message) => report(at, `${where}: ${message}`),
    };
    walk(fn.body, pureVisitor(scope));
  }

  /** A condition whose value is an array (`split(...)`, `filter(...)`, `Object.keys(...)`): always truthy. */
  function checkCondition(test: Node, scope: Scope): void {
    if (test.type === "LogicalExpression") {
      checkCondition(test.left, scope);
      checkCondition(test.right, scope);
      return;
    }
    // `!` is checked where it is (the visitor's UnaryExpression), in a condition or not.
    if (alwaysTruthy(test, scope))
      scope.report(
        test,
        `\`${src(test)}\` is always truthy by its contract, so this condition always passes: compare the field you mean (=== a value, .length > 0)`,
      );
    const method = arrayCall(test);
    if (method !== null)
      scope.report(
        test,
        `${method}(...) returns an array, and an array is always truthy: this condition always passes. Test what you mean: .length > 0, .some(...) or .includes(...)`,
      );
  }

  /** Purity over a function's body: a move's arguments are checked by the caller, not its callee. */
  function pureVisitor(scope: Scope): (node: Node, parent: Node | null, key: string) => boolean {
    const { local, given, borrowed, moves } = scope;
    const problem = scope.report;
    return (node, parent, key) => {
      switch (node.type) {
        case "Identifier": {
          if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) return true;
          if ((parent?.type === "Property" && key === "key" && !parent.computed) || parent?.type === "LabeledStatement")
            return true;
          const n = node.name;
          if (moves.has(n)) {
            problem(node, `call ${n}(...) directly: ${n}("state", ...), so the compiler can compile it`);
            return true;
          }
          if (local.has(n) || PURE_GLOBALS.has(n)) return true;
          if (enums.has(n)) {
            problem(
              node,
              `${n} is an enum: a transition reads its members as values the sender had to import. Write a string union in the contract ("a" | "b"), and compare the strings`,
            );
            return true;
          }
          if (n === "Intl") {
            problem(
              node,
              "Intl formats by the environment's locale and time zone, so the step differs from machine to machine: format the value where you show it, and keep data plain",
            );
            return true;
          }
          const binding = bindings.get(n);
          if (binding?.kind === "function") checkFunction(n, binding.node);
          if (constants.has(n)) return true;
          if (mutable.has(n))
            problem(
              node,
              `a transition reads module-level let ${n}, which can change: depend only on data and the event, or make it a const`,
            );
          else if (n === "Date")
            problem(
              node,
              'Date reads the clock: put the time in the event (`{ type: "tick", now: Date.now() }` where you send it)',
            );
          else
            problem(
              node,
              `${n} is a global a transition may not read: depend only on data, the event, module constants and imports`,
            );
          return true;
        }
        case "MemberExpression":
          if (
            !node.computed &&
            node.object.type === "Identifier" &&
            node.object.name === "Math" &&
            node.property.type === "Identifier" &&
            node.property.name === "random"
          )
            problem(
              node,
              "Math.random makes a transition give different results for the same events: put the random value in the event",
            );
          // M495: a module table indexed by a string from outside finds its prototype's members too.
          if (
            node.computed &&
            node.object.type === "Identifier" &&
            tables.has(node.object.name) &&
            typeOf(node.property, scope)?.string === true
          )
            problem(
              node,
              `${node.object.name}[${src(node.property)}] reads ${node.object.name}'s prototype too ("constructor" finds a function): use a Map, a switch, or check Object.hasOwn(${node.object.name}, ${src(node.property)}) first`,
            );
          return true;
        case "AssignmentExpression":
        case "UpdateExpression":
        case "UnaryExpression": {
          if (node.type === "UnaryExpression" && node.operator !== "delete") {
            if (node.operator === "!") checkCondition(node.argument, scope);
            // M498: a string field negated is NaN, saved as null.
            const t = node.operator === "-" ? typeOf(node.argument, scope) : null;
            if (t?.string === true && !t.number && !t.other)
              problem(
                node,
                `-${src(node.argument)} negates a string field, which gives NaN (saved as null): make the field a number in its contract`,
              );
            return true;
          }
          const target = node.type === "AssignmentExpression" ? node.left : node.argument;
          const root = rootName(target);
          // M492: an array's element deleted leaves a hole, null after JSON, and the length as it was.
          if (
            node.type === "UnaryExpression" &&
            target.type === "MemberExpression" &&
            target.computed &&
            (isArray(target.object, scope) ||
              (target.property.type === "Literal" && typeof target.property.value === "number"))
          ) {
            const i = src(target.property);
            problem(
              node,
              `delete leaves a hole in ${src(target.object)}: null after JSON, and its length unchanged. Remove the item with ${src(target.object)}.toSpliced(${i}, 1), or filter`,
            );
            return true;
          }
          // The handler's own locals may change. Its arguments are readonly by type: the type
          // checker reports a write to them. Anything else is outside the transition.
          if (root !== null && given.has(root)) return true;
          if (target.type === "Identifier" && local.has(target.name)) return true;
          if (target.type === "MemberExpression" && root !== null && local.has(root) && !borrowed.has(root))
            return true;
          problem(
            node,
            node.type === "UnaryExpression"
              ? `delete changes ${root ?? "an object"}, outside the transition: build the next state's data with to(state, { ... })`
              : `a transition doesn't change ${root ?? "anything"} outside it: build the next state's data with to(state, { ... })`,
          );
          return true;
        }
        case "ConditionalExpression":
        case "IfStatement":
          checkCondition(node.test, scope);
          return true;
        case "CallExpression": {
          const callee = node.callee;
          checkCall(node, scope);
          // A function this file doesn't declare: an import from a module that isn't pure, or a
          // constant made some other way, is code the compiler can't see.
          if (callee.type === "Identifier" && !local.has(callee.name) && !given.has(callee.name)) {
            const b = bindings.get(callee.name);
            if (b?.kind === "import" && !pureImport(b)) problem(node, impure(callee.name, b.source));
            else if (b !== undefined && b.kind !== "import" && b.kind !== "function")
              problem(
                node,
                `${callee.name} isn't a function written in this file, so the compiler can't check what it does: declare it here with function or an arrow, import it from a module marked pure, or call it in a task's run or an effect (enq)`,
              );
            return true;
          }
          if (callee.type !== "MemberExpression") return true;
          const method = callee.property.type === "Identifier" ? callee.property.name : null;
          const owner = rootName(callee.object);
          // A method that changes its object, called on something outside the transition.
          if (!callee.computed && method !== null && MUTATORS.has(method)) {
            // Object.assign(target, ...) changes its first argument; a new `{}` is the transition's own.
            const first = node.arguments[0];
            const changed = owner === "Object" ? (first ?? null) : callee.object;
            if (changed === null || changed.type === "ObjectExpression" || changed.type === "ArrayExpression")
              return true;
            const root = rootName(changed);
            if (root !== null && (!local.has(root) || borrowed.has(root)))
              problem(
                node,
                `${method} changes ${root}, outside the transition: build the next state's data with to(state, { ... })`,
              );
            return true;
          }
          // A method of a module value (`bus.send(...)`): what it does is outside the compiler's sight.
          const b = owner === null || local.has(owner) || given.has(owner) ? undefined : bindings.get(owner);
          if (b !== undefined && (b.kind === "import" ? !pureImport(b) : b.kind !== "data" && b.kind !== "primitive"))
            problem(
              node,
              `${src(callee)}(...) calls a method of ${owner}, a module value: a transition can't see what it does, and only decides the next state. Call it in an effect (enq(() => ${src(callee)}(...))) or a task's run`,
            );
          return true;
        }
        case "NewExpression":
          problem(node, "a transition doesn't construct objects with new: data is JSON, built from literals");
          return true;
        case "ThrowStatement":
          // M484: a transition refuses an event by declining it, or says why in the state it goes to.
          if (scope.handler !== true || neverChecks.has(node)) return true;
          problem(
            node,
            "a throw in a transition errors the actor, and the sender never hears why: decline the event with null, or go to a state whose data says why",
          );
          return false;
        case "TemplateLiteral":
          // M497: an object in a template is "[object Object]", an array its items joined by commas.
          for (const e of node.expressions) {
            const t = typeOf(e, scope);
            if ((e.type === "Identifier" && e.name === scope.event) || (t !== null && (t.object || t.array)))
              problem(
                e,
                `the template prints ${src(e)} as "[object Object]" (or its items joined by commas): interpolate a field of it, or JSON.stringify(${src(e)})`,
              );
          }
          return true;
        case "LogicalExpression": {
          // M486: `||` replaces every falsy value, "" and 0 too, not only null.
          const t = node.operator === "||" ? typeOf(node.left, scope) : null;
          if (
            t !== null &&
            (t.string || t.number || t.boolean || t.literals.some((l) => l === "" || l === 0 || l === false))
          )
            problem(
              node,
              `${src(node.left)} || ... replaces "", 0 and false too, not only a missing value: use ?? for null and undefined, or compare it (${src(node.left)} === "" ? ... : ...)`,
            );
          return true;
        }
        case "BinaryExpression":
          // M415: objects compare by reference, and every payload and restored value is a new one.
          if (
            ["===", "!==", "==", "!="].includes(node.operator) &&
            [node.left, node.right].some((s) => byReference(s, scope))
          )
            problem(
              node,
              `${node.operator} compares objects by reference, and every payload (and every restored value) is a new object: compare an id, ${src(node.left)}.id ${node.operator} ${src(node.right)}.id`,
            );
          return true;
        case "ForStatement":
          checkSplices(node, problem);
          return true;
        case "ForInStatement":
          // M494: for…in over an array gives its indexes as strings, and inherited keys.
          if (isArray(node.right, scope))
            problem(
              node,
              `for…in over an array gives string keys (and any inherited ones): use for (const item of ${src(node.right)}), or .entries() for the index`,
            );
          return true;
        case "SwitchStatement": {
          // M499: a default over a union of literals takes a member added later, unseen.
          const t = typeOf(node.discriminant, scope);
          const fallback = node.cases.find((c) => c.test === null);
          if (
            t !== null &&
            fallback !== undefined &&
            t.literals.length > 0 &&
            !t.string &&
            !t.number &&
            !t.boolean &&
            !t.object &&
            !t.array &&
            !t.other &&
            !/\bnever\b/.test(src(fallback))
          )
            problem(
              fallback,
              `a default in a switch over ${src(node.discriminant)} takes a member added to its union later, unseen: write a case for each, and end with the check that none is left, default: { const left: never = ${src(node.discriminant)}; return left; }`,
            );
          return true;
        }
        case "MetaProperty":
        case "ImportExpression":
          problem(node, "a transition doesn't read the module or import: depend only on data and the event");
          return true;
        case "TSAsExpression":
        case "TSTypeAssertion":
        case "TSNonNullExpression": {
          const kind = hides(node, src);
          if (kind !== null) hidden.add(node.start);
          if (kind === "cast")
            problem(node, "a cast in a transition hides a broken contract: remove it, and fix the type it hides");
          if (kind === "non-null")
            problem(node, "a non-null assertion (!) hides a broken contract: check for null instead");
          return true;
        }
        default:
          return true;
      }
    };
  }

  // A module marked pure promises that a transition may call any of its functions: each is checked.
  if (pureModule) for (const [name, b] of bindings) if (b.kind === "function") checkFunction(name, b.node);

  // #endregion

  // #region Shapes

  /** One of setup's maps (states, events, children), which must be written in place. */
  const mapOf = (value: Expression | undefined, what: string): Map<string, ObjectProperty> => {
    if (value === undefined) return new Map();
    if (value.type !== "ObjectExpression") {
      const resolved = staticNode(file, program, value);
      if (resolved?.type === "ObjectExpression") return propertiesOf(resolved, report, `setup's ${what}`);
      report(
        value,
        `setup's ${what} is an object literal or an immutable binding to one, so the compiler knows the names`,
      );
      return new Map();
    }
    return propertiesOf(value, report, `setup's ${what}`);
  };

  /** A contract written as `types<T>()`, not a schema (a runtime value). */
  const isTypes = (value: Expression): boolean => value.type === "CallExpression" && imported(value.callee, "types");

  /**
   * Setup's `use`: the features it lists, by name, with their imports' local names. An array of
   * the imported names, written in place, so the compiler knows which features' hooks to emit: a
   * variable, a spread or another name type-checks, but can't be compiled.
   */
  const usesOf = (value: Expression | undefined): Map<string, string> => {
    const out = new Map<string, string>();
    if (value === undefined) return out;
    const how =
      'each imported by name from its entry: import { nested } from "@reactre/state/nested", then use: [nested]';
    const array = value.type === "ArrayExpression" ? value : staticNode(file, program, value);
    if (array?.type !== "ArrayExpression") {
      report(value, `setup's use is an array of features, or an immutable binding to one, ${how}`);
      return out;
    }
    for (const item of array.elements) {
      // A feature may be listed through an immutable alias or an explicit namespace import.
      if (item?.type === "Literal" && typeof item.value === "string") continue;
      const featureNode =
        item?.type === "Identifier" && bindings.get(item.name)?.kind === "value"
          ? staticNode(file, program, item)
          : item;
      const feature =
        featureNode?.type === "Identifier"
          ? featureLocals.get(featureNode.name)
          : featureNode?.type === "MemberExpression" &&
              !featureNode.computed &&
              featureNode.object.type === "Identifier" &&
              featureNode.property.type === "Identifier" &&
              bindings.get(featureNode.object.name)?.kind === "import" &&
              featureNode.property.name === featureNode.object.name &&
              FEATURES.has(featureNode.property.name)
            ? featureNode.property.name
            : undefined;
      if (
        featureNode !== null &&
        featureNode !== undefined &&
        featureNode.type === "Identifier" &&
        feature !== undefined
      )
        out.set(feature, featureNode.name);
      else if (
        featureNode !== null &&
        featureNode !== undefined &&
        featureNode.type === "MemberExpression" &&
        feature !== undefined
      )
        out.set(feature, src(featureNode));
      else report(item ?? value, `setup's use lists features by the names they are imported with, ${how}`);
    }
    return out;
  };

  /**
   * Setup's `shape`, the hash of its version and contracts (./hash.ts): a saved snapshot fits the
   * machine only while they hold, so a persisted machine has one, and any machine may. The
   * compiler can't see the contracts of an earlier version, only that the hash no longer matches.
   */
  const checkShape = (
    call: CallExpression,
    name: string,
    version: number,
    props: ReadonlyMap<string, ObjectProperty>,
    persisted: boolean,
    maps: readonly ReadonlyMap<string, ObjectProperty>[],
  ): void => {
    const value = props.get("shape")?.value;
    if (value === undefined && !persisted) return;
    // A shape that isn't a string is a type error.
    if (value?.type === "Literal" && typeof value.value !== "string") return;
    const contracts = shapeText({ program, file, src, name, maps, input: props.get("input")?.value });
    const at = (v: number): string => hash(`${v}|${contracts}`);
    const now = at(version);
    if (value === undefined)
      report(
        call,
        `${name} is persisted, so its shape is checked: add shape: "${now}" to setup (the build computes it; it changes when the states, events or version change)`,
      );
    else if (value.type !== "Literal") report(value, `shape is the hash written in place, a string: shape: "${now}"`);
    else if (value.value !== now) {
      // The contracts as they are, at an earlier version: only the version changed.
      const earlier = Array.from({ length: Math.min(version, 100) }, (_, i) => version - 1 - i);
      if (earlier.some((v) => at(v) === value.value))
        report(value, `set shape: "${now}", the hash of ${name}'s contracts at version ${version}`);
      else
        report(
          value,
          `the shape of ${name} no longer matches its hash, so snapshots saved before may not fit it: if you changed its states, events or input, set version: ${version + 1}, add a migration from ${version} (migrations(machine).from<${version}, { ...its states before }>(...)), and set shape: "${at(version + 1)}"; if you already set the version for this change, set shape: "${now}"`,
        );
    }
  };

  const shapes = new Map<string, Shape>();
  const shapeCalls: { readonly call: CallExpression; readonly name: string; readonly declarations: string | null }[] =
    [];
  if (setupLocal !== null || stateNamespaces.size > 0)
    walk(program, (node, parent) => {
      if (node.type !== "CallExpression" || !imported(node.callee, "setup")) return true;
      if (parent?.type !== "VariableDeclarator" || parent.id.type !== "Identifier" || !constants.has(parent.id.name)) {
        report(node, "setup(...) is the value of a module-level const: `const shape = setup({ ... })`");
        return false;
      }
      const arg = node.arguments[0];
      if (arg === undefined || arg.type !== "ObjectExpression" || node.arguments.length !== 1) {
        report(node, "setup takes one object literal written in place: `setup({ states, events })`");
        return false;
      }
      const name = parent.id.name;
      const props = propertiesOf(arg, report, "setup's argument");
      const versionNode = props.get("version")?.value;
      let version = 0;
      if (versionNode !== undefined) {
        const resolved = staticValue(file, program, versionNode);
        if (typeof resolved === "number" && Number.isInteger(resolved) && resolved >= 0) version = resolved;
        else report(versionNode, "version is a statically known nonnegative integer");
      }
      const states = mapOf(props.get("states")?.value, "states");
      const events = mapOf(props.get("events")?.value, "events");
      const internal = mapOf(props.get("internal")?.value, "internal");
      const uses = usesOf(props.get("use")?.value);
      checkShape(node, name, version, props, uses.has("persist") || uses.has("durable"), [states, events, internal]);

      // Each feature reads its own options, whether or not `use` lists it: a feature that's off is a
      // type error, and the compiler compiles past it.
      const features = [...FEATURES].map(([feature, compiler]) => {
        const local = uses.get(feature) ?? null;
        const shape: FeatureShape =
          compiler.shape?.({
            name,
            options: props,
            states,
            events,
            internal,
            local,
            report,
            src,
            isTypes,
            string: (expression) => {
              const resolved = staticValue(file, program, expression);
              return typeof resolved === "string" ? resolved : null;
            },
            map: mapOf,
          }) ?? {};
        return { name: feature, local, shape };
      });
      const declarations = features.flatMap((f) => (f.shape.declarations === undefined ? [] : [f.shape.declarations]));
      shapeCalls.push({ call: node, name, declarations: declarations.length > 0 ? declarations.join("\n") : null });
      const contracts = new Map([...states].map(([leaf, p]) => [leaf, normalize(src(p.value))] as const));
      const typed = (map: ReadonlyMap<string, ObjectProperty>): Map<string, ReadonlyMap<string, Field>> =>
        new Map(
          [...map].flatMap(([key, p]) => {
            const fields = isTypes(p.value) ? fieldsOf(typeArgument(p.value)) : null;
            return fields === null ? [] : [[key, fields] as const];
          }),
        );
      checkContracts([states, events, internal], props.get("input")?.value);
      shapes.set(name, {
        version,
        events: [...events.keys()],
        states: [...states.keys()],
        contracts,
        features,
        internal: [...internal.keys()],
        data: typed(states),
        payloads: typed(new Map([...events, ...internal])),
        eventNodes: new Map([...events, ...internal]),
      });
      return false;
    });

  // #endregion

  // #region Use sites

  /**
   * Where the file calls @reactre/state, in any file: the line of `createActor(machine)` (and of
   * every other call of the library) hides nothing from the type checker, a component doesn't make
   * an actor or a machine on each render, a shape's machines are made in its own file, and a
   * migration step is a transition.
   */
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (at: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= at) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  /** The lines of each call of @reactre/state, with the name it is called by. */
  const uses: { readonly from: number; readonly to: number; readonly name: string }[] = [];
  /** Names bound to what such a call returns (an actor, a snapshot, `useActor`'s pair), and to its snapshots. */
  const tracked = new Set<string>();
  /** The machine each actor runs, by name, where the file names it: actor -> machine. */
  const runs = new Map<string, string>();
  const migrationsLocal = [...library].find(([, imported]) => imported === "migrations")?.[0] ?? null;
  const isLibraryCall = (node: Node): node is CallExpression =>
    node.type === "CallExpression" && node.callee.type === "Identifier" && library.has(node.callee.name);
  /** The bottom of `migrations(m).from(...).from(...)`, if `call` is one of its steps. */
  const isMigration = (call: CallExpression): boolean => {
    let n: Node = call;
    while (n.type === "CallExpression" && n.callee.type === "MemberExpression") n = n.callee.object;
    return (
      n !== call && n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === migrationsLocal
    );
  };

  /** The arguments a use site's `this` checks for `any`: a cast to `any` there is a type error. */
  const anyChecked = new Set<Node>();
  /** Visits every node with the function it is in (null at module level). */
  function scan(node: Node, fn: Node | null): void {
    if (isLibraryCall(node)) {
      const local = node.callee.type === "Identifier" ? node.callee.name : "";
      const name = library.get(local) ?? "";
      uses.push({ from: lineOf(node.start), to: lineOf(node.end), name });
      for (const i of refusesAny.get(local) ?? []) {
        const arg = node.arguments[i];
        if (arg !== undefined) anyChecked.add(arg);
      }
      if (name === "createActor" && fn !== null && rendersJSX(fn))
        report(
          node,
          "createActor in a component makes a new actor on every render, and nothing stops it: use useActor(machine) from @reactre/state/react, which keeps one actor and stops it on unmount",
        );
    }
    if (node.type === "VariableDeclarator" && node.init !== null) {
      const init = node.init.type === "AwaitExpression" ? node.init.argument : node.init;
      const from =
        init.type === "CallExpression" && init.callee.type === "MemberExpression"
          ? rootName(init.callee.object)
          : init.type === "MemberExpression"
            ? rootName(init)
            : null;
      if (isLibraryCall(init) || (from !== null && tracked.has(from)))
        for (const n of boundNames(node.id)) tracked.add(n);
      // The machine an actor runs, by the actor's name: `createActor(m)`, `useActorRef(m)`, `useActor(m)`'s second.
      if (isLibraryCall(init) && init.arguments[0]?.type === "Identifier") {
        const name = library.get(init.callee.type === "Identifier" ? init.callee.name : "");
        const actor =
          name === "useActor" && node.id.type === "ArrayPattern"
            ? node.id.elements[1]
            : name === "createActor" || name === "useActorRef"
              ? node.id
              : null;
        if (actor?.type === "Identifier") runs.set(actor.name, init.arguments[0].name);
      }
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed) {
      const object = node.callee.object;
      const method = node.callee.property.type === "Identifier" ? node.callee.property.name : "";
      // A snapshot listener's parameter is a snapshot.
      if (method === "subscribe" && tracked.has(rootName(object) ?? ""))
        for (const a of node.arguments)
          if (isFunction(a)) for (const p of a.params) for (const n of boundNames(p)) tracked.add(n);
      if (method === "from" && isMigration(node))
        for (const a of node.arguments)
          if (isFunction(a) && a.body !== null)
            walk(
              a.body,
              pureVisitor({
                local: localsOf(a),
                given: new Set(),
                borrowed: new Set(),
                moves: new Set(),
                report: (at, message) => report(at, `a migration step is a transition too: ${message}`),
              }),
            );
      if (method === "machine" && object.type === "Identifier") {
        const b = bindings.get(object.name);
        if (shapes.has(object.name) && fn !== null)
          report(
            node,
            `${object.name}.machine(...) inside a function makes a new machine on each call (in a component, on every render): make it once, at module level: export const ${object.name}Machine = ${object.name}.machine({ ... })`,
          );
        if (b?.kind === "import" && exportedShapes(file, b.source).has(b.imported))
          report(
            node,
            `${object.name} is a shape from ${b.source}: its machines are written in its own file, where the compiler sees them with it. Move this ${object.name}.machine({ ... }) to ${b.source}, export the machine, and import that`,
          );
      }
    }
    const inner = isFunction(node) ? node : fn;
    walk(node, (child) => {
      if (child === node) return true;
      scan(child, inner);
      return false;
    });
  }
  scan(program, null);

  /** `actor.method(...)` on an actor (a name a call of @reactre/state gave): the actor's name. */
  const actorCall = (node: Node, method: string): string | null =>
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === method &&
    node.callee.object.type === "Identifier" &&
    tracked.has(node.callee.object.name)
      ? node.callee.object.name
      : null;
  /**
   * The sends in `root` whose result is dropped: `actor.send(...)` as a statement, voided, or as
   * the body of a timer's arrow (`setTimeout(() => actor.send(...))`).
   */
  const droppedSends = (root: Node, found: (call: Node, actor: string) => void): void =>
    walk(root, (node) => {
      const dropped =
        node.type === "ExpressionStatement"
          ? node.expression
          : node.type === "UnaryExpression" && node.operator === "void"
            ? node.argument
            : node.type === "CallExpression" &&
                node.callee.type === "Identifier" &&
                TIMERS.has(node.callee.name) &&
                node.arguments[0]?.type === "ArrowFunctionExpression" &&
                node.arguments[0].expression
              ? node.arguments[0].body
              : null;
      const actor = dropped === null ? null : actorCall(dropped, "send");
      if (dropped !== null && actor !== null) found(dropped, actor);
      return true;
    });
  /** The sends reported as after a stop, which the unhandled-event check (below) leaves alone. */
  const afterStop = new Set<Node>();
  /** Names typed as a snapshot (`s: Snapshot<...>`, `s: ReturnType<typeof actor.snapshot>`). */
  const snapshots = new Set<string>();
  walk(program, (node) => {
    const annotation = node.type === "Identifier" && "typeAnnotation" in node ? (node.typeAnnotation ?? null) : null;
    if (node.type === "Identifier" && annotation !== null && /snapshot/i.test(src(annotation)))
      snapshots.add(node.name);
    return true;
  });
  /** A switch's subject is a snapshot's state: `s.state` of a snapshot, or `actor.snapshot().state`. */
  const onState = (node: Node): boolean => {
    if (node.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier") return false;
    const object = node.object;
    return (
      node.property.name === "state" &&
      ((object.type === "Identifier" && (tracked.has(object.name) || snapshots.has(object.name))) ||
        (object.type === "CallExpression" && actorCall(object, "snapshot") !== null))
    );
  };
  walk(program, (node) => {
    // M50: a send after the actor's stop, in the same body, is refused ("inactive"), silently.
    if (node.type === "Program" || node.type === "BlockStatement")
      node.body.forEach((statement, i) => {
        const actor = statement.type === "ExpressionStatement" ? actorCall(statement.expression, "stop") : null;
        if (actor === null) return;
        for (const later of node.body.slice(i + 1)) {
          // `actor = createActor(machine)`: a new actor from here on.
          let renewed = false;
          walk(later, (n) => {
            if (n.type === "AssignmentExpression" && n.left.type === "Identifier" && n.left.name === actor)
              renewed = true;
            return !renewed;
          });
          if (renewed) break;
          droppedSends(later, (call, a) => {
            if (a !== actor || afterStop.has(call)) return;
            afterStop.add(call);
            report(
              call,
              `${a}.send(...) after ${a}.stop() is refused ("inactive"), and its result is dropped, so nothing says so: a stopped actor takes no events. Send before stopping it, or start a new actor, createActor(machine)`,
            );
          });
        }
      });
    // M53: `await actor.send(...)` waits for nothing: send returns its result at once.
    const awaited = node.type === "AwaitExpression" ? actorCall(node.argument, "send") : null;
    if (awaited !== null)
      report(
        node,
        `await ${awaited}.send(...) waits for nothing: send returns its result at once, when the transition is made, not when the state's task ends. Wait for the state the task ends in: ${awaited}.send(...); await waitFor(${awaited}, (s) => s.state === "<that state>") (import { waitFor } from "@reactre/state/utils")`,
      );
    // M52: a listener that throws makes the sender's send throw.
    const listened = node.type === "CallExpression" ? actorCall(node, "subscribe") : null;
    if (listened !== null && node.type === "CallExpression")
      for (const a of node.arguments)
        if (isFunction(a) && a.body !== null)
          for (const t of throwsIn(a.body))
            report(
              t,
              `a listener that throws makes send throw: the other listeners still run, then ${listened}.send(...) throws this error to whoever sent the event, after the transition is made. Handle the failure in the listener: try { ... } catch (error) { console.error(error) }`,
            );
    // M308: a switch over a snapshot's state with a default treats every other state alike.
    if (node.type === "SwitchStatement" && onState(node.discriminant)) {
      const fallback = node.cases.find((c) => c.test === null);
      const subject = src(node.discriminant);
      if (fallback !== undefined && !/\bnever\b/.test(src(fallback)))
        report(
          fallback,
          `a default in a switch over ${subject} treats every other state alike, and a state added later lands in it unseen: write a case for each state, and make the default a check that none is left, default: { const left: never = ${subject}; throw new Error(\`unhandled state \${left}\`); }`,
        );
    }
    return true;
  });

  /** The node reads a snapshot's data (`(s.data as any).body`, `actor.snapshot().data.body!`). */
  const onSnapshotData = (node: Node): boolean => {
    let data = false;
    for (let n = node; ;) {
      if (n.type === "TSAsExpression" || n.type === "TSTypeAssertion" || n.type === "TSNonNullExpression")
        n = n.expression;
      else if (n.type === "CallExpression") n = n.callee;
      else if (n.type !== "MemberExpression") return data && n.type === "Identifier" && tracked.has(n.name);
      else {
        if (!n.computed && n.property.type === "Identifier" && n.property.name === "data") data = true;
        n = n.object;
      }
    }
  };
  /** The name of the @reactre/state function called on a line, if any. */
  const onUseLine = (line: number): string | null => uses.find((u) => u.from <= line && line <= u.to)?.name ?? null;
  walk(program, (node) => {
    const kind = hides(node, src);
    if (kind === null) return true;
    // Reported in a transition already. Each report skips what it wraps: `x as unknown as T` is one.
    if (hidden.has(node.start)) return false;
    // `createActor(machine as any)`: the call's `this` refuses the `any`, and names the fix.
    if (
      anyChecked.has(node) &&
      (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") &&
      node.typeAnnotation.type === "TSAnyKeyword"
    )
      return false;
    const what = kind === "cast" ? "a cast" : "a non-null assertion (!)";
    const name = onUseLine(lineOf(node.start));
    if (name !== null) {
      report(
        node,
        `${what} on a line that calls ${name}(...) hides a broken contract from the type checker: remove it, and fix the type it hides`,
      );
      return false;
    }
    // M578: a cast on a snapshot's state name hides a state the type it's cast to lacks.
    if ((node.type === "TSAsExpression" || node.type === "TSTypeAssertion") && onState(node.expression)) {
      report(
        node,
        `a cast on ${src(node.expression)} hides a state the type checker would check against the list: compare it, ${src(node.expression)} === "<state>", or test it with isIn(snapshot, "<state>")`,
      );
      return false;
    }
    if (!onSnapshotData(node)) return true;
    report(
      node,
      `${what} on a snapshot's data hides a field that isn't there: narrow the snapshot by its state instead, if (snapshot.state === "loaded") snapshot.data.body`,
    );
    return false;
  });
  // In a file without machines (whose suppressions are all reported above), one over a use site.
  if (setupLocal === null && stateNamespaces.size === 0 && uses.length > 0)
    for (const c of comments) {
      const directive = SUPPRESSION.exec(c.value)?.[1];
      if (directive === "nocheck")
        report(
          c.start,
          "@ts-nocheck turns off the type checks of every machine this file uses: remove it, and fix the errors it hides",
        );
      // A suppression applies to the line after the comment.
      const name = directive === "ignore" || directive === "expect-error" ? onUseLine(lineOf(c.end) + 1) : null;
      if (name !== null)
        report(
          c.start,
          `a @ts- suppression over ${name}(...) hides a broken contract from the type checker: remove it, and fix the error it hides`,
        );
    }

  // The rules over the code around the machines: use sites, components and tests.
  const around: SiteContext = {
    program,
    src,
    report,
    imports: new Map([...bindings].flatMap(([name, b]) => (b.kind === "import" ? [[name, b] as const] : []))),
    tracked,
  };
  checkUseSites(around);
  checkReact(around);
  checkTesting(around);

  // Each feature's rules over the whole file (a file without machines too).
  for (const f of FEATURES.values()) f.file?.({ file, program, src, report });

  if ((setupLocal === null && stateNamespaces.size === 0) || stateImports.length === 0) {
    fail();
    return null;
  }

  // The type layer is a machine's first check: a JavaScript file, or a tsconfig that turns strict
  // off, has none of it.
  if (lang === "js" || lang === "jsx")
    report(
      stateImport ?? program,
      "a machine in a JavaScript file has no type checks, and its contracts are types: rename the file to .ts (or .tsx)",
    );
  else for (const message of configProblems(file)) report(stateImports[0] ?? program, message);

  // #endregion

  // #region Machines

  /** The machine being compiled: its features' compilers, by feature name. */
  let current: ReadonlyMap<string, FeatureMachine> | null = null;
  /** A shallow-history step appears in the machine being compiled, in an actual move call. */
  let shallow = false;
  /** Where the core's handler being compiled is (null for a feature's handler). */
  let site: Site | null = null;
  /** M607: each event of the machine being compiled whose only field is a boolean: whether every handler so far branches on it. */
  const branchesOn = new Map<string, boolean>();
  /** The events M607 reported, so a shape's second machine doesn't report them again. */
  const setters = new Set<Node>();
  /** The features the machine being compiled has in use (setup's `use`). */
  let using: ReadonlySet<string> = new Set();
  /** The version of the machine being compiled: each `to` puts it in the snapshot it makes. */
  let version = 0;
  // What the file's machines use, for the imports.
  const runtime = new Set<"tasks" | "lean" | "run" | "nested-run" | "none">();
  // The features' imports for code only some machines need (`Emitted.imports`), each once.
  const featureImports = new Set<string>();
  let usesShape = false;
  /** The file's flat machines, by name: their events, and each non-final state's handled ones. */
  const handled = new Map<
    string,
    { readonly events: readonly string[]; readonly handles: ReadonlyMap<string, ReadonlySet<string>> }
  >();
  walk(program, (node, parent, key) => {
    if (node.type === "Identifier" && shapes.has(node.name)) {
      // A shape's only runtime use is `shape.machine({...})`; its declaration, and type positions, don't count.
      const isDeclaration = parent?.type === "VariableDeclarator" && key === "id";
      const isExportName = parent?.type === "ExportSpecifier";
      // A name, not the shape: a property's key (`children: { upload: ... }`) or a member's name.
      const isName =
        (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand) ||
        (parent?.type === "MemberExpression" && key === "property" && !parent.computed);
      if (isName) return true;
      const isMachineCall =
        parent?.type === "MemberExpression" &&
        key === "object" &&
        !parent.computed &&
        parent.property.type === "Identifier" &&
        parent.property.name === "machine";
      if (!isDeclaration && !isExportName && !isMachineCall)
        report(node, `${node.name} is a shape: its only use is ${node.name}.machine({ ... }), in this file`);
      return true;
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "Identifier" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "machine"
    ) {
      const shape = shapes.get(node.callee.object.name);
      const named = parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : null;
      if (shape !== undefined) compileMachine(node, shape, named);
    }
    return true;
  });

  // M49: a send whose result is dropped, of an event some state doesn't handle, to an actor of a
  // machine in this file: there it does nothing, and nothing says so.
  walk(program, (node) => {
    if (node.type !== "ExpressionStatement" || afterStop.has(node.expression)) return true;
    const call = node.expression;
    const actor = actorCall(call, "send");
    const machine = actor === null ? undefined : handled.get(runs.get(actor) ?? "");
    const event = call.type === "CallExpression" ? call.arguments[0] : undefined;
    const type =
      event?.type === "ObjectExpression"
        ? event.properties.find((p) => p.type === "Property" && keyName(p) === "type")
        : undefined;
    const name = type?.type === "Property" ? stringValue(type.value) : null;
    // An event the machine doesn't take, or that no state handles, is the type checker's.
    if (machine === undefined || name === null || !machine.events.includes(name)) return true;
    const where = [...machine.handles].filter(([, on]) => on.has(name)).map(([state]) => state);
    const not = [...machine.handles.keys()].filter((state) => !where.includes(state));
    if (where.length > 0 && not.length > 0)
      report(
        call,
        `${actor}.send({ type: "${name}" }) does nothing in ${not.map((s) => `"${s}"`).join(", ")}, which ${not.length === 1 ? "doesn't" : "don't"} handle it, and its result is dropped, so nothing says so: read it, const result = ${actor}.send(...); if (!result.ok) ... (result.reason is "unhandled"), or send it only where it is handled, if (${actor}.snapshot().state === "${where[0]}") ${actor}.send(...)`,
      );
    return true;
  });

  /** An object literal, or a problem saying it must be one so it can be compiled. */
  function literal(value: Expression, what: string): ObjectExpression | null {
    if (value.type === "ObjectExpression") return value;
    report(value, `${what} is an object literal written in place, so the compiler can compile it`);
    return null;
  }

  function compileMachine(call: CallExpression, shape: Shape, named: string | null): void {
    const arg = call.arguments[0];
    if (arg === undefined || arg.type === "SpreadElement" || call.arguments.length !== 1) return; // a type error
    const config = literal(arg, "machine's argument");
    if (config === null) return;
    const props = propertiesOf(config, report, "machine's argument");
    const out: string[] = [];
    // Each feature's compiler for this machine, whether or not it is in use (see ./feature.ts).
    const machines = new Map<string, FeatureMachine>();
    using = new Set(shape.features.flatMap((f) => (f.local === null ? [] : [f.name])));
    shallow = false;
    version = shape.version;
    const inUse = using;
    for (const f of shape.features)
      machines.set(
        f.name,
        f.shape.machine?.({
          local: f.local,
          states: shape.states,
          uses: (feature) => inUse.has(feature),
          dev: options.dev === true,
          report,
          src,
          handler,
          literal,
          properties: (object, what) => propertiesOf(object, report, what),
        }) ?? {},
      );
    current = machines;

    /** A handler of the core's, compiled where it is (its node, its event, and the node's task and timers). */
    const at = (
      value: Expression,
      kind: string,
      state: string | null,
      event: string | null = null,
      node: Pick<Site, "task" | "timed" | "reads"> = { task: false, timed: false, reads: new Set() },
    ): string | null => {
      site = { shape, state, event, ...node };
      const code = handler(value, kind);
      site = null;
      return code;
    };
    branchesOn.clear();
    const start = props.get("start");
    const startCode = start === undefined ? "() => null" : (at(start.value, "start", null) ?? "() => null");

    const on: string[] = [];
    const finals: string[] = [];
    const tasks: string[] = [];
    const timers: string[] = [];
    // Each state's handlers, by event, as written: for the duplication lint.
    const written = new Map<string, ReadonlyMap<string, ObjectProperty>>();
    // Each state's config but the final ones', for the mirrored-states lint (./mirror.ts).
    const configs = new Map<string, ObjectProperty>();
    const statesValue = props.get("states")?.value;
    const states = statesValue === undefined ? null : literal(statesValue, "states");
    const nodes = states === null ? new Map<string, ObjectProperty>() : propertiesOf(states, report, "states");
    // The events each state handles, for the sends of this file (M49): kept for a flat machine with
    // no feature in use, whose handlers are all written in place, where `on` is all there is.
    let plain = using.size === 0 && states !== null;
    const handles = new Map<string, ReadonlySet<string>>();
    for (const [name, p] of nodes) {
      const state = literal(p.value, `state "${name}"`);
      if (state === null) continue;
      const parts = propertiesOf(state, report, `state "${name}"`);
      const key = JSON.stringify(name);
      // Keys the shape doesn't take (`entry`, a misspelled event, a timer like "5 sec") are the
      // type checker's to report: they compile to nothing here.
      if (parts.has("final")) {
        finals.push(`${key}: 1`);
        // wave1-effects: a final state's `entry` (effects's) runs when the machine ends in it; wave2:
        // its `tags`, `meta` and `description` (tags's) label it as on any node.
        for (const k of ["entry", "tags", "meta", "description"]) {
          const part = parts.get(k);
          if (part !== undefined)
            for (const owner of KEYS.get(k) ?? []) machines.get(owner)?.key?.(name, k, part.value);
        }
        continue;
      }
      configs.set(name, p);
      const handlers: string[] = [];
      const onPart = parts.get("on");
      const onObject = onPart === undefined ? null : literal(onPart.value, "on");
      const by = new Map<string, ObjectProperty>();
      const taskPart = parts.get("task");
      const task = taskPart === undefined ? null : literal(taskPart.value, "task");
      const t = task === null ? null : propertiesOf(task, report, "task");
      const run = t?.get("run");
      const here = {
        task: t !== null,
        timed: t !== null || parts.has("after") || parts.has("timeout"),
        reads: run === undefined ? new Set<string>() : readsOf(run.value),
      };
      for (const [event, h] of onObject === null ? [] : propertiesOf(onObject, report, "on")) {
        by.set(event, h);
        const code = at(h.value, "on", name, event, here);
        if (code !== null) handlers.push(`${JSON.stringify(event)}: ${code}`);
      }
      written.set(name, by);
      handles.set(name, new Set(by.keys()));
      if (!shape.states.includes(name) || (onPart !== undefined && onObject === null)) plain = false;
      // Every leaf is in `o` (so its name is known); a parent only when it has handlers.
      if (shape.states.includes(name) || handlers.length > 0) on.push(`${key}: { ${handlers.join(", ")} }`);

      if (t !== null) {
        const error = t.get("error");
        const runCode = run === undefined ? null : at(run.value, "run", name, null, here);
        const errorCode = error === undefined ? null : at(error.value, "error", name, null, here);
        if (runCode !== null && errorCode !== null) tasks.push(`${key}: [${runCode}, ${errorCode}]`);
      }

      const afterPart = parts.get("after");
      const after = afterPart === undefined ? null : literal(afterPart.value, "after");
      if (after !== null) {
        const list: string[] = [];
        /** Each time's first key: M481, two keys of one time are one timer. */
        const times = new Map<number, string>();
        // A bare number is the type checker's to report (it names the unit): it compiles to nothing.
        // The type takes the grammar DURATION reads (digits, an optional fraction, a unit), so a key
        // it can't read is a type error too, and a key that isn't written as one is reported above.
        for (const [duration, h] of propertiesOf(after, report, "after", true)) {
          const m = DURATION.exec(duration);
          const unit = UNIT[m?.[2] ?? ""];
          if (m === null || unit === undefined) continue; // the type checker reports the duration
          const ms = Number(m[1]) * unit;
          const same = times.get(ms);
          if (same !== undefined)
            report(
              h.key,
              `the timers "${same}" and "${duration}" are one time (${ms} ms), so one of them never runs: keep one, and put both steps in it`,
            );
          times.set(ms, same ?? duration);
          const code = at(h.value, "after", name, null, here);
          if (code !== null) list.push(`[${ms}, ${code}]`);
        }
        // A state whose `after` keys are all delays's or timeout's (they compile to `l`) has no
        // ordinary timer: an empty `a` entry would make the machine look timed and ship `__tasks`
        // for nothing.
        if (list.length > 0) timers.push(`${key}: [${list.join(", ")}]`);
      }

      // The features' keys (`children`, a parallel node's `done`). A key no feature has, or whose
      // feature is off, is the type checker's to report: it compiles to nothing.
      for (const [k, part] of parts)
        for (const owner of KEYS.get(k) ?? []) machines.get(owner)?.key?.(name, k, part.value);
    }

    if (plain && named !== null) handled.set(named, { events: shape.events, handles });
    checkDuplicates(written, shape);
    // M607: an event whose one boolean every handler branches on is two events.
    for (const [event, all] of branchesOn) {
      const entry = shape.eventNodes.get(event);
      const field = [...(shape.payloads.get(event)?.keys() ?? [])][0];
      if (!all || entry === undefined || setters.has(entry)) continue;
      setters.add(entry);
      report(
        entry,
        `${event} carries one boolean, ${field}, and every handler branches on it to pick its step: the caller picks the transition. Make it two events, one for each value (as open and close), each with its own handler`,
      );
    }
    // A machine the codemod converted keeps XState's states, so it replays the same: the codemod
    // notes mirrored ones in a TODO that is the fix, written right above the first, and that note
    // is taken. Any other comment isn't.
    for (const m of mirrored(configs, shape.contracts, new Set([...shape.states, ...nodes.keys()]), src)) {
      const note = `${MIRROR_TODO}${m.message}`;
      const noted = comments.some((c) => c.value.trim() === note && source.slice(c.end, m.at.start).trim() === "");
      if (!noted) report(m.at, m.message);
    }

    // What the features in use add, in the feature table's order.
    const emitted = shape.features.flatMap((f) => {
      const machine = machines.get(f.name);
      const shallowMachine = machine as FeatureMachine & { shallow?: boolean };
      if (shallowMachine !== undefined) shallowMachine.shallow = shallow;
      const e = f.local === null ? undefined : machine?.emit?.();
      return e === undefined ? [] : [{ name: f.name, e }];
    });
    for (const f of shape.features) if (f.local !== null) machines.get(f.name)?.done?.();
    // wave1-statecharts: the features' events (route's) join setup's.
    const external = [...shape.events, ...emitted.flatMap(({ e }) => e.events ?? [])]
      .map((e) => `${JSON.stringify(e)}: 1`)
      .join(", ");
    out.push(
      `v: ${shape.version}`,
      `e: { ${external} }`,
      `i: ${emitted.reduce((code, { e }) => e.start?.(code) ?? code, startCode)}`,
      `o: { ${on.join(", ")} }`,
    );
    if (finals.length > 0) out.push(`f: { ${finals.join(", ")} }`);
    if (tasks.length > 0) out.push(`t: { ${tasks.join(", ")} }`);
    if (timers.length > 0) out.push(`a: { ${timers.join(", ")} }`);
    // wave1-statecharts: the node graph, composed in table order like the step.
    const graph = emitted.reduce<string | null>((inner, { e }) => e.graph?.(inner) ?? inner, null);
    if (graph !== null) out.push(`g: ${graph}`);
    for (const { e } of emitted) out.push(...(e.fields ?? []));
    const step = emitted.reduce<string | null>((inner, { e }) => e.step?.(inner) ?? inner, null);
    if (step !== null) out.push(`y: ${step}`);
    const markers = emitted.filter(({ e }) => e.marker === true).map(({ name }) => `${JSON.stringify(name)}: 1`);
    if (markers.length > 0) out.push(`u: { ${markers.join(", ")} }`);

    // The lifecycle: none for plain transitions; the lean one for a flat machine's ordinary tasks
    // and timers; the small one where there are only these plus late timers or a hierarchy. Every
    // feature runner, effect dispatcher, persistence, reentry and lifecycle wrap needs the general
    // lifecycle's work registry, restore, actor options or reentry handling. An `a` entry is only
    // emitted for a state with an ordinary timer (above), so `timers` is exactly the ordinary ones.
    const timed = tasks.length > 0 || timers.length > 0;
    const used = new Set(emitted.map(({ name }) => name));
    // The small general lifecycle (./src/run-nested.ts) leaves out the work registry's `saved` and
    // `options` and the effect dispatcher. So it is safe only when nothing needs them: no parallel
    // node (its graph), no children (their runner reads `options` and `saved`), no persist
    // (`always`: it reads `saved`), no effects (their dispatcher and wrap), and no inspect or spawn
    // (their wraps). Delays's and timeout's own runners read only `current`, `go` and `now`, which
    // it provides, and reenter's `m.re` check is there, so a machine whose only runners are `l`'s
    // timers, or that only re-enters a leaf, gets it too.
    const nestedOnly =
      !used.has("parallel") &&
      !used.has("children") &&
      !used.has("persist") &&
      emitted.every(({ e }) => e.lifecycle !== "always" && e.wrap === undefined && e.effects === undefined);
    const taskRunner = emitted.find(({ e }) => e.tasks !== undefined)?.e.tasks;
    const runners = [
      ...(timed ? [taskRunner ?? "__reactreStateTasks"] : []),
      ...emitted.flatMap(({ e }) => e.runners ?? []),
    ];
    const maps = emitted.flatMap(({ e }) => e.effects ?? []);
    const dispatch = emitted.find(({ e }) => e.dispatch !== undefined)?.e.dispatch;
    const always = emitted.some(({ e }) => e.lifecycle === "always");
    const general =
      always ||
      maps.length > 0 ||
      runners.length > (timed ? 1 : 0) ||
      taskRunner !== undefined ||
      emitted.some(({ e }) => e.lifecycle === "general");
    if (timed && taskRunner === undefined) runtime.add(general ? "tasks" : "lean");
    let lifecycle: string | null = null;
    if (general && (runners.length > 0 || always || maps.length > 0)) {
      runtime.add(nestedOnly ? "nested-run" : "run");
      const effects = maps.length > 0 && dispatch !== undefined ? `, ${dispatch(maps)}` : "";
      lifecycle = `__reactreState${nestedOnly ? "RunNested" : "Run"}([${runners.join(", ")}]${effects})`;
    } else if (timed) lifecycle = "__reactreStateLean";
    // wave1-actors: the features' wraps of the lifecycle (inspect's), in table order.
    lifecycle = emitted.reduce<string | null>((inner, { e }) => e.wrap?.(inner) ?? inner, lifecycle);
    if (lifecycle !== null) out.push(`r: ${lifecycle}`);
    if (options.dev === true) out.push("d: __reactreStateFreeze");
    for (const { e } of emitted) for (const i of e.imports ?? []) featureImports.add(i);
    edits.push({ start: call.start, end: call.end, text: `/* @__PURE__ */ ({ ${out.join(", ")} })` });
    current = null;
    using = new Set();
  }

  /**
   * Check one handler and return its compiled code: positional parameters, and each `to(s, d)`
   * as `[s, d]`. A task's `run` may do anything (it is the effect); the others must be pure.
   */
  /**
   * The duplication lint (X180): a handler written the same on every leaf under a parent, three or
   * more, belongs on the parent. Sibling states alike in their data and every handler (X178, X179)
   * are ./mirror.ts's.
   */
  function checkDuplicates(written: ReadonlyMap<string, ReadonlyMap<string, ObjectProperty>>, shape: Shape): void {
    const text = (p: ObjectProperty | undefined): string | undefined => p && src(p.value).replace(/\s+/g, " ");
    const siblings = new Map<string, ReadonlyMap<string, ObjectProperty>[]>();
    for (const leaf of shape.states) {
      const on = written.get(leaf);
      const parent = leaf.slice(0, Math.max(0, leaf.lastIndexOf(".")));
      if (on !== undefined && parent !== "") siblings.set(parent, [...(siblings.get(parent) ?? []), on]);
    }
    for (const [parent, all] of siblings) {
      const [first] = all;
      if (first !== undefined && all.length >= 3)
        for (const [event, p] of first)
          if (all.every((on) => text(on.get(event)) === text(p)))
            report(
              p,
              `every state under "${parent}" handles ${event} the same way: write it once, on the parent, "${parent}": { on: { ${event}: ... } }, and remove it from its ${all.length} states`,
            );
    }
  }

  function handler(value: Expression, kind: string): string | null {
    if (!isFunction(value)) {
      // A string target or `{ target, guard }` is a type error already; a reference to a function
      // elsewhere type-checks, but can't be compiled or checked for purity.
      if (value.type !== "Literal" && value.type !== "ObjectExpression" && value.type !== "ArrayExpression")
        report(
          value,
          `${kind === "run" ? "run" : "a handler"} is a function written in place, so the compiler can check it`,
        );
      return null;
    }
    const names = new Map<string, string>(); // "data" | "event" | ... -> local name
    // `to` and `keep` (a stay that leaves the state's task and timers running: the same step), by
    // local name. The type checker tells which one a move needs; the compiler compiles both alike.
    const toLocals = new Map<string, "to" | "keep">();
    // The features' moves (`back`) and values (`enq`) the handler destructures: local name -> its name.
    const moveLocals = new Map<string, string>();
    const valueLocals = new Map<string, string>();
    const allowed = KINDS.get(kind)?.params ?? [];
    const moves = KINDS.get(kind)?.moves === true;
    const param = value.params[0];
    if (param !== undefined) {
      if (param.type !== "ObjectPattern")
        report(param, `destructure the argument: ({ ${allowed.join(", ")}${moves ? ", to" : ""} })`);
      else
        for (const p of param.properties) {
          if (p.type === "RestElement") {
            report(p, "a rest element: name the parts you use");
            continue;
          }
          const name = keyName(p);
          const known =
            name !== null &&
            (allowed.includes(name) || name === "to" || name === "keep" || MOVES.has(name) || VALUES.has(name));
          if (name === null || !known) continue; // a type error
          if (p.value.type !== "Identifier") {
            report(p.value, `bind ${name} to a name (destructure it in the body)`);
            continue;
          }
          if (name === "to" || name === "keep") toLocals.set(p.value.name, name);
          else if (MOVES.has(name)) moveLocals.set(p.value.name, name);
          else if (VALUES.has(name)) valueLocals.set(p.value.name, name);
          else names.set(name, p.value.name);
        }
    }
    /** A call of `to`, `keep` or a feature's move, which compiles to a step. */
    const isMove = (node: Node): node is CallExpression =>
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      (toLocals.has(node.callee.name) || moveLocals.has(node.callee.name));
    const given = new Set([...names.values()]);
    const body = value.body;
    if (body === null) return null;

    // Locals the handler declares may be assigned; nothing else may.
    const local = localsOf(value);
    for (const v of valueLocals.keys()) local.add(v);

    const inner: Edit[] = [];
    const pure = kind !== "run";
    const fn = value;
    const keys: Keys = {
      data: names.get("data") ?? null,
      event: names.get("event") ?? null,
      local,
      built: (name) => builtIn(fn, name, isMove),
    };
    if (kind === "run") checkRun(value, names.get("signal") ?? null, report, src, seen, promises, { file, program });

    /** What the features' hooks get inside this handler. */
    const ctx: HandlerContext = {
      isMove,
      compileMove: (call) => compileMove(call),
      step: (state, data) => step(state, data),
      checkKeys: (v, what) => checkKeys(v, keys, what),
      report,
      properties: (object, what) => propertiesOf(object, report, what),
    };

    /**
     * `to(state, data)`'s step: the snapshot itself, `{ state, data, version }`, so a step
     * allocates nothing but the snapshot (no tuple to copy into one). An object literal in place,
     * not a helper's call: the call would sit past JSC's inlining depth in a send (send, step,
     * flat step, handler), and gzip takes the repeated keys for about nothing.
     */
    const step = (state: string, data: string): string =>
      `({ state: ${JSON.stringify(state)}, data: ${data}, version: ${version} })`;

    /**
     * `to(state, data)` becomes its step (above); a feature's move (`back(parent, to(...))`), and a
     * `to` whose target a feature compiles (a parallel node's regions), become what it says.
     */
    const compileMove = (call: CallExpression): string => {
      const feature = call.callee.type === "Identifier" ? moveLocals.get(call.callee.name) : undefined;
      if (
        feature === "back" &&
        call.arguments.length > 2 &&
        call.arguments[2]?.type === "ObjectExpression" &&
        call.arguments[2].properties.length > 0
      )
        shallow = true;
      if (feature !== undefined) {
        const compiled = current?.get(MOVES.get(feature) ?? "")?.move?.(call, ctx);
        return compiled ?? "null";
      }
      const [stateArg, dataArg] = call.arguments;
      const resolved =
        stateArg === undefined || stateArg.type === "SpreadElement" ? undefined : staticValue(file, program, stateArg);
      const state = typeof resolved === "string" ? resolved : null;
      if (state === null) {
        const verb = toLocals.get(call.callee.type === "Identifier" ? call.callee.name : "") ?? "to";
        report(
          stateArg ?? call,
          `${verb}'s first argument must resolve statically from literals and module-level const bindings: ${verb}("loading", ...)`,
        );
        return "null";
      }
      // No data (or `{}`): the one frozen empty object every such step shares, so none allocates it.
      if (dataArg === undefined || (dataArg.type === "ObjectExpression" && dataArg.properties.length === 0)) {
        runtime.add("none");
        return step(state, "__reactreStateNone");
      }
      if (dataArg.type === "SpreadElement") return "null"; // a type error: a spread argument isn't a tuple
      for (const m of current?.values() ?? []) {
        const compiled = m.to?.(state, dataArg, ctx);
        if (compiled !== undefined && compiled !== null) return compiled;
      }
      // A `to(...)` inside the data is a region's step, which only a parallel node compiles. If no
      // feature claimed this `to`, the data still holds raw `to(...)` calls: the output would refer
      // to a `to` that isn't there. Fail closed (the handler declines) rather than emit them. The
      // type checker already reports this (a region's `to` takes one argument, and the node's data
      // has no such field), so the compiler doesn't repeat it: it only refuses to write broken code.
      if (dataArg.type === "ObjectExpression") {
        let nested = false;
        walk(dataArg, (node) => {
          if (nested) return false;
          if (node.type === "CallExpression" && isMove(node)) nested = true;
          return !nested;
        });
        if (nested) return "null";
      }
      checkKeys(dataArg, keys, `state "${state}"'s data`);
      checkSorts(dataArg, at?.shape.data.get(state));
      return step(state, src(dataArg));
    };

    const at = site;
    const dataLocal = names.get("data") ?? null;
    const eventLocal = names.get("event") ?? null;
    const scope: Scope = {
      local,
      given,
      borrowed: new Set(),
      moves: new Set([...moveLocals.keys(), ...toLocals.keys()]),
      report,
      fields: (node) => {
        if (at === null || node.type !== "MemberExpression" || node.computed || node.object.type !== "Identifier")
          return null;
        const field = node.property.type === "Identifier" ? node.property.name : "";
        const contract =
          node.object.name === eventLocal && at.event !== null
            ? at.shape.payloads.get(at.event)
            : node.object.name === dataLocal && at.state !== null
              ? at.shape.data.get(at.state)
              : undefined;
        return contract?.get(field) ?? null;
      },
      event: eventLocal,
      handler: true,
      arrays: arrayLocals(value),
    };
    const visitPure = pureVisitor(scope);
    /** Purity, over the handler: a move's arguments are checked, not its callee. */
    const visit = (node: Node, parent: Node | null, key: string): boolean => {
      // wave1-effects: a function handed to a feature's value (`enq(() => ...)`, `enq.effect(...)`)
      // is the effect: it runs after the transition, so, like a task's `run`, it may do anything. The
      // rest of the call is checked. A value used inside it would record outside the transition.
      if (node.type === "CallExpression" && valueLocals.has(rootName(node.callee) ?? "")) {
        walk(node.callee, visit, node, "callee");
        for (const a of node.arguments)
          if (isFunction(a)) walk(a, effectVisitor);
          // The effect given by name (`enq(track, data)`): it runs after the transition, like one in place.
          else if (!(a.type === "Identifier" && bindings.get(a.name)?.kind === "function"))
            walk(a, visit, node, "arguments");
        return false;
      }
      if (isMove(node)) {
        for (const a of node.arguments) walk(a, visit, node, "arguments");
        return false;
      }
      return visitPure(node, parent, key);
    };
    /** Inside an effect: anything goes, but recording (enq) or sending (it is data the step returns). */
    const effectVisitor = (n: Node): boolean => {
      if (n.type === "Identifier" && valueLocals.has(n.name))
        report(
          n,
          `${n.name} inside an effect: the effect runs after the transition, when ${n.name} records nothing. Call ${n.name} in the handler itself, or send to the actor from the effect`,
        );
      if (
        n.type === "CallExpression" &&
        n.callee.type === "MemberExpression" &&
        n.callee.property.type === "Identifier" &&
        n.callee.property.name === "send"
      )
        report(
          n,
          `${src(n.callee)}(...) in an effect sends from outside the step: record it instead, enq.sendTo(actor, event) (or enq.raise(event) to this machine), so the step returns it as data and a test sees it`,
        );
      return true;
    };
    if (pure) walk(body, visit);
    if (moves && valueLocals.size > 0) checkDeclined(body, valueLocals, isMove);
    checkThis(body);
    if (moves) {
      const verb = (call: CallExpression): string =>
        toLocals.get(src(call.callee)) ?? moveLocals.get(src(call.callee)) ?? "to";
      checkSteps({
        body,
        kind,
        at,
        isMove,
        verb,
        data: dataLocal,
        event: eventLocal,
        error: names.get("error") ?? null,
        records: valueLocals.size > 0,
      });
    }
    walk(body, (node, parent, key) => {
      // A call of a method of a feature's value (`enq.cancel("bell")`): the feature may check it.
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.property.type === "Identifier"
      ) {
        const owner = valueLocals.get(node.callee.object.name);
        if (owner !== undefined) current?.get(VALUES.get(owner) ?? "")?.call?.(node.callee.property.name, node);
      }
      if (isMove(node)) {
        inner.push({ start: node.start, end: node.end, text: compileMove(node) });
        return false;
      }
      // A feature's value (`enq`): each reference becomes what the feature says (its recorder).
      const feature = node.type === "Identifier" ? valueLocals.get(node.name) : undefined;
      const isName =
        (parent?.type === "MemberExpression" && key === "property" && !parent.computed) ||
        (parent?.type === "Property" && key === "key" && !parent.computed);
      if (node.type === "Identifier" && feature !== undefined && !isName) {
        const text = current?.get(VALUES.get(feature) ?? "")?.value?.(feature);
        if (text !== undefined) inner.push({ start: node.start, end: node.end, text });
      }
      return true;
    });

    // Positional parameters in place of the destructured object.
    const positional = allowed.map((n, i) => names.get(n) ?? `__${i}`);
    while (positional.length > 0 && /^__\d$/.test(positional[positional.length - 1] ?? "")) positional.pop();
    if (param !== undefined)
      inner.push({
        start: param.start,
        end: value.params[value.params.length - 1]?.end ?? param.end,
        text: positional.join(", "),
      });
    const code = apply(source, value.start, value.end, inner);
    // A step that reaches the actor outside a step: the features in use may wrap it (validate).
    const outside = KINDS.get(kind)?.outside;
    if (outside === undefined) return code;
    let wrapped = code;
    for (const [name, m] of current ?? [])
      if (using.has(name)) wrapped = m.outside?.(wrapped, outside, allowed.indexOf("state")) ?? wrapped;
    return wrapped;
  }

  /**
   * An effect recorded before the handler may decline (`enq.log(...)`, then `return null`): a
   * declined step drops what it recorded, so the effect never runs.
   */
  function checkDeclined(body: Node, values: ReadonlyMap<string, string>, isMove: (node: Node) => boolean): void {
    // A handler that never moves only declines (a leaf that leaves the event to its parent): what
    // it records is dropped every time, which a test of that may want. One that may do either is
    // the mistake: the effect looks like it runs on the declined path too.
    let moves = false;
    walk(body, (n) => {
      if (isMove(n)) moves = true;
      return !moves;
    });
    if (!moves) return;
    /** The first of `list` that records an effect (`enq(...)`, `enq.log(...)`). */
    const recording = (list: readonly Node[]): CallExpression | undefined =>
      list.find((n): n is CallExpression => n.type === "CallExpression" && values.has(rootName(n.callee) ?? ""));
    /** The value may be null: `null`, or a condition with a null branch. */
    const declines = (n: Node): boolean =>
      (n.type === "Literal" && n.value === null) ||
      (n.type === "ConditionalExpression" && (declines(n.consequent) || declines(n.alternate)));
    const say = (at: CallExpression): void =>
      report(
        at,
        `${src(at.callee)} records an effect before the handler may return null: a declined step drops what it recorded, so the effect never runs. Record it only on the path that moves (beside the to(...) it returns)`,
      );
    // An arrow's sequence: `(enq.log("x"), ok ? to("a") : null)`.
    if (body.type === "SequenceExpression") {
      const last = body.expressions[body.expressions.length - 1];
      const at = recording(body.expressions.slice(0, -1));
      if (at !== undefined && last !== undefined && declines(last)) say(at);
      return;
    }
    if (body.type !== "BlockStatement") return;
    // A block: a statement that records, and a later return that may be null.
    body.body.forEach((s, i) => {
      if (s.type !== "ExpressionStatement") return;
      const at = recording(s.expression.type === "SequenceExpression" ? s.expression.expressions : [s.expression]);
      if (at === undefined) return;
      let declined = false;
      for (const later of body.body.slice(i + 1))
        walk(later, (n) => {
          if (isFunction(n)) return false;
          if (n.type === "ReturnStatement" && n.argument !== null && declines(n.argument)) declined = true;
          return !declined;
        });
      if (declined) say(at);
    });
  }

  /** M490: sort() with no compare function orders numbers as text, [1, 10, 2]. */
  function checkSorts(data: Node, contract: ReadonlyMap<string, Field> | undefined): void {
    if (data.type !== "ObjectExpression" || contract === undefined) return;
    for (const p of data.properties) {
      const field = p.type === "Property" ? contract.get(keyName(p) ?? "") : undefined;
      const value = p.type === "Property" ? p.value : null;
      if (
        field !== undefined &&
        admits(field).numbers &&
        value?.type === "CallExpression" &&
        value.arguments.length === 0 &&
        value.callee.type === "MemberExpression" &&
        value.callee.property.type === "Identifier" &&
        (value.callee.property.name === "sort" || value.callee.property.name === "toSorted")
      )
        report(
          value,
          `${value.callee.property.name}() orders numbers as text ([1, 10, 2]): ${value.callee.property.name}((a, b) => a - b)`,
        );
    }
  }

  /** M487: `this` in a handler (an effect and a task's run too) is whatever object called it, shared by every actor. */
  function checkThis(body: Node): void {
    walk(body, (n) => {
      if (n.type === "FunctionExpression" || n.type === "FunctionDeclaration" || n.type === "ClassBody") return false;
      if (n.type === "ThisExpression")
        report(
          n,
          "this in a handler is whatever object called it, shared by every actor: read data and event (destructure them from the argument) instead",
        );
      return true;
    });
  }

  /** The fields of its data a task's run reads (`*`: all, where it passes the data on whole). */
  function readsOf(run: Expression): Set<string> {
    const out = new Set<string>();
    const param = isFunction(run) ? run.params[0] : undefined;
    const property =
      param?.type === "ObjectPattern"
        ? param.properties.find((p) => p.type === "Property" && keyName(p) === "data")
        : undefined;
    const data = property?.type === "Property" && property.value.type === "Identifier" ? property.value.name : null;
    if (data === null || !isFunction(run) || run.body === null) return out;
    walk(run.body, (n, parent, key) => {
      if (n.type !== "Identifier" || n.name !== data) return true;
      const field =
        parent?.type === "MemberExpression" &&
        key === "object" &&
        !parent.computed &&
        parent.property.type === "Identifier"
          ? parent.property.name
          : "*";
      out.add(field);
      return true;
    });
    return out;
  }

  /** The locals of a function that hold an array: a literal, or an array-making call's result. */
  function arrayLocals(fn: ArrowFunctionExpression | FunctionNode): Set<string> {
    const out = new Set<string>();
    walk(fn, (n) => {
      if (
        n.type === "VariableDeclarator" &&
        n.id.type === "Identifier" &&
        n.init !== null &&
        (n.init.type === "ArrayExpression" || arrayCall(n.init) !== null)
      )
        out.add(n.id.name);
      return true;
    });
    return out;
  }

  /** What the step checks of a handler get: the handler, where it is, and its moves and locals. */
  interface Steps {
    readonly body: Node;
    readonly kind: string;
    readonly at: Site | null;
    readonly isMove: (node: Node) => node is CallExpression;
    readonly verb: (call: CallExpression) => string;
    readonly data: string | null;
    readonly event: string | null;
    readonly error: string | null;
    /** It may record effects (it destructures a feature's value, `enq`): a stay then does something. */
    readonly records: boolean;
  }

  /**
   * The steps a handler that moves builds: M404's dropped step, M413's return from a callback,
   * M405's and M483's stay with the same data, M476's task restarted by its own result, M477's
   * new data the running task didn't start with, M474's Error stringified, and M607's record of a
   * boolean every handler branches on.
   */
  function checkSteps({ body, kind, at, isMove, verb, data, event, error, records }: Steps): void {
    const target = (call: CallExpression): string | null => stringValue(call.arguments[0]);
    /** A part of an object literal that keeps the handler's data as it is: `...data`, or `code: data.code`. */
    const keeps = (p: ObjectExpression["properties"][number]): boolean => {
      if (p.type === "SpreadElement") return p.argument.type === "Identifier" && p.argument.name === data;
      const v = p.value;
      return (
        v.type === "MemberExpression" &&
        !v.computed &&
        v.object.type === "Identifier" &&
        v.object.name === data &&
        v.property.type === "Identifier" &&
        v.property.name === keyName(p)
      );
    };
    /** The data a move passes is the handler's own, unchanged (`data`, `{ ...data }`, `{ code: data.code }`, or none). */
    const unchanged = (arg: Node | undefined): boolean =>
      arg === undefined ||
      (arg.type === "Identifier" && arg.name === data) ||
      (arg.type === "ObjectExpression" && arg.properties.every(keeps));
    const moves: CallExpression[] = [];
    // A block that returns nothing is void, which the type checker refuses: a step dropped there is its.
    const returns = body.type === "BlockStatement" && returned(body).length > 0;
    walk(body, (n) => {
      if (isMove(n)) moves.push(n);
      // M404: a step as a statement is built and dropped; the handler returns something else.
      const dropped = returns && n.type === "ExpressionStatement" ? n.expression : null;
      if (dropped !== null && isMove(dropped))
        report(
          dropped,
          `the step ${verb(dropped)}("${target(dropped) ?? "…"}", …) is built and dropped: return it, return ${verb(dropped)}(…)`,
        );
      // M413: a return in a callback returns to the method that calls it, not from the handler.
      if (
        n.type === "CallExpression" &&
        n.callee.type === "MemberExpression" &&
        !n.callee.computed &&
        n.callee.property.type === "Identifier" &&
        CALLBACKS.has(n.callee.property.name)
      ) {
        const method = n.callee.property.name;
        for (const a of n.arguments)
          if (isFunction(a) && a.body !== null && a.body.type === "BlockStatement")
            for (const r of returned(a.body))
              if (isMove(r) || (method === "forEach" && r.type === "Literal" && r.value === null))
                report(
                  r,
                  `return ${isMove(r) ? `${verb(r)}(…)` : "null"} in ${method}'s callback returns from the callback, not the handler: loop with for…of and return from the handler, or test with some(...) and return after it`,
                );
      }
      // M474: an Error has no own enumerable fields: JSON.stringify gives "{}".
      if (
        kind === "error" &&
        n.type === "CallExpression" &&
        n.callee.type === "MemberExpression" &&
        src(n.callee) === "JSON.stringify" &&
        n.arguments[0]?.type === "Identifier" &&
        n.arguments[0].name === error
      )
        report(
          n,
          `JSON.stringify of an Error is "{}": its message isn't an own enumerable field. Write ${error} instanceof Error ? ${error}.message : String(${error})`,
        );
      return true;
    });
    if (at === null || at.state === null) return;
    const own = moves.filter((m) => target(m) === at.state);
    // The handler's one step, where that is all it does: an arrow's body, or a block's only return.
    const only = body.type === "BlockStatement" ? (body.body.length === 1 ? returned(body)[0] : undefined) : body;
    for (const m of own) {
      const v = verb(m);
      // M405: a "no" that stays with the same data takes the event: decline it, and a parent (or the
      // sender) hears. In a state with a task or timer, keep also says to leave them running (the
      // codemod's form of XState's stay there), so only a state without either.
      if (
        kind === "on" &&
        v === "keep" &&
        !at.timed &&
        !records &&
        unchanged(m.arguments[1]) &&
        moves.length > own.length
      )
        report(
          m,
          `keep("${at.state}", ${m.arguments[1] === undefined ? "" : src(m.arguments[1])}) stays with the data unchanged, so the event counts as handled: send says ok, and a parent never sees it. Decline it with null`,
        );
      // M483: a timer has fired, and keep leaves the state as it is: the timer isn't armed again.
      if (kind === "after" && v === "keep" && m === only && unchanged(m.arguments[1]))
        report(
          m,
          `keep("${at.state}") from its own timer doesn't restart the timer: it has fired, and keep leaves the state as it is. Re-enter the state to arm it again, reenter("${at.state}", ${data ?? "data"}) (use: [reenter])`,
        );
      // M477: keep leaves the running task as it is, with what it started with.
      const arg = m.arguments[1];
      const changed =
        arg?.type === "ObjectExpression"
          ? arg.properties.flatMap((p) => {
              const name = p.type === "Property" ? keyName(p) : null;
              return name !== null && !keeps(p) ? [name] : [];
            })
          : [];
      const read = changed.filter((f) => at.reads.has(f) || at.reads.has("*"));
      if (kind === "on" && v === "keep" && at.task && read.length > 0)
        report(
          m,
          `keep("${at.state}") changes ${read.map((f) => `\`${f}\``).join(", ")}, which the running task read when it started: its result would land on the new data. Restart the task with it, reenter("${at.state}", ...) (use: [reenter])`,
        );
    }
    // M476: the task's own result goes back into its state, which runs the task again, forever.
    if (
      kind === "on" &&
      at.task &&
      at.event !== null &&
      at.shape.internal.includes(at.event) &&
      only !== undefined &&
      isMove(only) &&
      verb(only) === "reenter" &&
      target(only) === at.state
    )
      report(
        only,
        `the result of "${at.state}"'s task, ${at.event}, goes back into "${at.state}", which runs the task again, and again: go to another state with the result`,
      );
    // M607: a handler of an event whose one field is a boolean: does it branch on it?
    const fields = at.event === null ? undefined : at.shape.payloads.get(at.event);
    const [only1] = fields === undefined || fields.size !== 1 ? [] : [...fields];
    const t = only1 === undefined ? null : admits(only1[1]);
    if (kind === "on" && at.event !== null && only1 !== undefined && t?.boolean === true && !t.other && !t.nullish) {
      const tested = (n: Node | undefined): boolean =>
        n !== undefined &&
        (n.type === "UnaryExpression" && n.operator === "!"
          ? tested(n.argument)
          : n.type === "MemberExpression" && rootName(n) === event && src(n) === `${event}.${only1[0]}`);
      const head = body.type === "BlockStatement" ? body.body[0] : body;
      const branches =
        (head?.type === "ConditionalExpression" && tested(head.test)) ||
        (head?.type === "IfStatement" && tested(head.test));
      branchesOn.set(at.event, (branchesOn.get(at.event) ?? true) && branches);
    }
  }

  /**
   * Data whose keys at runtime are the keys its type lists: `data` (built by a checked `to`), or
   * an object literal whose spreads are only of `data`. A type says a value has at least its keys,
   * so a helper's result or another object spread in may carry more, and a snapshot would save them.
   * A local const the handler builds the literal in is that literal (`built`): its type is the
   * literal's, so the type checker sees every key, an extra one too.
   */
  function checkKeys(value: Expression, keys: Keys, what: string): void {
    // `event` as data carries its `type`, which no state's data has: the type checker reports it.
    if (value.type === "Identifier" && (value.name === keys.data || value.name === keys.event)) return;
    const local = value.type === "Identifier" && keys.local.has(value.name);
    const built = local ? keys.built(value.name) : null;
    if (built !== null) {
      checkKeys(built, keys, what);
      return;
    }
    // A module-level object literal: its keys are the type checker's to see, but it is shared.
    if (!local && value.type === "Identifier" && bindings.get(value.name)?.kind === "data") {
      report(
        value,
        `${value.name} is a module-level object: as ${what} it is the same object in every actor that holds it, and frozen with their snapshots in development. Write the data in place: to(state, { ... })`,
      );
      return;
    }
    if (value.type !== "ObjectExpression") {
      report(
        value,
        `write ${what} as an object literal, or pass data: a value built elsewhere can have keys its type doesn't list`,
      );
      return;
    }
    // M406: a getter or setter is code in data: JSON and spreads freeze it into a value, or drop it.
    // (A method's function type isn't JSON: the type checker reports it.)
    for (const p of value.properties)
      if (p.type === "Property" && p.kind !== "init")
        report(
          p,
          `${what} has a ${p.kind === "get" ? "getter" : "setter"}, ${keyName(p) ?? "a field"}, which JSON and spreads freeze into a value or drop: write the value, ${keyName(p) ?? "field"}: ...`,
        );
    for (const p of value.properties)
      if (p.type === "SpreadElement" && p.argument.type === "ObjectExpression")
        checkKeys(p.argument, keys, what); // its keys are written here: the type checker sees them
      else if (
        p.type === "SpreadElement" &&
        // `...event` copies its `type`, which no state's data has: the type checker reports it.
        !(p.argument.type === "Identifier" && (p.argument.name === keys.data || p.argument.name === keys.event))
      )
        report(
          p,
          "spread only data: another object can have keys its type doesn't list, and they would be saved with the snapshot. List the fields",
        );
    checkShared(value);
  }

  /** A module-level object or array as a value in data: every snapshot that holds it shares it. */
  function checkShared(value: Node): void {
    const items =
      value.type === "ObjectExpression"
        ? value.properties.flatMap((p) => (p.type === "Property" ? [p.value] : []))
        : value.type === "ArrayExpression"
          ? value.elements.flatMap((e) => (e === null || e.type === "SpreadElement" ? [] : [e]))
          : [];
    for (const item of items) {
      if (item.type !== "Identifier" || bindings.get(item.name)?.kind !== "data") {
        checkShared(item);
        continue;
      }
      report(
        item,
        `${item.name} is a module-level object: in data it is the same object in every actor that holds it, and frozen with their snapshots in development. Write the value in place, or copy it ([...${item.name}], { ...${item.name} })`,
      );
    }
  }

  // #endregion

  // #region Output

  for (const { call, name, declarations } of shapeCalls) {
    const statement = program.body.find((s) => s.start <= call.start && call.end <= s.end);
    if (statement === undefined) continue;
    // The setup call is gone; what the features keep (schemas, as written) is where it was.
    if (exported.has(name)) {
      usesShape = true;
      if (declarations !== null)
        edits.push({ start: statement.start, end: statement.start, text: `${declarations}\n` });
      edits.push({ start: call.start, end: call.end, text: `__reactreStateShape()` });
    } else edits.push({ start: statement.start, end: statement.end, text: declarations ?? "" });
  }

  // `types<...>()` calls the output still holds: a `states` (or `events`) map hoisted to a module
  // const keeps its `types<...>()` calls, which the setup call's removal doesn't reach. They are
  // dead metadata (the map is only read by the setup call, which is gone), and `types()` throws at
  // runtime, so each is replaced with `{}`: the map keeps its shape, and the import can go.
  if (typesLocal !== null) {
    const removed = shapeCalls.map(({ call }) => {
      const statement = program.body.find((s) => s.start <= call.start && call.end <= s.end);
      return statement === undefined ? null : ([statement.start, statement.end] as const);
    });
    walk(program, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === typesLocal &&
        !removed.some((r) => r !== null && r[0] <= node.start && node.end <= r[1])
      )
        edits.push({ start: node.start, end: node.end, text: "{}" });
      return true;
    });
  }

  // Each state import is emitted separately: a namespace import cannot be wrapped in braces.
  // `S.setup`/`S.types` are compiled away, while other library calls retain the namespace import.
  const imports = stateImports.flatMap((statement) => {
    const kept = statement.specifiers.filter(
      (s) =>
        s.type === "ImportNamespaceSpecifier" ||
        s.type === "ImportDefaultSpecifier" ||
        s.importKind === "type" ||
        (s.type === "ImportSpecifier" && !(s.local.name === setupLocal || s.local.name === typesLocal)),
    );
    return kept.length === 0 ? [] : [kept.map(src).join(", ")];
  });
  const helpers: string[] = [];
  if (usesShape) helpers.push(`import { __shape as __reactreStateShape } from "@reactre/state";`);
  if (runtime.has("none")) helpers.push(`import { __none as __reactreStateNone } from "@reactre/state";`);
  if (runtime.has("run")) helpers.push(`import { __run as __reactreStateRun } from "@reactre/state/run";`);
  if (runtime.has("nested-run"))
    helpers.push(`import { __runNested as __reactreStateRunNested } from "@reactre/state/run-nested";`);
  if (runtime.has("tasks")) helpers.push(`import { __tasks as __reactreStateTasks } from "@reactre/state/tasks";`);
  if (runtime.has("lean")) helpers.push(`import { __lean as __reactreStateLean } from "@reactre/state/tasks";`);
  // The features' hooks come from the app's own imports of them (`nested.g`); code only some
  // machines need comes from the imports they emit.
  helpers.push(...featureImports);
  if (options.dev === true && shapeCalls.length > 0)
    helpers.push(`import { __freeze as __reactreStateFreeze } from "@reactre/state/dev";`);
  // One replacement edit, not a removal plus an insertion at the same offset: `apply` sorts by
  // start, so a removal `[start, end)` would run first and skip an insertion `[start, start)`.
  // The first state import becomes the kept specifiers and the helpers; the rest are removed.
  const emitted = [
    ...imports.map(
      (specifiers) => `import ${specifiers.startsWith("*") ? specifiers : `{ ${specifiers} }`} from "@reactre/state";`,
    ),
    ...helpers,
  ].join("\n");
  const [head, ...rest] = stateImports;
  if (head !== undefined) edits.push({ start: head.start, end: head.end, text: emitted });
  for (const statement of rest) edits.push({ start: statement.start, end: statement.end, text: "" });

  fail();
  return { code: apply(source, 0, source.length, edits) };
}

/** `source[start, end)` with `edits` (within it, not overlapping) applied. */
function apply(source: string, start: number, end: number, edits: readonly Edit[]): string {
  let out = "";
  let at = start;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    out += source.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + source.slice(at, end);
}
