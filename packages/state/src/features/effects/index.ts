// @reactre/state/effects (prototype): `entry`, `exit`, and `enq` in every handler that decides a
// transition. `setup({ use: [effects], ... })`, then `on: { save: ({ data, enq, to }) => { enq(() =>
// track(data)); return to("saving", data); } }`. This module is the effect registry's implementation
// (../../internal.ts, "The effect registry"): the recorder, the step that records, the lifecycle
// wrap that settles moves that aren't steps, and the dispatcher.
//
// Design decisions:
//   - Effects are data. `enq(...)` records a descriptor (`{ type: "raise", event }`) and returns;
//     nothing runs during the transition. The step puts what was recorded on the result's `fx`, so
//     `transition()` returns it unrun and a test asserts it. An actor runs it after the move, through
//     the dispatcher the compiler puts in `r` (`effects.l(__run(runners, effects.d([...])))`).
//   - The order is XState's: exits (innermost first), then the handler's, then entries (outermost
//     first). A move to the same leaf stays: no exit, no entry, as its task and timers keep running.
//   - Effects are the taken handler's alone. A handler that returns null drops what it recorded, so
//     in a hierarchy a leaf that declines leaves nothing in the step its parent takes (XState runs
//     only the actions of the transition it takes).
//   - `enq.raise(event)` without a delay is handled in the same step, after the transition, in the
//     order raised: a listener sees only where the step ends, as with XState's raised events. A raise
//     loop throws S61 after 100 rounds. With a delay, it is sent later (`enq.cancel(id)` stops it).
//   - A move that isn't a step (a timer's, a task's error, a child's `done`) is settled the same way
//     before the actor moves (`l` wraps the lifecycle's moves): exits, the handler's, entries, and
//     its raised events stepped through, so listeners hear only where it ends.
//   - A final state's `entry` runs when the machine ends in it (XState's too). An `enq.effect` from
//     it is cleaned up at once: the actor has ended.
//   - A restored actor doesn't run its entries again: they ran before it was saved (XState doesn't
//     replay entry actions on restore either). Its tasks and timers start again, as before.
//   - `enq.effect(fn)`'s cleanup runs when the node whose `entry` enqueued it exits; from any other
//     handler, when the actor stops or ends. Delayed raises and sends are the actor's: they survive a
//     move, and stop with the actor. Both live in the lifecycle's works (`""` is the actor's list).
//     `persist` saves the pending delayed raises and sends by name (`run[""]["~fx"]`, each with its
//     deadline), and a restore books them again with the time they had left; a send to an actor
//     given by reference, and an effect's cleanup, aren't JSON, so they aren't saved.
//   - The start's raised events are delivered after its move: no listener can be subscribed yet.
//   - Other features add `enq` methods (`e`, a recorder map, merged by `w`) and runners (`q`, by
//     effect type), as data on their values: nothing registers at import time.

import {
  __flat,
  __step,
  type Feature,
  initial,
  type Machine,
  type Shape,
  type Snapshot,
  StateError,
} from "../../index.ts";
import type { ActorInput } from "../../index.ts";
import type {
  __Compiled,
  __Dispatch,
  __Effect,
  __EffectContext,
  __EffectRunners,
  __Event,
  __Handler,
  __Lifecycle,
  __Live,
  __Node,
  __Result,
  __Running,
  __Snapshot,
  __StepHook,
  __Works,
} from "../../internal.ts";
// The active nodes of a snapshot, outermost first: the hierarchy's (`g`), or the leaf.
import { __nodes } from "../../run.ts";
import type { Effect, EffectBy } from "./types.ts";

/** Internal: a feature's `enq` methods, by name: each returns the effect it records (`e` on its value). */
export type __Recorders = { readonly [method: string]: (...args: never[]) => __Effect };

/** Internal: the dispatcher the compiler hands `__run` (`effects.d(maps)`). */
export type __Dispatcher = __Dispatch;

/** A delayed raise or send by name, pending: what `persist` saves, with its deadline. */
export interface __Pending {
  readonly e: EffectBy["raise"] | EffectBy["sendTo"];
  readonly at: number;
}

// What handlers record: a step takes it, and so does the lifecycle wrap, for a move that isn't a step.
let rec: __Effect[] = [];
/** The node whose `entry` is running: `enq.effect`'s cleanup runs when it exits. */
let scope: string | undefined;
/** The snapshots steps settled: the dispatcher runs their effects as they are. */
const done = new WeakSet<__Snapshot>();
/** A restored actor's first snapshot, with the delayed effects it had pending. */
const resumes = new WeakMap<__Snapshot, readonly __Pending[]>();

const put = <E extends __Effect>(e: E): E => {
  rec.push(e);
  return e;
};

const take = (): __Effect[] => {
  const r = rec;
  rec = [];
  return r;
};

/** `enq`, with the methods of the features in `use` that add some (`e`). */
function make(features: readonly Feature[]): unknown {
  const enq = (fn: unknown, ...args: unknown[]): void => {
    put(typeof fn === "string" ? { type: "action", name: fn, params: args[0] } : { type: "fn", fn, args });
  };
  const methods: { [method: string]: (...args: never[]) => __Effect } = {
    raise: (event: __Event, o?: object) => put({ type: "raise", event, ...o }),
    cancel: (id: string) => put({ type: "cancel", id }),
    sendTo: (to: unknown, event: __Event, o?: object) => put({ type: "sendTo", to, event, ...o }),
    log: (...values: unknown[]) => put({ type: "log", values }),
    effect: (fn: () => unknown) => put({ type: "effect", fn, node: scope }),
  };
  for (const f of features) {
    // A feature value's recorders (`e`), when it has some: ../../internal.ts, "The effect registry".
    const e: unknown = Reflect.get(f, "e");
    if (typeof e === "object" && e !== null)
      for (const [name, record] of Object.entries(e as __Recorders))
        // The type layer checked the arguments against the feature's `enq` types.
        methods[name] = (...args: never[]) => put(record(...args));
  }
  return Object.assign(enq, methods);
}

/** The tables whose handlers keep what they record only when they move (`own`), by machine. */
const owned = new WeakMap<__Compiled, __Compiled>();

/**
 * `m` with each handler dropping what it recorded when it declines (returns null): another node's
 * handler may take the event, and the step's effects are the taken handler's alone.
 */
function own(m: __Compiled): __Compiled {
  let t = owned.get(m);
  if (t === undefined) {
    const o: { [node: string]: { [event: string]: __Handler | undefined } } = {};
    for (const node in m.o) {
      const handlers: { [event: string]: __Handler | undefined } = (o[node] = {});
      for (const [type, h] of Object.entries(m.o[node] ?? {}))
        handlers[type] =
          h &&
          ((data, event, state) => {
            const at = rec.length;
            const next = h(data, event, state);
            if (!next) rec.length = at;
            return next;
          });
    }
    owned.set(m, (t = { ...m, o }));
  }
  return t;
}

/**
 * The effects of a move's exits (innermost first) and its entries (outermost first). A node the
 * move re-entered (`reenter`'s `re`) exits and is entered again.
 */
function moved(
  m: __Compiled,
  from: __Snapshot | undefined,
  to: __Snapshot,
): readonly [exits: __Effect[], entries: __Effect[]] {
  const was = from ? __nodes(m, from) : [];
  const is = __nodes(m, to);
  const run = (nodes: __Node[], other: __Node[], i: 0 | 1): __Effect[] => {
    rec = [];
    for (const n of nodes)
      if (!other.some((o) => o.node === n.node) || m.re?.(to, n.node)) {
        const f = m.b?.[n.node]?.[i];
        scope = i === 0 ? n.node : undefined;
        if (f) f(n.data, n.state);
      }
    scope = undefined;
    return take();
  };
  return [run(was.reverse(), is, 1), run(is, was, 0)];
}

type Raise = EffectBy["raise"];
type Step = (m: __Compiled, from: __Snapshot, event: __Event, internal: boolean) => __Result;

/** A raise without a delay: handled in the step. */
const now = (e: __Effect): e is Raise => e.type === "raise" && (e as Raise).delay === undefined;

/**
 * A move from `from` to `to` whose handler recorded `own`: the exits', the handler's and the entries'
 * effects, and each event they raised, stepped through with `step`, in order. A raised event that no
 * state takes is dropped.
 */
function settle(m: __Compiled, from: __Snapshot | undefined, to: __Snapshot, own: __Effect[] | null, step: Step) {
  const fx: __Effect[] = [];
  const queue: __Event[] = [];
  for (let n = 0; ;) {
    if (own) {
      const [exits, entries] = moved(m, from, to);
      for (const e of [...exits, ...own, ...entries])
        if (now(e)) queue.push(e.event);
        else fx.push(e);
    }
    for (;;) {
      const event = queue.shift();
      if (event === undefined) {
        done.add(to);
        return { ok: true as const, snapshot: to, fx };
      }
      if (++n > 100)
        throw new StateError(
          "S61",
          `raised events kept coming after 100 in one step (the last was "${event.type}"): a handler raises an event whose handler raises it again. Stop the loop with a condition, or raise with a delay.`,
        );
      rec = [];
      const r = step(m, to, event, true);
      const left = take();
      if (r.ok) {
        from = to;
        to = r.snapshot;
        // A step through the effects hook has settled its own raises already.
        if (r.fx) {
          fx.push(...r.fx);
          own = null;
        } else own = left;
        break;
      }
    }
  }
}

/** Internal: the step that records (`y: effects.y(inner)`): a hook around the inner one. */
export function __recorded(inner?: __StepHook): __StepHook {
  const raw: Step = (m, from, event, internal) =>
    inner ? inner(own(m), from, event, internal) : __flat(own(m), from, event);
  return (m, from, event, internal) => {
    rec = [];
    const r = raw(m, from, event, internal);
    const mine = take();
    return r.ok ? settle(m, from, r.snapshot, mine, raw) : r;
  };
}

/**
 * Internal: the lifecycle wrap (`r: effects.l(__run(...))`). A move the lifecycle makes that isn't a
 * step (a timer's, a task's error, a child's `done`: no `fx`) is settled before the actor moves, as a
 * step is. A restore (its options carry `run`) is marked, so its first move enters nothing.
 */
export function __settling(inner: __Lifecycle): __Lifecycle {
  return (m, move, current, options) => {
    // `current()` is the actor's first snapshot until its first move, which comes next.
    if (options && "run" in options)
      resumes.set(current(), (options.run?.[""]?.["~fx"] as __Pending[] | undefined) ?? []);
    return inner(
      m,
      (r) => move(r.ok && !r.fx ? settle(m, current(), r.snapshot, take(), __step) : r),
      current,
      options,
    );
  };
}

/** Effects scoped to a node (`""`: the actor) live in its works, and stop with it. */
function keep(ctx: __EffectContext, node: string, work: __Running, id = ""): void {
  const works: __Works | undefined = ctx.live.works;
  let list = works?.get(node);
  if (!list) {
    // The node exited in the same step it was entered (a raise moved on), or the actor ended: clean
    // up at once.
    if (node) return work.stop();
    list = [];
    works?.set(node, list);
  }
  list.push({ id, work });
}

/** Each actor's pending delayed effects that are JSON, for `persist`: a work of its own, `"~fx"`. */
const books = new WeakMap<__Live, Set<__Pending>>();

function book(ctx: __EffectContext): Set<__Pending> {
  let b = books.get(ctx.live);
  if (b === undefined) {
    const set = (b = new Set());
    books.set(ctx.live, set);
    keep(ctx, "", { stop: () => set.clear(), save: () => (set.size > 0 ? [...set] : undefined) }, "~fx");
  }
  return b;
}

/** Internal: runs `send` now, or after `delay` unless cancelled by its id (a development build's runner uses it). */
export function __later(ctx: __EffectContext, e: __Pending["e"], send: () => void): void {
  if (e.delay === undefined) return send();
  // A send to an actor given by reference isn't JSON: it isn't saved.
  const pending: __Pending | undefined =
    typeof (e as { to?: unknown }).to === "object" ? undefined : { e, at: ctx.now() + e.delay };
  const t = setTimeout(() => {
    const list = ctx.live.works?.get("");
    const i = list?.findIndex((w) => w.work === work) ?? -1;
    if (i >= 0) list?.splice(i, 1);
    if (pending) books.get(ctx.live)?.delete(pending);
    send();
  }, e.delay);
  const work = {
    stop: () => {
      clearTimeout(t);
      if (pending) books.get(ctx.live)?.delete(pending);
    },
  };
  if (pending) book(ctx).add(pending);
  keep(ctx, "", work, e.id);
}

/** Internal: a running child, by its name (and key), from the children runner's works. */
export function __child(
  live: __Live,
  name: string,
  key?: string,
): { readonly send: (event: __Event) => unknown } | undefined {
  for (const list of live.works?.values() ?? [])
    for (const { work } of list) {
      // `child` returns the child's actor (../children), which has `send`.
      const a = work.child?.(name, key) as { readonly send: (event: __Event) => unknown } | undefined;
      if (a) return a;
    }
  return undefined;
}

/** This feature's runners, by effect type. */
const runners: __EffectRunners = {
  fn: (e) => {
    const { fn, args } = e as EffectBy["fn"];
    // `enq(fn, ...args)` recorded both: the type layer checked them against each other.
    (fn as (...a: readonly unknown[]) => unknown)(...args);
  },
  raise: (e, ctx) => __later(ctx, e as Raise, () => ctx.deliver((e as Raise).event)),
  sendTo: (e, ctx) => {
    const { to, event, key } = e as EffectBy["sendTo"];
    __later(ctx, e as EffectBy["sendTo"], () =>
      (typeof to === "string" ? __child(ctx.live, to, key) : (to as { readonly send: (e: __Event) => unknown }))?.send(
        event,
      ),
    );
  },
  cancel: (e, ctx) => {
    const list = ctx.live.works?.get("") ?? [];
    for (const w of [...list])
      if (w.id === (e as EffectBy["cancel"]).id) {
        w.work.stop();
        list.splice(list.indexOf(w), 1);
      }
  },
  log: (e) => console.log(...(e as EffectBy["log"]).values),
  effect: (e, ctx) => {
    const { fn, node } = e as EffectBy["effect"];
    const stop = fn();
    if (typeof stop === "function") keep(ctx, node ?? "", { stop: () => stop() });
  },
};

/**
 * The feature each effect type needs, for S60 (an effect whose feature isn't in `use`). Only what
 * differs from the type: the fallback is the type itself, so `emit` and `spawn` (a feature of the
 * same name) need no entry, and the message names them the same either way.
 */
const NEEDS: { readonly [type: string]: string | undefined } = {
  action: "provide",
  stop: "spawn",
  listen: "spawn",
  subscribeTo: "spawn",
};

/**
 * Internal: the dispatcher (`effects.d([effects.q, emit.q, ...])`), from the runner maps of the
 * features in use. It runs a step's effects in order (every move but the first is one: `l` settles
 * the others); for the actor's first move, the start's entries, or a restore's pending delays.
 *
 * @throws StateError S60 for an effect whose feature isn't in `use` (code the type checker didn't see).
 */
export function __dispatcher(maps: readonly __EffectRunners[]): __Dispatcher {
  const all: { [type: string]: __EffectRunners[string] } = Object.assign({}, ...maps);
  return (fx, ctx) => {
    const { live, snapshot } = ctx;
    const m = live.m;
    let raised: readonly __Event[] = [];
    if (!done.has(snapshot) && m) {
      const saved = resumes.get(snapshot);
      if (saved) {
        // A restore: no entry runs again; what was pending is booked with the time it had left.
        resumes.delete(snapshot);
        fx = saved.map(({ e, at }) => ({ ...e, delay: Math.max(0, at - ctx.now()) }));
      } else {
        // The start: its entries.
        const list = [...fx, ...take(), ...moved(m, undefined, snapshot)[1]];
        raised = list.filter(now).map((e) => e.event);
        fx = list.filter((e) => !now(e));
      }
    }
    for (const e of fx) {
      const run = all[e.type];
      if (!run) {
        const f = NEEDS[e.type] ?? e.type;
        throw new StateError(
          "S60",
          `an effect "${e.type}" has no runner: add ${f} to setup's use (import { ${f} } from "@reactre/state/${f}").`,
        );
      }
      run(e, ctx);
    }
    // The actor ended: what it started (delayed events, effects) stops with it.
    if (m?.f?.[snapshot.state]) for (const { work } of live.works?.get("")?.splice(0) ?? []) work.stop();
    for (const event of raised) ctx.deliver(event);
  };
}

/**
 * The start's snapshot and the effects its entries record, unrun: `transition()`'s counterpart for
 * the start (an actor runs them when it starts). Raised events are stepped through, as in a step.
 */
export function initialTransition<D extends Shape>(
  machine: Machine<D>,
  input: ActorInput<D>,
): { readonly snapshot: Snapshot<D>; readonly fx: readonly Effect[] };
export function initialTransition(
  m: __Compiled,
  input: unknown,
): { readonly snapshot: __Snapshot; readonly fx: readonly __Effect[] } {
  return settle(m, undefined, start(m, input), [], __step);
}

// `initial`'s overload types a machine by its shape, which the compiled table doesn't carry.
const start = initial as unknown as (m: __Compiled, input: unknown) => __Snapshot;

/** The effects opt-in: `entry`, `exit`, and `enq` in handlers. `setup({ use: [effects], ... })`. */
export const effects: Effects = {
  enq: /* @__PURE__ */ make([]),
  w: make,
  y: __recorded,
  d: __dispatcher,
  l: __settling,
  q: runners,
};

/** The effects opt-in's type: an interface, so a type error names it `Effects`, not its hooks. */
export interface Effects extends Feature<"effects"> {
  /** Internal: `enq`, what each reference to a handler's `enq` compiles to. */
  readonly enq: unknown;
  /** Internal: `enq` with the methods of the other features in use (`effects.w([emit])`). */
  readonly w: (features: readonly Feature[]) => unknown;
  /** Internal: the step that records (`y: effects.y(inner)`). */
  readonly y: typeof __recorded;
  /** Internal: the dispatcher builder (`r: effects.l(__run(runners, effects.d(maps)))`). */
  readonly d: typeof __dispatcher;
  /** Internal: the lifecycle wrap that settles moves that aren't steps (`r: effects.l(...)`). */
  readonly l: typeof __settling;
  /** Internal: this feature's runners (fn, raise, sendTo, cancel, log, effect). */
  readonly q: __EffectRunners;
}
