// @reactre/state/serialize (prototype): machine definitions as data (XState's `machineToJSON`,
// `machineConfigToJSON`, `machineFromJSON` and serialization diagnostics; docs: serialization.md).
//
// How it maps. A machine at runtime is the table the compiler wrote: states, events, and handlers
// that are plain functions of `(data, event, state)`. So:
//   - Structure is data: the version, the events callers send, each node's handled events, task,
//     timers (in milliseconds), `final`, parallel regions, history parents, children (each child's
//     own definition, nested), and the features in use, by name (`use`).
//   - A handler that reads nothing (`() => ({ state: "idle", data: {}, version: 0 })`, a constant
//     transition) is data too: `{ "to": "idle", "data": {} }`. Called once to find out: a compiled
//     handler is pure.
//   - Every other handler is code: `{ "@code": "(data, event) => ({ state: \"saving\", ... })",
//     "@args": "table" }`, its compiled text. The text is a pure function of its arguments, except
//     for imports and module constants it may read: those must be in scope where it is evaluated.
//     The compiler's own import, the shared empty data (`__reactreStateNone`), is written back as
//     `{}`. A task's `run` is the effect, and is code that may read anything.
//   - Standard Schemas are runtime values with no JSON form: omitted, and given back with
//     `sources.schemas`. A field this module doesn't know (a feature without a JSON form yet) is
//     omitted. `serializationDiagnostics(machine)` lists each code expression and each omission by
//     JSON Pointer, with what reviving it needs.
//   - `machineToJSON` never throws, and its result is JSON: `JSON.parse(JSON.stringify(json))` is
//     the same definition.
//
// `machineConfigToJSON(config, shape)` is for a config never compiled (`{ start, states }` as a
// model writes it for `machine()`): its handlers keep their written text and take the authoring
// arguments (`"@args": "config"`, `({ data, event, to }) => to(...)`); setup's part (events,
// version) comes from `shape`, since setup's call is compiled away.
//
// `machineFromJSON(json, sources)` builds a table from a definition, as the compiler would:
//   - Code runs only through `sources.evaluate(text)`, which the app supplies (it decides what code
//     it trusts): this module never evaluates text itself. A definition without code needs none.
//   - Features come from `sources.use`, by name (`{ nested, persist }`): the definition's `use`
//     names them, and one missing is StateError S11 naming its import, as for any code the type
//     checker didn't see. The core, nested, parallel, history, children, validate, persist and
//     durable revive; another feature's definition throws S26, naming it.
//   - It checks the definition as it builds (S25, with the JSON path): unknown keys, a target that
//     isn't a state, a malformed transition. A revived machine is `Machine<Shape>`: its states and
//     events are strings, since nothing typed it.

import { type Machine, type Shape, StateError } from "../index.ts";
import type {
  __Child,
  __Compiled,
  __Event,
  __Handler,
  __Lifecycle,
  __Runner,
  __Step,
  __StepHook,
  __Validate,
} from "../internal.ts";
import { __run } from "../run.ts";
import { __lean, __tasks } from "../tasks.ts";

/** A JSON value. */
export type JSONValue = null | boolean | number | string | readonly JSONValue[] | { readonly [key: string]: JSONValue };

/** A function as text: compiled (`"table"`: `(data, event, state)`) or as written (`"config"`: `({ data, event, to })`). */
export interface CodeJSON {
  readonly "@code": string;
  readonly "@args": "table" | "config";
}

/** A transition: to a state with constant data, or code that decides it. */
export type TransitionJSON = { readonly to: string; readonly data: JSONValue } | CodeJSON;

/** A child a node runs: its machine's definition, and its handlers. */
export interface ChildJSON {
  readonly machine: MachineJSON;
  readonly input?: CodeJSON;
  readonly each?: CodeJSON;
  readonly done?: TransitionJSON;
  readonly update?: TransitionJSON;
}

/** A node: a leaf or a parent. */
export interface StateJSON {
  readonly final?: true;
  readonly on?: { readonly [event: string]: TransitionJSON };
  readonly task?: { readonly run: CodeJSON; readonly error: TransitionJSON };
  /** Timers, by milliseconds. */
  readonly after?: { readonly [ms: string]: TransitionJSON };
  /** A parallel node's regions, and where it goes when every region is final. */
  readonly regions?: readonly string[];
  readonly done?: TransitionJSON;
  readonly children?: { readonly [name: string]: ChildJSON };
}

/** A machine's definition, as data. */
export interface MachineJSON {
  readonly version: number;
  /** The events callers may send. */
  readonly events: readonly string[];
  /** The features the machine uses, by name. */
  readonly use?: readonly string[];
  readonly start: TransitionJSON;
  /** Every node (leaves and parents), by name. */
  readonly states: { readonly [node: string]: StateJSON };
  /** The parents `back` goes to. */
  readonly history?: readonly string[];
}

/** What can't be data, by JSON Pointer: code that needs an evaluator, or a value left out. */
export interface Diagnostic {
  readonly path: string;
  readonly kind: "code" | "omitted";
  readonly message: string;
}

// #region Out

/** The core's fields and those this module knows; any other is a feature's without a JSON form. */
const KNOWN = new Set(["v", "e", "i", "o", "f", "t", "a", "p", "n", "h", "c", "s", "x", "y", "z", "u", "r", "g", "d"]);

const pointer = (...parts: readonly string[]): string =>
  parts.map((p) => `/${p.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

/** Plain JSON, or undefined when `value` holds something JSON can't. */
function plain(value: unknown): JSONValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out = value.map(plain);
    return out.every((v) => v !== undefined) ? (out as JSONValue[]) : undefined;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: { [key: string]: JSONValue } = {};
    for (const [k, v] of Object.entries(value)) {
      const j = plain(v);
      if (j === undefined) return undefined;
      out[k] = j;
    }
    return out;
  }
  return undefined;
}

/** validate wraps start (`validate.i(schema, start)`, a `__ValidStart`): the definition is the start it wraps. */
function unwrap(i: __Compiled["i"]): (input: unknown) => unknown {
  const start: unknown = Reflect.get(i, "start");
  // A function under `start` is __ValidStart's: the compiled start, of the same signature.
  return typeof start === "function" ? (start as (input: unknown) => unknown) : i;
}

function walk(m: __Compiled, at: string, notes: Diagnostic[]): MachineJSON {
  const code = (fn: (...args: never[]) => unknown, path: string, what: string): CodeJSON => {
    notes.push({
      path,
      kind: "code",
      message: `${what} is code: machineFromJSON runs it only through sources.evaluate, with the imports and module constants it reads in scope.`,
    });
    // The shared empty data is the compiler's import, which no evaluator has in scope: `{}` is the same data.
    return { "@code": String(fn).replaceAll("__reactreStateNone", "{}"), "@args": "table" };
  };
  // A handler that takes no arguments is a constant: its step is the data.
  const transition = (fn: (...args: never[]) => unknown, path: string, what: string): TransitionJSON => {
    if (fn.length === 0) {
      // A `to`'s step (`__To`): a plain move, unless to a parallel node (its data is the regions' steps).
      const step: unknown = (fn as () => unknown)();
      const state: unknown = isObject(step) ? step["state"] : undefined;
      if (isObject(step) && typeof state === "string" && "version" in step && m.p?.[state] === undefined) {
        const data = plain(step["data"]);
        if (data !== undefined) return { to: state, data };
      }
    }
    return code(fn, path, what);
  };

  const states: { [node: string]: StateJSON } = {};
  const node = (name: string): { -readonly [K in keyof StateJSON]: StateJSON[K] } => {
    const s = (states[name] ??= {});
    return s as { -readonly [K in keyof StateJSON]: StateJSON[K] };
  };
  for (const [name, handlers] of Object.entries(m.o)) {
    const on: { [event: string]: TransitionJSON } = {};
    for (const [event, h] of Object.entries(handlers ?? {}))
      if (h !== undefined)
        on[event] = transition(
          h,
          `${at}${pointer("states", name, "on", event)}`,
          `state "${name}"'s "${event}" handler`,
        );
    const s = node(name);
    if (Object.keys(on).length > 0) s.on = on;
  }
  for (const name of Object.keys(m.f ?? {})) node(name).final = true;
  for (const [name, task] of Object.entries(m.t ?? {}))
    if (task !== undefined)
      node(name).task = {
        run: code(task[0], `${at}${pointer("states", name, "task", "run")}`, `state "${name}"'s task (the effect)`),
        error: transition(
          task[1],
          `${at}${pointer("states", name, "task", "error")}`,
          `state "${name}"'s task error handler`,
        ),
      };
  for (const [name, timers] of Object.entries(m.a ?? {})) {
    const after: { [ms: string]: TransitionJSON } = {};
    for (const [ms, h] of timers ?? [])
      after[String(ms)] = transition(
        h,
        `${at}${pointer("states", name, "after", String(ms))}`,
        `state "${name}"'s ${ms}ms timer`,
      );
    node(name).after = after;
  }
  for (const [name, regions] of Object.entries(m.p ?? {})) if (regions !== undefined) node(name).regions = [...regions];
  for (const [name, done] of Object.entries(m.n ?? {}))
    if (done !== undefined)
      node(name).done = transition(done, `${at}${pointer("states", name, "done")}`, `parallel node "${name}"'s done`);
  for (const [name, kids] of Object.entries(m.c ?? {})) {
    const out: { [kid: string]: ChildJSON } = {};
    for (const [kid, def] of Object.entries(kids ?? {})) {
      const path = `${at}${pointer("states", name, "children", kid)}`;
      out[kid] = {
        machine: walk(def.m, `${path}/machine`, notes),
        ...(def.i && { input: code(def.i, `${path}/input`, `child "${kid}"'s input`) }),
        ...(def.k && { each: code(def.k, `${path}/each`, `child "${kid}"'s each`) }),
        ...(def.d && { done: transition(def.d, `${path}/done`, `child "${kid}"'s done`) }),
        ...(def.u && { update: transition(def.u, `${path}/update`, `child "${kid}"'s update`) }),
      };
    }
    node(name).children = out;
  }

  const use = [
    ...(m.g ? ["nested"] : []),
    ...(m.p ? ["parallel"] : []),
    ...(m.h ? ["history"] : []),
    ...(m.c ? ["children"] : []),
    ...(m.s ? ["validate"] : []),
    ...Object.keys(m.u ?? {}),
  ];
  if (m.s !== undefined)
    notes.push({
      path: `${at}/use`,
      kind: "omitted",
      message:
        "the Standard Schemas are runtime values with no JSON form: give them back to machineFromJSON as sources.schemas.",
    });
  for (const field of Object.keys(m))
    if (!KNOWN.has(field))
      notes.push({
        path: `${at}/${field}`,
        kind: "omitted",
        message: `table field "${field}" is a feature's that has no JSON form yet: the revived machine won't have it.`,
      });
  return {
    version: m.v,
    events: Object.keys(m.e),
    ...(use.length > 0 && { use }),
    start: transition(unwrap(m.i), `${at}/start`, "start"),
    states,
    ...(m.h && { history: Object.keys(m.h) }),
  };
}

/** A machine's definition, as JSON: structure as data, handlers as data or code. Never throws. */
export function machineToJSON(machine: Machine<Shape>): MachineJSON {
  return walk(machine, "", []);
}

/** What `machineToJSON(machine)` couldn't make data: each code expression and each omission. */
export function serializationDiagnostics(machine: Machine<Shape>): readonly Diagnostic[] {
  const notes: Diagnostic[] = [];
  walk(machine, "", notes);
  return notes;
}

/** Milliseconds of a duration as written (`"500ms"`, `"5s"`, `"2m"`, `"1h"`). */
function ms(duration: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(duration);
  if (match === null) return undefined;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  return Number(match[1]) * unit;
}

/** A config's function, as written. */
const written = (fn: unknown): CodeJSON => ({ "@code": String(fn), "@args": "config" });

/**
 * A config never passed to `machine()` (`{ start, states }`, as written), as JSON: its handlers keep
 * their text, with the authoring arguments. `shape` gives setup's part: the events callers send, and
 * the version.
 *
 * @throws StateError S25 for a config that isn't `{ start, states }`, or a timer that isn't a duration.
 */
export function machineConfigToJSON(
  config: { readonly start: unknown; readonly states: { readonly [node: string]: unknown } },
  shape: { readonly events: readonly string[]; readonly version?: number; readonly use?: readonly string[] },
): MachineJSON {
  if (typeof config.start !== "function") throw bad("/start", "isn't a function: start: ({ to }) => to(...)");
  const states: { [node: string]: StateJSON } = {};
  for (const [name, value] of Object.entries(config.states)) {
    const s = (typeof value === "object" && value !== null ? value : {}) as { readonly [key: string]: unknown };
    const out: { -readonly [K in keyof StateJSON]: StateJSON[K] } = {};
    if (s["final"] === true) out.final = true;
    const on = s["on"];
    if (typeof on === "object" && on !== null)
      out.on = Object.fromEntries(Object.entries(on).map(([event, fn]) => [event, written(fn)]));
    const task = s["task"];
    if (typeof task === "object" && task !== null)
      out.task = { run: written(Reflect.get(task, "run")), error: written(Reflect.get(task, "error")) };
    const after = s["after"];
    if (typeof after === "object" && after !== null)
      out.after = Object.fromEntries(
        Object.entries(after).map(([duration, fn]) => {
          const n = ms(duration);
          if (n === undefined)
            throw bad(pointer("states", name, "after", duration), 'isn\'t a duration: "500ms", "5s", "2m" or "1h"');
          return [String(n), written(fn)];
        }),
      );
    if (s["done"] !== undefined) out.done = written(s["done"]);
    states[name] = out;
  }
  return {
    version: shape.version ?? 0,
    events: [...shape.events],
    ...(shape.use !== undefined && shape.use.length > 0 && { use: [...shape.use] }),
    start: written(config.start),
    states,
  };
}

// #endregion

// #region In

/** The features `machineFromJSON` revives, as their entries export them (only the hooks it reads). */
export interface Revivers {
  readonly nested?: { readonly g: NonNullable<__Compiled["g"]>; readonly y: __StepHook };
  readonly parallel?: object;
  readonly history?: object;
  readonly children?: { readonly r: __Runner };
  readonly validate?: {
    readonly x: __Validate;
    readonly v: (inner?: __StepHook) => __StepHook;
    readonly i: (
      schema: unknown,
      start: (input: unknown) => __Step,
      data?: { readonly [leaf: string]: unknown },
    ) => (input: unknown) => __Step;
    readonly z: NonNullable<__Compiled["z"]>;
  };
  readonly persist?: { readonly t: __Runner };
  readonly durable?: object;
}

/** What a definition refers to and can't hold. */
export interface Sources {
  /** Turns a code expression's text into the function (`(text) => (0, eval)(\`(${text})\`)`, or a sandbox's). */
  readonly evaluate?: (code: string) => unknown;
  /** The features the definition's `use` names: `{ nested, persist }`, each imported from its entry. */
  readonly use?: Revivers;
  /** The Standard Schemas, for a machine with `validate` in use: each state's, each event's, the input's. */
  readonly schemas?: {
    readonly states?: { readonly [state: string]: unknown };
    readonly events?: { readonly [event: string]: unknown };
    readonly input?: unknown;
  };
}

/** S25: the definition is malformed at `path`. */
function bad(path: string, problem: string): StateError {
  return new StateError("S25", `the machine definition's ${path === "" ? "root" : path} ${problem}.`);
}

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The keys a part of a definition may have. */
function keys(value: { readonly [key: string]: unknown }, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(value))
    if (!allowed.includes(k)) throw bad(`${path}/${k}`, `isn't a key of it: it takes ${allowed.join(", ")}`);
}

type Fn = (...args: never[]) => unknown;

function build(json: unknown, sources: Sources, at: string): __Compiled {
  if (!isObject(json)) throw bad(at, "isn't an object");
  keys(json, ["version", "events", "use", "start", "states", "history"], at);
  const use = json["use"] ?? [];
  if (!Array.isArray(use) || !use.every((u) => typeof u === "string"))
    throw bad(`${at}/use`, "isn't a list of feature names");
  const known = ["nested", "parallel", "history", "children", "validate", "persist", "durable"] as const;
  for (const name of use) {
    if (!(known as readonly string[]).includes(name))
      throw new StateError(
        "S26",
        `the machine definition uses ${name}, which machineFromJSON can't revive yet: it revives ${known.join(", ")}. Build that machine with the compiler instead.`,
      );
    if (sources.use?.[name as (typeof known)[number]] === undefined)
      throw new StateError(
        "S11",
        `the machine definition uses ${name}: add it to machineFromJSON's sources.use (import { ${name} } from "@reactre/state/${name}"), as { use: { ${name} } }.`,
      );
  }
  const has = (f: (typeof known)[number]): boolean => use.includes(f);
  const version = json["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) throw bad(`${at}/version`, "isn't a whole number");
  const events = json["events"];
  if (!Array.isArray(events) || !events.every((e) => typeof e === "string"))
    throw bad(`${at}/events`, "isn't a list of event names");
  const statesJSON = json["states"];
  if (!isObject(statesJSON)) throw bad(`${at}/states`, "isn't an object of states");
  const names = Object.keys(statesJSON);

  const fn = (value: unknown, path: string, args: (f: Fn) => Fn): Fn => {
    if (!isObject(value) || typeof value["@code"] !== "string")
      throw bad(path, 'isn\'t code ({ "@code": "...", "@args": "table" })');
    keys(value, ["@code", "@args"], path);
    if (sources.evaluate === undefined)
      throw new StateError(
        "S25",
        `the machine definition's ${path} is code, and machineFromJSON has no sources.evaluate to run it. Give it one: { evaluate: (code) => (0, eval)(\`(\${code})\`) }, or a sandbox's.`,
      );
    const f = sources.evaluate(value["@code"]);
    if (typeof f !== "function") throw bad(path, "evaluates to something that isn't a function");
    return value["@args"] === "config" ? args(f as Fn) : (f as Fn);
  };
  // A target, checked: a node of this definition.
  const target = (state: unknown, path: string): string => {
    if (typeof state !== "string" || !names.includes(state))
      throw bad(path, `goes to ${JSON.stringify(state)}, which isn't a state: the states are ${names.join(", ")}`);
    return state;
  };
  // The authoring arguments a config's handler destructures, from the table's positional ones.
  // The steps the compiler writes (`__Step`): a `to` is the snapshot itself, so each is made anew.
  const to = (state: string, data: unknown = {}): __Step => ({ state, data, version });
  const back = (parent: string, fallback: __Step): __Step => ({ b: parent, t: fallback });
  const moves = { to, back };
  const transition = (value: unknown, path: string, args: (f: Fn) => Fn): Fn => {
    if (isObject(value) && "to" in value) {
      keys(value, ["to", "data"], path);
      const state = target(value["to"], `${path}/to`);
      const data = value["data"] ?? {};
      return () => to(state, data);
    }
    return fn(value, path, args);
  };
  const on =
    (f: Fn): Fn =>
    (data, event, state) =>
      (f as (a: object) => unknown)({ data, event, state, ...moves });
  const after =
    (f: Fn): Fn =>
    (data, state) =>
      (f as (a: object) => unknown)({ data, state, ...moves });

  const o: { [node: string]: { [event: string]: __Handler } } = {};
  const f: { [leaf: string]: 1 } = {};
  const t: { [node: string]: NonNullable<NonNullable<__Compiled["t"]>[string]> } = {};
  const a: { [node: string]: [number, (data: unknown, state: string) => __Step][] } = {};
  const p: { [node: string]: string[] } = {};
  const n: { [node: string]: (regions: unknown) => __Step } = {};
  const c: { [node: string]: { [name: string]: __Child } } = {};
  for (const [name, value] of Object.entries(statesJSON)) {
    const path = `${at}${pointer("states", name)}`;
    if (!isObject(value)) throw bad(path, "isn't an object");
    keys(value, ["final", "on", "task", "after", "regions", "done", "children"], path);
    if (value["final"] === true) f[name] = 1;
    else o[name] = {};
    const handlers = value["on"];
    if (handlers !== undefined) {
      if (!isObject(handlers)) throw bad(`${path}/on`, "isn't an object of events");
      for (const [event, h] of Object.entries(handlers))
        (o[name] ??= {})[event] = transition(h, `${path}${pointer("on", event)}`, on) as __Handler;
    }
    const task = value["task"];
    if (task !== undefined) {
      if (!isObject(task)) throw bad(`${path}/task`, "isn't { run, error }");
      keys(task, ["run", "error"], `${path}/task`);
      t[name] = [
        fn(
          task["run"],
          `${path}/task/run`,
          (r) => (data, signal, state) => (r as (a: object) => unknown)({ data, signal, state }),
        ) as (data: unknown, signal: AbortSignal, state: string) => Promise<__Event>,
        transition(
          task["error"],
          `${path}/task/error`,
          (e) => (data, error, state) => (e as (a: object) => unknown)({ data, error, state, ...moves }),
        ) as (data: unknown, error: unknown, state: string) => __Step,
      ];
    }
    const timers = value["after"];
    if (timers !== undefined) {
      if (!isObject(timers)) throw bad(`${path}/after`, "isn't an object of milliseconds");
      a[name] = Object.entries(timers).map(([key, h]) => {
        const delay = Number(key);
        if (!Number.isFinite(delay) || delay < 0)
          throw bad(`${path}${pointer("after", key)}`, "isn't a number of milliseconds");
        return [
          delay,
          transition(h, `${path}${pointer("after", key)}`, after) as (data: unknown, state: string) => __Step,
        ];
      });
    }
    const regions = value["regions"];
    if (regions !== undefined) {
      if (!Array.isArray(regions) || !regions.every((r) => typeof r === "string"))
        throw bad(`${path}/regions`, "isn't a list of region names");
      p[name] = regions;
    }
    if (value["done"] !== undefined)
      n[name] = transition(
        value["done"],
        `${path}/done`,
        (d) => (data) => (d as (a: object) => unknown)({ data, ...moves }),
      ) as (regions: unknown) => __Step;
    const kids = value["children"];
    if (kids !== undefined) {
      if (!isObject(kids)) throw bad(`${path}/children`, "isn't an object of children");
      c[name] = {};
      for (const [kid, def] of Object.entries(kids)) {
        const kp = `${path}${pointer("children", kid)}`;
        if (!isObject(def)) throw bad(kp, "isn't { machine, input, done, update }");
        keys(def, ["machine", "input", "each", "done", "update"], kp);
        const report =
          (r: Fn): Fn =>
          (data, output, state, key) =>
            (r as (a: object) => unknown)({ data, output, child: output, state, key, ...moves });
        c[name][kid] = {
          m: build(def["machine"], sources, `${kp}/machine`),
          ...(def["input"] !== undefined && {
            i: fn(
              def["input"],
              `${kp}/input`,
              (i) => (data, state) => (i as (a: object) => unknown)({ data, state }),
            ) as __Child["i"] & {},
          }),
          ...(def["each"] !== undefined && {
            k: fn(
              def["each"],
              `${kp}/each`,
              (e) => (data, state) =>
                (e as (a: object) => readonly { key: string; input: unknown }[])({ data, state }).map(
                  (x) => [x.key, x.input] as const,
                ),
            ) as __Child["k"] & {},
          }),
          ...(def["done"] !== undefined && { d: transition(def["done"], `${kp}/done`, report) as __Child["d"] & {} }),
          ...(def["update"] !== undefined && {
            u: transition(def["update"], `${kp}/update`, report) as __Child["u"] & {},
          }),
        };
      }
    }
  }
  const history = json["history"];
  if (history !== undefined && (!Array.isArray(history) || !history.every((h) => typeof h === "string")))
    throw bad(`${at}/history`, "isn't a list of parents");

  let start = transition(
    json["start"],
    `${at}/start`,
    (s) => (input) => (s as (a: object) => unknown)({ input, ...moves }),
  ) as (input: unknown) => __Step;
  const fields: { -readonly [K in keyof __Compiled]: __Compiled[K] } = {
    v: version,
    e: Object.fromEntries(events.map((e) => [e, 1 as const])),
    i: start,
    o,
  };
  if (Object.keys(f).length > 0) fields.f = f;
  if (Object.keys(t).length > 0) fields.t = t;
  if (Object.keys(a).length > 0) fields.a = a;
  if (Object.keys(p).length > 0) fields.p = p;
  if (Object.keys(n).length > 0) fields.n = n;
  if (Object.keys(c).length > 0) fields.c = c;
  if (history !== undefined && history.length > 0) fields.h = Object.fromEntries(history.map((h) => [h, 1 as const]));

  // The features' hooks, as the compiler writes them (compiler/features/<f>.ts).
  const r = sources.use;
  let step: __StepHook | undefined;
  if (has("nested") && r?.nested !== undefined) {
    fields.g = r.nested.g;
    step = r.nested.y;
  }
  if (has("validate") && r?.validate !== undefined) {
    const schemas = sources.schemas ?? {};
    fields.s = {
      ...(schemas.events !== undefined && { e: schemas.events }),
      ...(schemas.input !== undefined && { i: schemas.input }),
      ...(schemas.states !== undefined && { d: schemas.states }),
    };
    fields.x = r.validate.x;
    if (schemas.states !== undefined) fields.z = r.validate.z;
    if (schemas.input !== undefined || schemas.states !== undefined)
      start = r.validate.i(schemas.input, start, schemas.states);
    fields.i = start;
    step = r.validate.v(step);
  }
  if (step !== undefined) fields.y = step;
  const markers = (["persist", "durable"] as const).filter(has);
  if (markers.length > 0) fields.u = Object.fromEntries(markers.map((x) => [x, 1 as const]));

  // The lifecycle, as the compiler picks it: none, the lean one, or the general one.
  const timed = fields.t !== undefined || fields.a !== undefined;
  const tasks = has("persist") ? r?.persist?.t : undefined;
  const runners = [
    ...(timed ? [tasks ?? __tasks] : []),
    ...(fields.c !== undefined && r?.children ? [r.children.r] : []),
  ];
  const general = has("persist") || runners.length > (timed ? 1 : 0) || tasks !== undefined || fields.g !== undefined;
  const lifecycle: __Lifecycle | undefined =
    general && (runners.length > 0 || has("persist")) ? __run(runners) : timed ? __lean : undefined;
  if (lifecycle !== undefined) fields.r = lifecycle;
  return fields;
}

/**
 * A machine from its definition (`machineToJSON`'s or `machineConfigToJSON`'s, through JSON):
 * `machineFromJSON(JSON.parse(text), { evaluate, use: { nested }, schemas })`.
 *
 * @throws StateError S25 for a malformed definition (naming the JSON path) or code without
 *   `sources.evaluate`, S26 for a feature it can't revive, S11 for a feature missing from `sources.use`.
 */
export function machineFromJSON(json: unknown, sources: Sources = {}): Machine<Shape> {
  return build(json, sources, "");
}

// #endregion
