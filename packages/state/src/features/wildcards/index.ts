// @reactre/state/wildcards (prototype): wildcard events, `setup({ use: [wildcards], ... })`, then
// `on: { "*": ({ event, to }) => ..., "pointer.*": ({ event, to }) => ... }`.
//
// Design decisions:
//   - XState's descriptors: "*" matches any event, "pointer.*" any event named "pointer.<...>". An
//     exact handler comes first, then the longest prefix, then "*", within a node; across nodes the
//     innermost decides, as with exact handlers (a leaf's "*" before its parent's exact one).
//   - The handlers are compiled as any `on` handler, under their key. The step hook resolves an
//     event's type to the node's handler once per type and keeps the table it made, so a step pays
//     one lookup, and a machine without a wildcard ships none of it.

import { __flat, type Feature } from "../../index.ts";
import type { __Compiled, __Handler, __StepHook } from "../../internal.ts";

type Handlers = { readonly [event: string]: __Handler | undefined };

/** A node's handler for `type`: its own, else its longest matching "a.b.*", else its "*". */
const match = (handlers: Handlers, type: string): __Handler | undefined => {
  const parts = type.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    const h = handlers[`${parts.slice(0, i).join(".")}.*`];
    if (h) return h;
  }
  return handlers["*"];
};

/** The tables made, by machine and event type: each node's handler for that type resolved. */
const made = new WeakMap<__Compiled, Map<string, __Compiled>>();

const resolved = (m: __Compiled, type: string): __Compiled => {
  let byType = made.get(m);
  if (byType === undefined) made.set(m, (byType = new Map()));
  let t = byType.get(type);
  if (t === undefined) {
    const o: { [node: string]: Handlers } = {};
    for (const node in m.o) {
      const handlers = m.o[node] ?? {};
      const h = handlers[type] ?? match(handlers, type);
      o[node] = h ? { ...handlers, [type]: h } : handlers;
    }
    byType.set(type, (t = { ...m, o }));
  }
  return t;
};

/** Internal: the step with wildcards resolved, around the step it wraps (the flat one by default). */
export const __wildcards =
  (inner?: __StepHook): __StepHook =>
  (m, from, event, internal) => {
    const t = resolved(m, event.type);
    return inner ? inner(t, from, event, internal) : __flat(t, from, event);
  };

/** The wildcards opt-in: `on: { "*": ..., "a.*": ... }`. */
export const wildcards: Wildcards = { y: __wildcards };

/** The wildcards opt-in's type: an interface, so a type error names it. */
export interface Wildcards extends Feature<"wildcards"> {
  /** Internal: wraps the step (`y` in the table). */
  readonly y: (inner?: __StepHook) => __StepHook;
}
