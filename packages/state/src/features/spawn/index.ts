// @reactre/state/spawn (prototype): children started by a handler, not by a node. `setup({ use:
// [children, effects, spawn], children: { worker: workerMachine } })`, then in a handler
// `enq.spawn("worker", { key: data.id, input })`, `enq.subscribeTo("worker", { key: data.id, done:
// "finished" })`, `enq.stop("worker", data.id)`; in the app, `child(actor, "worker", id)`.
//
// Design decisions:
//   - A spawned child is one of setup's `children`, by name and key, as a keyed child is: XState
//     spawns logic by reference with an id. A handler is pure and holds no actor, so the effect
//     names what to start (data), and `child(actor, name, key)` reaches it, one way for both.
//   - What a child reports comes back as one of the machine's own events, named in the effect
//     (`done: "finished"` sends `{ type: "finished", output }`): XState's `subscribeTo` and `listen`
//     take mapping functions. Names are data, so a persisted actor saves its spawned children with
//     their subscriptions, and `restoreActor` brings both back. The reports are internal events.
//   - It lives with the actor, not a node: it runs until `enq.stop`, its own end, or the actor's
//     stop. (A child for as long as a node is active is a node's `children`.) A spawned child that
//     ends leaves; its `done` or `error` report comes after it ends.
//   - Spawning a name and key that is running throws S40: stop it first, or give another key.
//   - It runs on the effect registry: recorders (`e`) for effects's `enq`, runners (`q`) for its
//     dispatcher. The table gets the machines it may spawn (`sp`), and the lifecycle a wrap (`w`)
//     that keeps the actor's options for its spawned children.
//   - A spawned child inherits its parent's options, as a node's child does: its clock, `inspect`
//     and `logger` (with its path as its id, `root/worker:a`), and its `system`. Not the parent's
//     `registryKey` or `parent`: those name the parent.
//   - Restoring spawned children (`restoreActor` of a persisted actor) is ./restore.ts's: the
//     compiler wraps the lifecycle with it only when persist is in use, so an app that never
//     persists ships no `restoreActor` for it.

import { type __Actor, createActor, type Feature, StateError } from "../../index.ts";
import type {
  __Compiled,
  __EffectRunners,
  __Event,
  __Lifecycle,
  __Live,
  __Options,
  __Persisted,
  __Works,
} from "../../internal.ts";
import { __persisted } from "../children/persisted.ts";
import type { __Recorders } from "../effects/index.ts";
import type { EffectBy } from "../effects/types.ts";
import { on } from "../emit/index.ts";
import { __outcome } from "../logic/outcome.ts";

// The overloads type a machine by its shape, which a compiled child's table doesn't carry.
const create = createActor as unknown as (m: __Compiled, options: __Options) => __Actor;

type Subscribed = Omit<EffectBy["subscribeTo"], "type" | "name" | "key">;
type Listened = { readonly event: string; readonly as: string };

/** Internal: a spawned child, with what it reports and how to stop listening. */
export interface Kid {
  readonly name: string;
  readonly key: string | undefined;
  readonly actor: __Actor;
  subs: Subscribed;
  readonly listens: Listened[];
  readonly off: (() => void)[];
}

/** Internal: what a spawned child saves: its persisted snapshot, and its subscriptions (data). */
export interface Saved {
  readonly name: string;
  readonly key?: string;
  readonly snapshot: __Persisted;
  readonly subs: Subscribed;
  readonly listens: readonly Listened[];
}

/** Internal: an actor's spawned children, by `name` + key. */
export interface Spawned {
  readonly kids: Map<string, Kid>;
  /** The actor's internal events (a report). */
  readonly deliver: (event: __Event) => unknown;
}

const spawned = new WeakMap<__Live, Spawned>();
// Each actor's options, kept by the lifecycle's wrap (`w`), for its spawned children.
const optionsOf = new WeakMap<__Live, __Options | undefined>();
const id = (name: string, key: string | undefined) => (key === undefined ? name : `${name}:${key}`);

/**
 * Internal: the options a child spawned by `live`'s actor gets: its parent's (the clock, inspect,
 * logger, system), with its own input and its path as its id.
 */
export function __inherited(live: __Live, name: string, key: string | undefined, input: unknown): __Options {
  const { run: _run, parent: _parent, registryKey: _key, ...rest } = optionsOf.get(live) ?? {};
  return { ...rest, input, id: `${rest.id ?? "root"}/${id(name, key)}` };
}

/** Internal: the actor's spawned children, registered in its works (`""`, runner "s") on first use. */
export function __of(live: __Live, deliver: (event: __Event) => unknown): Spawned {
  let s = spawned.get(live);
  if (s) return s;
  const kids = new Map<string, Kid>();
  s = { kids, deliver };
  spawned.set(live, s);
  const works: __Works | undefined = live.works;
  let list = works?.get("");
  if (!list) works?.set("", (list = []));
  list?.push({
    id: "s",
    work: {
      stop: () => {
        for (const k of kids.values()) end(k);
        kids.clear();
      },
      child: (name, key) => kids.get(id(name, key))?.actor,
      save: (): Saved[] | undefined =>
        kids.size === 0
          ? undefined
          : [...kids.values()].map((k) => ({
              name: k.name,
              ...(k.key !== undefined && { key: k.key }),
              snapshot: __persisted(k.actor),
              subs: k.subs,
              listens: k.listens,
            })),
    },
  });
  return s;
}

function end(k: Kid): void {
  for (const f of k.off.splice(0)) f();
  k.actor.stop();
}

/** Reports a kid's moves and end to its parent, and drops it once it ends. */
function watch(s: Spawned, k: Kid): void {
  // An event of `type` with `body` (the type layer checked the machine has it, with that body).
  const tell = (type: string | undefined, body: object): unknown => type && s.deliver(Object.assign({ type }, body));
  const report = (): void => {
    tell(k.subs.snapshot, { snapshot: k.actor.snapshot() });
    if (k.actor.status() !== "done") return;
    s.kids.delete(id(k.name, k.key));
    for (const f of k.off.splice(0)) f();
    const out = __outcome(k.actor);
    tell("error" in out ? k.subs.error : k.subs.done, out);
  };
  k.off.push(k.actor.subscribe(report));
  // Ended as it started (or restored ended): report after the move that spawned it.
  if (k.actor.status() === "done") queueMicrotask(report);
}

/** Internal: `k`'s emitted `l.event`s, delivered to its parent as `l.as`. */
export function __listen(s: Spawned, k: Kid, l: Listened): void {
  // `on` is emit's: the child's machine emits (the type layer checked `event` is one it emits).
  const hear = on as unknown as (a: __Actor, type: string, f: (e: __Event) => void) => () => void;
  k.off.push(hear(k.actor, l.event, (e) => s.deliver({ ...e, type: l.as })));
}

/** Internal: spawn `name` (by `key`) of `m`'s setup children, its actor made by `make`, and watch it. */
export function __start(
  s: Spawned,
  m: __Compiled,
  name: string,
  key: string | undefined,
  make: (cm: __Compiled) => __Actor,
): Kid {
  const cm = m.sp?.[name];
  if (!cm)
    throw new StateError(
      "S40",
      `enq.spawn("${name}") names no child this machine can spawn: add it to setup's children, with spawn in setup's use.`,
    );
  const k: Kid = { name, key, actor: make(cm), subs: {}, listens: [], off: [] };
  s.kids.set(id(name, key), k);
  watch(s, k);
  return k;
}

/** This feature's runners, by effect type. */
const runners: __EffectRunners = {
  spawn: (e, ctx) => {
    const { name, key, input } = e as EffectBy["spawn"];
    const s = __of(ctx.live, ctx.deliver);
    if (s.kids.has(id(name, key)))
      throw new StateError(
        "S40",
        `enq.spawn("${name}"${key === undefined ? "" : `, { key: "${key}" }`}) while that child runs: stop it first (enq.stop), or give it another key.`,
      );
    if (ctx.live.m) __start(s, ctx.live.m, name, key, (cm) => create(cm, __inherited(ctx.live, name, key, input)));
  },
  stop: (e, ctx) => {
    const { name, key } = e as EffectBy["stop"];
    const s = spawned.get(ctx.live);
    const k = s?.kids.get(id(name, key));
    if (!k) return;
    s?.kids.delete(id(name, key));
    end(k);
  },
  subscribeTo: (e, ctx) => {
    const { name, key, snapshot, done, error } = e as EffectBy["subscribeTo"];
    const k = spawned.get(ctx.live)?.kids.get(id(name, key));
    if (k) k.subs = { ...k.subs, ...(snapshot && { snapshot }), ...(done && { done }), ...(error && { error }) };
  },
  listen: (e, ctx) => {
    const { name, key, event, as } = e as EffectBy["listen"];
    const s = spawned.get(ctx.live);
    const k = s?.kids.get(id(name, key));
    if (!s || !k) return;
    k.listens.push({ event, as });
    __listen(s, k, { event, as });
  },
};

/** This feature's `enq` methods. */
const recorders: __Recorders = {
  spawn: (name: string, o?: { readonly key?: string; readonly input?: unknown }) => ({ type: "spawn", name, ...o }),
  stop: (name: string, key?: string) => ({ type: "stop", name, ...(key !== undefined && { key }) }),
  subscribeTo: (name: string, reports: object) => ({ type: "subscribeTo", name, ...reports }),
  listen: (name: string, event: string, as: string, o?: { readonly key?: string }) => ({
    type: "listen",
    name,
    event,
    as,
    ...o,
  }),
};

/**
 * Internal: the lifecycle around `inner` (`r: spawn.w(inner)`), which keeps the actor's options for
 * the children it spawns.
 */
export function __inheriting(inner: __Lifecycle): __Lifecycle {
  return (m, move, current, options) => {
    const live = inner(m, move, current, options);
    optionsOf.set(live, options);
    return live;
  };
}

/** The spawn opt-in: `setup({ use: [children, effects, spawn], children: { ... } })`. */
export const spawn: Spawn = { e: recorders, q: runners, w: __inheriting };

/** The spawn opt-in's type: an interface, so a type error names it `Spawn`, not its hooks. */
export interface Spawn extends Feature<"spawn"> {
  /** Internal: `enq.spawn`, `enq.stop`, `enq.subscribeTo`, `enq.listen`'s recorders. */
  readonly e: __Recorders;
  /** Internal: their runners. */
  readonly q: __EffectRunners;
  /** Internal: the lifecycle that keeps the actor's options for its spawned children (`r: spawn.w(inner)`). */
  readonly w: typeof __inheriting;
}
