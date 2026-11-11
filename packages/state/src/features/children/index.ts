// @reactre/state/children (prototype): child actors. A node's children run while it is active:
// `setup({ use: [children], children: { upload: uploadMachine }, ... })`. The compiler lists them in
// `c` and puts this feature's runner in the general lifecycle (`r: __run([children.r])`). The app
// imports `child` to reach one.
//
// Design decisions:
//   - A child is an actor like any other (`createActor`, or `restoreActor` from what `save`
//     returned), on the parent's clock. Leaving the node stops it.
//   - Its `done` and `update` handlers are the parent's transitions, through `ctx.go`: the core
//     drops them once the node has exited, and so does a keyed child that was reconciled away.
//   - A child already in a final state when it starts (its start goes straight there, or it was
//     restored there) reports `done` in a microtask, not at once. It starts inside the parent's
//     entry, and a transition then would nest in that entry, before the core has even listed the
//     runner's work to stop. Every later report is synchronous, like a task's result.
//     The same holds for what it sends back and a failure while it starts.
//   - `done` runs on the child's final transition, and `update` on the others. A child that is
//     actor logic (@reactre/state/logic) ends in `done`, whose output `done` gets, or in `error`,
//     which `error` gets. So does a child whose start threw (an input its schema refused), when its
//     spec has `error`; without one, the throw reaches whoever entered the node, as before.
//   - What a logic child sends back (`sendBack`) goes to its spec's `on`, by type: the handlers of
//     its parent's node are for the events the node takes, not for what one child says.
//   - Several children per node, each by its setup name: XState's invoke array, already named.
//     XState's invoke `timeout` and `onTimeout` are the node's `after`, which stops the children
//     when it leaves: one way to bound a node's time.
//   - A child inherits its parent's actor options (its clock, `inspect`, its `system`), and with
//     `registryKey` (`use: [system]`) is in its system's registry while it runs.
//   - Keyed collections are reconciled on entry and on each `update`: new keys start, missing
//     keys stop. A single child is stored under the key "".
//   - `save` keeps each child's snapshot with its own runners' parts, recursively, as
//     the persist feature does: `{ [name]: { [key]: persisted } }`. It is in ./saved.ts, with the
//     restore of a saved child: a machine that doesn't persist ships neither.

import { type __Actor, type Actor, createActor, type Feature, type Machine, type Shape } from "../../index.ts";
import type { __Child, __Leaf, __Options, __Persisted, __Runner, __Step } from "../../internal.ts";
import { __outcome } from "../logic/outcome.ts";

// The overloads type a machine by its shape, which a compiled child's table doesn't carry: this is
// its implementation signature.
const create = createActor as unknown as (m: __Child["m"], options: __Options) => __Actor;

interface Kid {
  readonly a: __Actor | undefined;
  readonly end: () => void;
}

/**
 * Internal: the runner a compiled machine with a child gets. A machine that also persists passes
 * the functions that read and save the children's own state (./saved.ts): without them the runner
 * has no `save` and never restores a child, so an app that doesn't persist ships neither.
 */
export const __actorsOf = (
  restore?: (m: __Child["m"], saved: __Persisted, options: __Options) => __Actor,
  persisted?: (a: __Actor) => __Persisted,
): __Runner => ({
  id: "c",
  start(m, { node, state, data }, ctx) {
    const defs = m.c?.[node];
    if (defs === undefined) return null;
    const all = Object.entries(defs);
    // What this runner's `save` returned, given back by the core on restore.
    let saved = ctx.saved as { readonly [name: string]: { readonly [key: string]: __Persisted } } | undefined;
    const kids = new Map<string, Map<string, Kid>>();

    function spawn(
      { m: cm, d, u, x, o, g }: __Child,
      name: string,
      key: string | undefined,
      input: unknown,
      from: __Persisted | undefined,
    ): Kid {
      let gone = false;
      // Reports while the child starts wait for a microtask (see the header); later ones don't.
      let starting = true;
      const later = (f: () => void): void => (starting ? queueMicrotask(f) : f());
      /** The parent's step from one of the child's handlers, read from the leaf under the node now. */
      const go = (f: (data: unknown, state: string) => __Step | null): void => {
        if (gone) return;
        const now = ctx.current();
        const step = f(now.data, now.state);
        if (step !== null) ctx.go(step);
      };
      const fail = (error: unknown): void => {
        if (x) later(() => go((data, state) => x(data, error, state, key)));
      };
      // The child's options: its parent's (a restored child gets back what it saved, not its
      // parent's `run`), with its input, its id, and where the events it sends back go.
      const { run: _, ...inherited } = ctx.options ?? {};
      const options: __Options = {
        ...inherited,
        input,
        now: ctx.now,
        // Its path, for inspection: `root/upload`, `root/files:a`.
        id: `${ctx.options?.id ?? "root"}/${key === undefined ? name : `${name}:${key}`}`,
        parent: (event) => {
          const h = o?.[event.type];
          if (h) later(() => go((data, state) => h(data, event, state, key)));
        },
      };
      let a: __Actor | undefined;
      try {
        a = from === undefined || restore === undefined ? create(cm, options) : restore(cm, from, options);
      } catch (error) {
        if (x === undefined) throw error;
        fail(error);
      }
      const actor = a;
      let last: __Leaf | undefined;
      const report = (s: __Leaf): void => {
        if (s === last || actor === undefined) return; // a received event that changed nothing
        last = s;
        if (cm.f?.[s.state] !== 1) {
          if (u) go((data, state) => u(data, s, state, key));
          return;
        }
        // An actor of logic ends in `done` (its output) or `error`; a machine, in its final state.
        const end = __outcome(actor);
        if ("error" in end) fail(end.error);
        // The cast: `d`'s output is a machine's final leaf, or, for logic, its output as it is.
        else if (d) go((data, state) => d(data, end.output as __Leaf, state, key));
      };
      const off = actor?.subscribe(report);
      if (actor?.status() === "done") queueMicrotask(() => report(actor.snapshot()));
      // Read at the call, not kept: the same value, and one binding fewer.
      if (actor && g !== undefined) ctx.options?.system?.["~add"](g, actor);
      starting = false;
      return {
        a: actor,
        end() {
          gone = true;
          off?.();
          actor?.stop();
          if (actor && g !== undefined) ctx.options?.system?.["~del"](g, actor);
        },
      };
    }

    function sync(leaf: __Leaf): void {
      for (const [name, def] of all) {
        const list = kids.get(name) ?? new Map<string, Kid>();
        kids.set(name, list);
        const from = saved?.[name];
        if (def.k === undefined) {
          if (!list.has("")) list.set("", spawn(def, name, undefined, def.i?.(leaf.data, leaf.state), from?.[""]));
          continue;
        }
        const want = new Map(def.k(leaf.data, leaf.state));
        for (const [key, kid] of list)
          if (!want.has(key)) {
            list.delete(key);
            kid.end();
          }
        for (const [key, input] of want) if (!list.has(key)) list.set(key, spawn(def, name, key, input, from?.[key]));
      }
      saved = undefined;
    }

    sync({ state, data });
    return {
      stop() {
        for (const list of kids.values()) for (const kid of list.values()) kid.end();
        kids.clear();
      },
      update: sync,
      // Only a machine that persists has `persisted`: then its children save, and the runner does.
      ...(persisted && {
        save() {
          const out: { [name: string]: { [key: string]: __Persisted } } = {};
          for (const [name, list] of kids)
            for (const [key, { a }] of list) if (a) (out[name] ??= {})[key] = persisted(a);
          return out;
        },
      }),
      child: (name, key) => kids.get(name)?.get(key ?? "")?.a,
    };
  },
});

/** Internal: the runner of a machine with children that doesn't persist (the plain one). */
export const __actors: __Runner = __actorsOf();

/**
 * The children opt-in: setup's `children` names the child machines, and a node's `children` runs
 * them while it is active. `setup({ use: [children], children: { upload: uploadMachine }, ... })`.
 */
export const children: Children = { r: __actors };

/** The children opt-in's type: an interface, so a type error names it `Children`, not its runner. */
export interface Children extends Feature<"children"> {
  /** Internal: the runner of a node's children (`r: __run([children.r])`). */
  readonly r: __Runner;
}

/**
 * The children a parent's types carry: the core's `machine` result attaches the config's
 * `children` (each node's, merged by name) to the shape as `"~children"`.
 */
type ChildrenOf<D> = D extends { readonly "~children"?: infer K } ? NonNullable<K> : {};

/** A child's `Actor`, from its config's `machine`. */
type ActorOf<C> = C extends { readonly machine: Machine<infer CD extends Shape> } ? Actor<CD> : never;

/** A keyed collection (`each`) takes its key. */
type KeyOf<C> = C extends { readonly each: unknown } ? [key: string] : [];

/**
 * A child actor of `actor`, by name (and by key, for a keyed collection): `undefined` while the
 * node that runs it isn't active.
 */
export function child<D extends Shape, N extends keyof ChildrenOf<D> & string>(
  actor: Actor<D>,
  name: N,
  ...key: KeyOf<ChildrenOf<D>[N]>
): ActorOf<ChildrenOf<D>[N]> | undefined;
// Every actor has `~r` (`__Actor`); the public `Actor` hides it, so this signature reads it as
// optional, which both accept.
export function child(
  actor: { readonly snapshot: unknown; readonly "~r"?: __Actor["~r"] },
  name: string,
  key?: string,
): unknown {
  for (const list of actor["~r"]?.works?.values() ?? [])
    for (const { work } of list) {
      const found = work.child?.(name, key);
      if (found !== undefined) return found;
    }
  return undefined;
}
