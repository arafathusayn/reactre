// XState v4 isn't installed: this stands in for the two functions the v4-style sources use, with
// loose types, so they type-check. `toV5` runs such a machine on XState v5 with v4's meaning (the
// subset the fixtures use): `cond` is `guard`, implementations take `(context, event)`, `services`
// are actors given the context and the event, and a service that returns nothing starts nothing,
// so its onDone never comes (v4 skipped it).

import { assign as assign5, createMachine as createMachine5, fromPromise } from "xstate";

/** v4's `createMachine<Context, Event>(config, options)`. */
export function createMachine<Context, Event extends { readonly type: string }>(
  config: { readonly context: Context; readonly [key: string]: unknown },
  options?: { readonly [key: string]: unknown },
): { readonly config: object; readonly options: object | undefined; readonly event?: Event } {
  return { config, options };
}

/** v4's `assign`. */
export function assign(assignment: object): { readonly type: "xstate.assign"; readonly assignment: object } {
  return { type: "xstate.assign", assignment };
}

type V4Fn = (context: unknown, event: unknown) => unknown;
type V5Args = { readonly context: unknown; readonly event: unknown };

function isRecord(v: unknown): v is { readonly [key: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFn(v: unknown): v is V4Fn {
  return typeof v === "function";
}

/** A v4 function `(context, event)` as v5's `({ context, event })`. */
function args(f: V4Fn): (a: V5Args) => unknown {
  return ({ context, event }) => f(context, event);
}

/** One v4 action: a name, `assign(...)`, or a function. */
function action(a: unknown): unknown {
  if (isRecord(a) && a["type"] === "xstate.assign") {
    const assignment = a["assignment"];
    if (isFn(assignment)) return assign5(({ context, event }) => assignment(context, event) as object);
    if (isRecord(assignment))
      return assign5(
        Object.fromEntries(Object.entries(assignment).map(([k, v]) => [k, isFn(v) ? args(v) : v])) as never,
      );
  }
  return isFn(a) ? args(a) : a;
}

/** A v4 config node, deep, as v5 reads it. */
function node(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(node);
  if (!isRecord(v)) return v;
  const out: { [key: string]: unknown } = {};
  for (const [k, value] of Object.entries(v)) {
    if (["tsTypes", "schema", "predictableActionArguments", "preserveActionOrder"].includes(k)) continue;
    if (k === "cond") out["guard"] = isFn(value) ? args(value) : value;
    else if (k === "actions" || k === "entry" || k === "exit")
      out[k] = Array.isArray(value) ? value.map(action) : action(value);
    else if (k === "invoke") {
      const one = (i: unknown): unknown =>
        isRecord(i) && typeof i["src"] === "string"
          ? { ...(node(i) as object), input: ({ context, event }: V5Args) => ({ context, event }) }
          : node(i);
      out[k] = Array.isArray(value) ? value.map(one) : one(value);
    } else out[k] = node(value);
  }
  return out;
}

function each(o: unknown, f: (v: unknown) => unknown): { [key: string]: unknown } {
  return isRecord(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])) : {};
}

/** A machine from the stand-in `createMachine`, on XState v5 with v4's meaning. */
export function toV5(machine: { readonly config: object; readonly options: object | undefined }) {
  const options = isRecord(machine.options) ? machine.options : {};
  const services = each(options["services"], (s) =>
    fromPromise(({ input }: { input: V5Args }) => {
      if (!isFn(s)) return new Promise<never>(() => {});
      const result = s(input.context, input.event);
      return result === undefined ? new Promise<never>(() => {}) : Promise.resolve(result);
    }),
  );
  return createMachine5(node(machine.config) as never, {
    actions: each(options["actions"], action) as never,
    guards: each(options["guards"], (g) => (isFn(g) ? args(g) : g)) as never,
    actors: services as never,
    delays: each(options["delays"], (d) => (isFn(d) ? args(d) : d)) as never,
  });
}
