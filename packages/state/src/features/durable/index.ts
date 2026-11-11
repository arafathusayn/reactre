// @reactre/state/durable (prototype): runs a machine on a host that journals (a workflow engine, a
// Durable Object, a queue worker), whose process can die and resume anywhere, with no side effect
// run twice. `durable` is both the opt-in and the function: `setup({ use: [durable], ... })`, then
// `durable(machine, host)`. The app imports it, so an app that runs in-process ships none of it.
//
// Design decisions:
//   - It reuses the pure core: `__step` and `__snap` move the snapshot, and run.ts's `__nodes` and
//     `__changes` say which nodes a move exits and enters, so parents and parallel regions work as
//     they do in an actor. Tasks and timers come from the compiled `t`, `a` and `l` (delays's and
//     timeout's timers, their delays read at entry, a name through `w`). The in-process tasks
//     runner (setTimeout, a promise held in memory) can't survive a crash, so it isn't used.
//   - Ids are deterministic: `${node}#${entry}/task` and `${node}#${entry}/after/${delay}` (the
//     milliseconds, a delay's name, or `fn` for one from the data; `/1`, `/2` for more of the same
//     delay in the node), where `entry` counts the node's entries. The counts are part of the
//     durable snapshot, so a process that resumes from the last save asks the host for the same
//     ids, and the host's journal returns a recorded result instead of running the step again. A
//     timer's id is its delay, not its place: a version that reorders `after`'s keys fires the same
//     handler on a resumed run.
//   - Effects don't run here: an effect isn't journaled. A machine with an entry or exit, or a
//     transition that records one, throws S12 (the type checker refuses it in typed code, M555).
//   - Save first, then the effects. Each transition saves the snapshot (with its pending tasks and
//     timers), then cancels, schedules and starts. A crash in between is safe: on resume, pending
//     timers are scheduled again and pending tasks asked for again, under the same ids, so the host
//     keeps one of each; a timer that was to be cancelled fires into nothing.
//   - Pending work is in the snapshot, not derived: a task whose result was handled while its node
//     stayed active isn't asked for again, and a timer that fired isn't scheduled again.
//   - A late result (a task's, a timer's) after its node exited is dropped: its id is no longer
//     pending. A node entered again gets new ids, so the old entry's result can't land in the new one.
//   - Timers are absolute deadlines, `now() + ms` at entry, saved: a resumed run keeps them.
//   - One transition at a time: sends, fires and task results queue, so each reads the snapshot
//     the last one saved.
//   - A final state ends the run: every active node's work is cancelled, and sends are `inactive`.
//   - A machine without the opt-in (one the type checker didn't see) throws S11, naming the import.
//   - Children are ./children.ts's: the compiler gives a machine with durable and children in use
//     the hooks that journal them (`dk`, `Emitted.imports`), so a run without children ships none
//     of that code. The hooks see this run through `__Tree`, and the root's hooks run the whole tree.

import type {
  Feature,
  Given,
  Input,
  Machine,
  NeedsOptIn,
  NotAny,
  Result,
  SendEvent,
  Shape,
  Snapshot,
  Status,
} from "../../index.ts";
import { __snap, __step, StateError } from "../../index.ts";
import type { __Compiled, __Event, __Leaf, __Node, __Result, __Snapshot } from "../../internal.ts";
import { __nodes } from "../../run.ts";
import type { AnyResumed } from "./types.ts";

/** What a durable run keeps beside the snapshot: enough for another process to resume it. */
export interface DurableState {
  /** How many times each node with a task, a timer or children was entered: the middle of its work's ids. */
  readonly entries: { readonly [node: string]: number };
  /** The pending timers' deadlines (the host's clock), by id. */
  readonly timers: { readonly [id: string]: number };
  /** The pending tasks' ids. */
  readonly tasks: readonly string[];
  /** The running children, by address (`${node}#${entry}/${name}`): each a durable run of its own. */
  readonly children?: { readonly [address: string]: DurableChild };
}

/** A child's part of a durable snapshot: its own snapshot and durable state. */
export interface DurableChild extends DurableState {
  readonly state: string;
  readonly data: unknown;
  readonly version: number;
}

/** What `host.save` stores and `resume` takes: JSON whenever the data is. */
export type DurableSnapshot<D extends Shape> = Snapshot<D> & DurableState;

/** What a journaling host gives a durable run. */
export interface Host<D extends Shape> {
  /** The clock, in milliseconds: timers' deadlines are read from it. */
  readonly now: () => number;
  /**
   * Run `fn` once for `id` and record its result (or its error); when `id` was recorded already,
   * return that without running `fn`. Asked again with the same id after a resume.
   */
  readonly step: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * A durable timer: call the run's `fire(id)` at `at`. Called again with the same id and deadline
   * after a resume: keep one timer per id.
   */
  readonly schedule: (id: string, at: number) => void | Promise<void>;
  /** The timer's node exited: drop it. A `fire` that comes anyway is ignored. */
  readonly cancel: (id: string) => void | Promise<void>;
  /** Store the snapshot. Called after every transition, before its effects; resume from the last one. */
  readonly save: (snapshot: DurableSnapshot<D>) => void | Promise<void>;
}

/** A machine running on a journaling host. */
export interface DurableRun<D extends Shape> {
  /** Enter `start`'s state: save, schedule its timers and run its task. */
  readonly start: (
    ...input: [Input<D>] extends [undefined] ? [input?: undefined] : [input: Input<D>]
  ) => Promise<DurableSnapshot<D>>;
  /** Go on from a saved snapshot (`host.save`'s last): schedule the pending timers, ask for the pending tasks. */
  readonly resume: <S = unknown>(
    this: NotAny<S, AnyResumed>,
    saved: Given<S> & DurableSnapshot<D>,
  ) => Promise<DurableSnapshot<D>>;
  /** Send an event, like `actor.send`. Resolves once the transition is saved. */
  readonly send: (event: SendEvent<D>) => Promise<Result<D>>;
  /**
   * The host's timer `id` is due (the root's, or a child's). Null when it no longer is pending (its
   * node exited, or it fired).
   */
  readonly fire: (id: string) => Promise<Result<D> | null>;
  /** The durable snapshot, as `host.save` last got it. */
  readonly snapshot: () => DurableSnapshot<D>;
  /** "active" until a final state ("done"). */
  readonly status: () => Status;
}

/** Internal: a durable snapshot as the runtime holds it. */
export interface __Durable extends __Snapshot, DurableState {}

interface __Host {
  readonly now: () => number;
  readonly step: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  readonly schedule: (id: string, at: number) => void | Promise<void>;
  readonly cancel: (id: string) => void | Promise<void>;
  readonly save: (snapshot: __Durable) => void | Promise<void>;
}

interface __DurableRun {
  readonly start: (input?: unknown) => Promise<__Durable>;
  readonly resume: (saved: __Durable) => Promise<__Durable>;
  readonly send: (event: __Event) => Promise<__Result>;
  readonly fire: (id: string) => Promise<__Result | null>;
  readonly snapshot: () => __Durable;
  readonly status: () => Status;
}

/** The durable opt-in, and the function that runs a machine that has it on a journaling host. */
export interface Durable extends Feature<"durable"> {
  /**
   * Run a machine on a journaling host: its tasks through `host.step`, its timers through
   * `host.schedule`, its children inside it under its ids, and the snapshot through `host.save`
   * after every transition.
   *
   * @throws StateError S11 for a machine without durable in its `use`.
   */
  <D extends Shape>(
    machine: Machine<D> & NeedsOptIn<D, "durable", "durable(machine, host)">,
    // The machine's shape decides D: a host typed by states and events alone doesn't drop its `use`.
    host: Host<NoInfer<D>>,
  ): DurableRun<D>;
}

/** Internal: one machine of the tree: the root, or a child (at its address, with `/` after it). */
export interface __Run {
  readonly m: __Compiled;
  readonly at: string;
  current: __Snapshot;
  readonly entries: Map<string, number>;
  readonly timers: Map<string, number>;
  readonly tasks: Set<string>;
  /** This process's tasks in flight, to abort when their node exits. */
  readonly running: Map<string, AbortController>;
  /** A child's: tell the parent it moved. */
  readonly report?: (s: __Snapshot) => void;
  /** A child's: stopped (its node exited), so nothing it reports lands. */
  gone: boolean;
}

/** Internal: what a durable run gives its children's hooks (./children.ts). */
export interface __Tree {
  /** A run of `m` at `at`, from `current`; a child's reports to its parent. */
  readonly make: (m: __Compiled, at: string, current: __Snapshot, report?: (s: __Snapshot) => void) => __Run;
  /** `r` is at `r.current`, from `before` (null: it starts): start and stop its nodes' work. */
  readonly enter: (r: __Run, before: __Snapshot | null) => void;
  /** `r` moved to `next` by its own work: enter it, and tell its parent. */
  readonly moved: (r: __Run, next: __Snapshot) => void;
  /** A node of `r` exits: its timers cancelled, its task dropped, its children stopped. */
  readonly stop: (r: __Run, node: string) => void;
  /** The node has work: a task, a timer or children. */
  readonly works: (r: __Run, node: string) => boolean;
  /** The leaf under `r`'s node now. */
  readonly under: (r: __Run, node: string) => __Leaf;
  /** `r`'s work id: `${at}${node}#${entry}/${kind}`. */
  readonly id: (r: __Run, node: string, kind: string) => string;
  readonly snapshot: (r: __Run) => __Durable;
  /** Rebuild a saved run at `at` (its version and state checked). */
  readonly rebuild: (m: __Compiled, at: string, saved: DurableChild, report?: (s: __Snapshot) => void) => __Run;
  /** After a resume: schedule `r`'s pending timers, ask for its pending tasks. */
  readonly rearm: (r: __Run) => Promise<void>;
  /** One transition at a time: `fn` after the last, then `commit`'s save. */
  readonly serial: (fn: () => void) => void;
}

/** Internal: the children's hooks a durable run calls (`dk` in the table, ./children.ts). */
export interface __Kids {
  /** Node `n` of `r` was entered (`fresh`) or stayed with a new leaf: start, or reconcile, its children. */
  readonly sync: (r: __Run, n: __Node, fresh: boolean) => void;
  /** Node `node` of `r` exits: stop its children. */
  readonly stop: (r: __Run, node: string) => void;
  /** `r`'s children's part of its durable snapshot. */
  readonly save: (r: __Run) => DurableState["children"];
  /** The child run in `r`'s tree that holds timer `t`. */
  readonly find: (r: __Run, t: string) => __Run | undefined;
  /** Rebuild `saved`'s children into `r`. */
  readonly rebuild: (r: __Run, saved: DurableState) => void;
  /** After a resume: rearm `r`'s children. */
  readonly rearm: (r: __Run) => Promise<void>;
  /** The end of a turn, before the save: the children's reports that waited for their parent's entry. */
  readonly flush: () => void;
}

/** S12: an effect isn't journaled, so a durable run can't run one. */
const noEffects = (): StateError => new StateError("S12", "effects don't run on a durable host: do it in a task.");

function durableRun(m: __Compiled, host: __Host): __DurableRun {
  if (m.u?.["durable"] !== 1)
    throw new StateError(
      "S11",
      `durable(machine, host) needs durable: add durable to setup's use (import { durable } from "@reactre/state/durable").`,
    );
  // A state's entry or exit (effects's `b`): what its transitions record is refused as they run.
  if (m.b !== undefined) throw noEffects();

  let root: __Run | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  // What the transitions of one turn do after the save, in order.
  let cancels: string[] = [];
  let schedules: (readonly [id: string, at: number])[] = [];
  let launches: (readonly [run: __Run, node: __Node])[] = [];

  // A node has work when its table entry is there: a task (`t`), a timer (`a`, `l`) or children
  // (`c`), each an array or an object, so truthy when present.
  const works = (r: __Run, node: string): boolean =>
    !!(r.m.t?.[node] || r.m.a?.[node] || r.m.l?.[node] || r.m.c?.[node]);
  const id = (r: __Run, node: string, kind: string): string => `${r.at}${node}#${r.entries.get(node) ?? 0}/${kind}`;

  /**
   * A node's timers, `after`'s (`a`) and those resolved at entry (delays's and timeout's, `l`), each
   * with its id's kind: `after/<delay>`, the delay being its milliseconds, a delay's name, or `fn`
   * for one from the data; the n-th more with the same delay is `after/<delay>/<n>`. Not its place
   * in the list: a new version that reorders `after`'s keys fires the same handler on a resumed run.
   */
  function timersOf(r: __Run, node: string) {
    const seen: { [kind: string]: number } = {};
    return [...(r.m.a?.[node] ?? []), ...(r.m.l?.[node] ?? [])].map(([delay, handler]) => {
      const k = `after/${typeof delay === "function" ? "fn" : delay}`;
      const n = (seen[k] = (seen[k] ?? -1) + 1);
      return [n ? `${k}/${n}` : k, delay, handler] as const;
    });
  }

  /** A step that records effects: refused, since an effect isn't journaled (M555 in typed code). */
  function plain<R extends __Result>(result: R): R {
    if (result.ok && result.fx?.length) throw noEffects();
    return result;
  }

  function top(): __Run {
    if (root === undefined)
      throw new StateError("S10", "timer unavailable: await run.start(input) or run.resume(saved).");
    return root;
  }

  function snapshot(r: __Run): __Durable {
    const children = kids?.save(r);
    return {
      ...r.current,
      entries: Object.fromEntries(r.entries),
      timers: Object.fromEntries(r.timers),
      tasks: [...r.tasks],
      ...(children && { children }),
    };
  }

  /** The leaf under `node` now: handlers of timers, errors and children read the current data. */
  function under(r: __Run, node: string): __Leaf {
    return __nodes(r.m, r.current).find((n) => n.node === node) ?? r.current;
  }

  // One at a time, in order: each reads what the last one saved.
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }

  /** A run of `m` at `at`, from `current`. */
  function make(rm: __Compiled, at: string, current: __Snapshot, report?: (s: __Snapshot) => void): __Run {
    return {
      m: rm,
      at,
      current,
      entries: new Map(),
      timers: new Map(),
      tasks: new Set(),
      running: new Map(),
      ...(report && { report }),
      gone: false,
    };
  }

  /** A node exits (or the run ends): cancel its timers, drop its task, stop its children. */
  function stopNode(r: __Run, node: string): void {
    const k = id(r, node, "task");
    r.tasks.delete(k);
    r.running.get(k)?.abort();
    r.running.delete(k);
    for (const [kind] of timersOf(r, node)) {
      const t = id(r, node, kind);
      if (r.timers.delete(t)) cancels.push(t);
    }
    kids?.stop(r, node);
  }

  /** `r` is at `r.current`, from `before`: stop what exited, start what entered, reconcile what stayed. */
  function enter(r: __Run, before: __Snapshot | null): void {
    const next = r.current;
    const done = r.m.f?.[next.state] === 1;
    // The active nodes before and after, computed once (run.ts's `__changes` would walk them again).
    const was = before === null ? [] : __nodes(r.m, before);
    const now = __nodes(r.m, next);
    const exit = was.filter((n) => !now.some((x) => x.node === n.node)).reverse();
    const entered = now.filter((n) => !was.some((x) => x.node === n.node));
    const stay = now.filter((n) => {
      const o = was.find((x) => x.node === n.node);
      return o !== undefined && (o.state !== n.state || o.data !== n.data);
    });
    // A node the move re-entered (reenter's `re`) exits and enters again, as in an actor
    // (../../run.ts): a `to` to the same leaf stays, so its task and timers keep running, but a
    // reenter restarts them. Without this, a retry that reenters its own node would keep the old
    // task and timer, and the new entry would never launch.
    //
    // `re` names the exact node the move re-entered (reenter's mark is the leaf it re-entered), so
    // this is that node alone, not every active node. It is in `now`, so it is never in `exit`, and
    // it is in `before`, so it is never in `entered`: the three sets are disjoint, and a node is
    // stopped and entered once. A reentered node is dropped from `stay`, so its children are
    // reconciled as a fresh entry, not twice.
    // The nodes come from `next`, not `before`: a reentered node's data is the new data, so its
    // timers and children read it (a child's input is the new one, not the old entry's).
    const reentered = before === null ? [] : now.filter((n) => r.m.re?.(next, n.node));
    for (const n of done && before !== null ? was.reverse() : [...exit, ...reentered])
      if (works(r, n.node)) stopNode(r, n.node);
    if (done) return;
    for (const n of [...entered, ...reentered]) {
      if (!works(r, n.node)) continue;
      r.entries.set(n.node, (r.entries.get(n.node) ?? 0) + 1);
      // A delay is read at entry, from the data then: a delay's name in `w`, or a function of the data.
      for (const [kind, delay] of timersOf(r, n.node)) {
        const d = typeof delay === "string" ? r.m.w?.[delay] : delay;
        const t = id(r, n.node, kind);
        const at = host.now() + (typeof d === "function" ? d(n.data, n.state) : (d ?? 0));
        r.timers.set(t, at);
        schedules.push([t, at]);
      }
      if (r.m.t?.[n.node] !== undefined) {
        r.tasks.add(id(r, n.node, "task"));
        launches.push([r, n]);
      }
      kids?.sync(r, n, true);
    }
    for (const n of stay) if (!reentered.some((x) => x.node === n.node)) kids?.sync(r, n, false);
  }

  /** `r` moved to `next` by its own work (an event, a timer, a task, a child): enter it, and tell its parent. */
  function moved(r: __Run, next: __Snapshot): void {
    const before = r.current;
    r.current = next;
    enter(r, before);
    r.report?.(next);
  }

  /** Ends a turn: the children's waiting reports, then save the tree, then the effects, in order. */
  async function commit(): Promise<void> {
    kids?.flush();
    const [c, s, l] = [cancels, schedules, launches];
    [cancels, schedules, launches] = [[], [], []];
    await host.save(snapshot(top()));
    for (const t of c) await host.cancel(t);
    for (const [t, at] of s) await host.schedule(t, at);
    for (const [r, n] of l) launch(r, n);
  }

  /** Ask the host for the node's task: it runs once per id, and its result comes back through the queue. */
  function launch(r: __Run, n: __Node): void {
    const task = r.m.t?.[n.node];
    if (task === undefined) return;
    const k = id(r, n.node, "task");
    const controller = new AbortController();
    r.running.set(k, controller);
    host
      .step(k, () => task[0](n.data, controller.signal, n.state))
      .then(
        (event) => serial(() => settle(r, k, n.node, event, undefined)),
        (error: unknown) => serial(() => settle(r, k, n.node, undefined, error)),
      );
  }

  /** A task's outcome: its event, or its error. Dropped when the task is no longer pending. */
  async function settle(r: __Run, k: string, node: string, event: __Event | undefined, error: unknown): Promise<void> {
    const task = r.m.t?.[node];
    if (r.gone || !r.tasks.delete(k) || task === undefined) return;
    r.running.delete(k);
    if (event !== undefined) {
      const result = plain(__step(r.m, r.current, event, true));
      if (result.ok) {
        moved(r, result.snapshot);
        return commit();
      }
      // Unhandled or declined: nothing moves, but the task is no longer pending.
      if (result.reason !== "invalid") return commit();
      error = result.error; // S6 or S23, from the validate feature's step
    }
    const leaf = under(r, node);
    moved(r, __snap(r.m, task[1](leaf.data, error, leaf.state), r.current));
    return commit();
  }

  /** Rebuild `saved`'s run at `at`, its children included. */
  function rebuild(rm: __Compiled, at: string, saved: DurableChild, report?: (s: __Snapshot) => void): __Run {
    const { state, data, version } = saved;
    if (version !== rm.v)
      throw new StateError(
        "S2",
        `the snapshot${at === "" ? "" : ` of child "${at.slice(0, -1)}"`} is of version ${version}, and the machine is at version ${rm.v}. Migrate its data to the new shape, then resume.`,
      );
    if (rm.o[state] === undefined && rm.f?.[state] !== 1)
      throw new StateError("S1", `there is no state "${state}". States: ${Object.keys(rm.o).join(", ")}.`);
    const r = make(rm, at, __snap(rm, { state, data, version }, saved), report);
    for (const [k, v] of Object.entries(saved.entries)) r.entries.set(k, v);
    for (const [k, v] of Object.entries(saved.timers)) r.timers.set(k, v);
    for (const k of saved.tasks) r.tasks.add(k);
    kids?.rebuild(r, saved);
    return r;
  }

  /** After a resume: schedule every pending timer, and ask for every pending task, in the whole tree. */
  async function rearm(r: __Run): Promise<void> {
    for (const [t, at] of r.timers) await host.schedule(t, at);
    for (const n of __nodes(r.m, r.current)) if (r.tasks.has(id(r, n.node, "task"))) launch(r, n);
    await kids?.rearm(r);
  }

  // The children's hooks, for a machine with children (`dk`), made anew for each start and resume.
  const tree: __Tree = {
    make,
    enter,
    moved,
    stop: stopNode,
    works,
    under,
    id,
    snapshot,
    rebuild,
    rearm,
    serial: (fn) =>
      void serial(() => {
        fn();
        return commit();
      }),
  };
  let kids: __Kids | undefined;

  return {
    start: (input) =>
      serial(async () => {
        if (root !== undefined) root.gone = true;
        cancels = [];
        schedules = [];
        launches = [];
        kids = m.dk?.(tree);
        const r = make(m, "", __snap(m, m.i(input)));
        root = r;
        enter(r, null);
        await commit();
        return snapshot(r);
      }),
    resume: (saved) =>
      serial(async () => {
        if (root !== undefined) root.gone = true;
        kids = m.dk?.(tree);
        const r = rebuild(m, "", saved);
        root = r;
        await rearm(r);
        return snapshot(r);
      }),
    send: (event) =>
      serial(async (): Promise<__Result> => {
        const r = top();
        if (m.f?.[r.current.state] === 1) return { ok: false, reason: "inactive", snapshot: r.current };
        const result = plain(__step(m, r.current, event, false));
        if (result.ok) {
          moved(r, result.snapshot);
          await commit();
        }
        return result;
      }),
    fire: (t) =>
      serial(async (): Promise<__Result | null> => {
        const at = top();
        const r = at.timers.has(t) ? at : kids?.find(at, t);
        if (r === undefined) return null;
        for (const n of __nodes(r.m, r.current)) {
          const handler = timersOf(r, n.node).find(([kind]) => id(r, n.node, kind) === t)?.[2];
          if (handler === undefined) continue;
          r.timers.delete(t);
          moved(r, __snap(r.m, handler(n.data, n.state), r.current));
          await commit();
          return { ok: true, snapshot: top().current };
        }
        return null;
      }),
    snapshot: () => snapshot(top()),
    status: () => (m.f?.[top().current.state] === 1 ? "done" : "active"),
  };
}

/**
 * `setup({ use: [durable], ... })`, then `durable(machine, host)`: the machine on a journaling host.
 */
// A cast: `durableRun` takes the compiled table and the host as the runtime sees them; the signature
// above is the app's.
export const durable: Durable = durableRun as unknown as Durable;
