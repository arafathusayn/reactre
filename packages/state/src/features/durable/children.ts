// @reactre/state/durable/children (prototype): a durable run's children (the `children` feature's
// `c`, read through its contract, `__Child`). The compiler puts these hooks in the table of a machine
// with durable and children in use (`dk: __reactreStateDurableKids`, an import of its own), so a
// durable run without children ships none of this.
//
// Design decisions:
//   - Each child is journaled under its parent's ids, as XState addresses an actor by the path of
//     ids from the root: the child's address is `${node}#${entry}/${name}` (and `/${key}` for a
//     keyed one, URI-encoded), and its own work's ids start with it:
//     `uploading#1/upload/sending#1/task`. A node entered again starts new children at new
//     addresses, so an old child's late result can't land in the new one.
//   - A child is a durable run of its own inside the parent's: its snapshot, entry counts and
//     pending work are in the parent's durable snapshot under `children`, by address, and the
//     whole tree is saved at once, after every transition anywhere in it. `run.fire(id)` finds the
//     timer in whichever child holds it.
//   - As in an actor: a child starts with its node and stops when the node exits (its timers are
//     cancelled, its task's result dropped); `update` runs on each of its moves and `done` on its
//     final one; a keyed collection is reconciled when the node stays with new data; a child that
//     starts in a final state reports `done` once the parent's entry is done.
//   - A child machine whose start throws (an input its schema refuses) goes to its spec's `error`,
//     once the parent's entry is done; without one, the throw reaches whoever entered the node.
//   - A child that is actor logic (@reactre/state/logic) runs in this process, as an actor of its
//     own, and its whole run is one step the host journals under the child's address
//     (`${address}/active#1/task`): its output goes to the spec's `done`, its failure to `error`. A
//     resumed run whose logic ended gets the recorded end, without running the logic again; one
//     that hadn't ended starts it again from its input (at least once, as a task). Its moves in
//     between (an observable's values) aren't journaled, so `update` doesn't run for it.
//   - What a logic child sends back (`sendBack`) goes to the spec's `on`, by type: each event is a
//     transition of its parent, saved like any other. A logic started again after a resume may
//     send its events again: handle them idempotently.
//   - `durable(child, host)` isn't needed for a child: the parent's opt-in covers its tree.

import { type __Actor, __snap, createActor, StateError } from "../../index.ts";
import type { __Child, __Compiled, __Event, __Leaf, __Node, __Options, __Snapshot, __Step } from "../../internal.ts";
import { __nodes } from "../../run.ts";
import type { __Kids, __Run, __Tree, DurableChild, DurableState } from "./index.ts";

// The overloads type a machine by its shape, which a compiled child's table doesn't carry.
const create = createActor as unknown as (m: __Compiled, options: __Options) => __Actor;

interface Kid {
  readonly run: __Run;
  readonly node: string;
  readonly name: string;
  readonly key: string | undefined;
}

// The children feature's contract: `d`, `u` and `x` take the child's key in a keyed collection only.
type Report = (data: unknown, child: __Leaf, state: string, key: string | undefined) => __Step | null;

/**
 * A logic child as a table a durable run runs: one node, `active`, whose task is the logic's whole
 * run, in this process, ending in `done` (its output) or `error` (what it threw). `sent` gets what
 * it sends back.
 */
function journaled(logic: __Compiled, sent: (event: __Event) => void): __Compiled {
  return {
    v: logic.v,
    e: {},
    i: logic.i,
    o: {
      active: {
        "~done": (_, event) => ({ state: "done", data: { output: Reflect.get(event, "output") }, version: logic.v }),
      },
    },
    f: { done: 1, error: 1 },
    t: {
      active: [
        (data, signal) =>
          new Promise<__Event>((resolve, reject) => {
            // The cast: a logic's `active` data holds its input (../logic's start).
            const actor = create(logic, { input: (data as { readonly input?: unknown }).input, parent: sent });
            const end = (s: __Snapshot): void => {
              // A logic's `done` and `error` hold `{ output }` and `{ error }`.
              if (s.state === "done")
                resolve({ type: "~done", output: Reflect.get(Object(s.data), "output") } as __Event);
              else if (s.state === "error") reject(Reflect.get(Object(s.data), "error"));
            };
            actor.subscribe(end);
            end(actor.snapshot());
            signal.addEventListener("abort", () => actor.stop());
          }),
        (_, error) => ({ state: "error", data: { error }, version: logic.v }),
      ],
    },
  };
}

/** Internal: the children's hooks of a durable run (`dk`). */
export function __kids(t: __Tree): __Kids {
  const all = new Map<__Run, Map<string, Kid>>();
  // Children's reports that wait for their parent's entry to end.
  let later: (() => void)[] = [];
  const of = (r: __Run): Map<string, Kid> => {
    let kids = all.get(r);
    if (kids === undefined) all.set(r, (kids = new Map()));
    return kids;
  };
  const address = (r: __Run, node: string, name: string, key: string | undefined): string =>
    `${t.id(r, node, name)}${key === undefined ? "" : `/${encodeURIComponent(key)}`}`;

  /** `r` decides a step from the leaf under `node` now (dropped once `r` is gone). */
  function decide(r: __Run, node: string, f: (leaf: __Leaf) => __Step | null | undefined): void {
    if (r.gone) return;
    const step = f(t.under(r, node));
    if (step) t.moved(r, __snap(r.m, step, r.current));
  }

  function stopKid(r: __Run, a: string): void {
    const kid = all.get(r)?.get(a);
    if (kid === undefined) return;
    all.get(r)?.delete(a);
    kid.run.gone = true;
    // A logic's run in flight is aborted with its node, which stops its actor.
    for (const n of __nodes(kid.run.m, kid.run.current).reverse())
      if (t.works(kid.run, n.node)) t.stop(kid.run, n.node);
  }

  /** The child run in `r`'s tree that holds timer `timer`. */
  function find(r: __Run, timer: string): __Run | undefined {
    for (const kid of all.get(r)?.values() ?? []) {
      const found = kid.run.timers.has(timer) ? kid.run : find(kid.run, timer);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * Child `name` (`def`) of `r`'s node, at address `a`, its run made by `run` (from its table and
   * the report it makes to `r`): `done` (or a logic's `error`) on its final move, `update` on the
   * others, dropped once either is gone.
   */
  function adopt(
    r: __Run,
    a: string,
    node: string,
    name: string,
    def: __Child,
    key: string | undefined,
    run: (m: __Compiled, report: (s: __Snapshot) => void) => __Run,
  ): Kid {
    const logic = def.m.lg !== undefined;
    const m = logic
      ? journaled(def.m, (event) => {
          const h = def.o?.[event.type];
          if (h) t.serial(() => !kid.run.gone && decide(r, node, (leaf) => h(leaf.data, event, leaf.state, key)));
        })
      : def.m;
    const report = (s: __Snapshot): void => {
      if (kid.run.gone) return;
      const end = m.f?.[s.state] === 1;
      const f: Report | undefined = !end ? (logic ? undefined : def.u) : logic && s.state === "error" ? def.x : def.d;
      // A logic ends with its output (or error) as it is; a machine with its final leaf.
      // The cast: `d`'s output is a machine's final leaf, or, for logic, its output as it is.
      const what = (
        logic ? Reflect.get(Object(s.data), s.state === "error" ? "error" : "output") : { state: s.state, data: s.data }
      ) as __Leaf;
      if (f) decide(r, node, (leaf) => f(leaf.data, what, leaf.state, key));
    };
    const kid: Kid = { run: run(m, report), node, name, key };
    of(r).set(a, kid);
    return kid;
  }

  /** Start child `name` of node `n` with `input`, at its address. */
  function child(r: __Run, n: __Node, name: string, def: __Child, key: string | undefined, input: unknown): void {
    const a = address(r, n.node, name, key);
    let first: __Snapshot;
    try {
      first = __snap(def.m, def.m.i(input));
    } catch (error) {
      // A start that threw (an input its schema refuses): the spec's `error`, after the entry.
      const x = def.x;
      if (x === undefined) throw error;
      later.push(() => decide(r, n.node, (leaf) => x(leaf.data, error, leaf.state, key)));
      return;
    }
    const kid = adopt(r, a, n.node, name, def, key, (m, report) => t.make(m, `${a}/`, first, report));
    t.enter(kid.run, null);
    // Done at its start: it reports once the parent's entry is over, as an actor's child does.
    if (kid.run.m.f?.[kid.run.current.state] === 1) later.push(() => kid.run.report?.(kid.run.current));
  }

  return {
    sync(r, n, fresh) {
      for (const [name, def] of Object.entries(r.m.c?.[n.node] ?? {})) {
        if (def.k === undefined) {
          if (fresh) child(r, n, name, def, undefined, def.i?.(n.data, n.state));
          continue;
        }
        const want = new Map(def.k(n.data, n.state));
        for (const [a, kid] of of(r))
          if (kid.node === n.node && kid.name === name && (kid.key === undefined || !want.has(kid.key))) stopKid(r, a);
        for (const [key, input] of want)
          if (!of(r).has(address(r, n.node, name, key))) child(r, n, name, def, key, input);
      }
    },
    stop(r, node) {
      for (const [a, kid] of all.get(r) ?? []) if (kid.node === node) stopKid(r, a);
    },
    save(r) {
      const kids = all.get(r);
      return kids === undefined || kids.size === 0
        ? undefined
        : Object.fromEntries([...kids].map(([a, kid]) => [a, t.snapshot(kid.run)]));
    },
    find,
    rebuild(r, saved: DurableState) {
      for (const [a, part] of Object.entries(saved.children ?? {})) {
        // `${node}#${entry}/${name}`, then `/${key}` for a keyed child.
        const [ne = "", name = "", encoded] = a.slice(r.at.length).split("/");
        const node = ne.slice(0, ne.lastIndexOf("#"));
        const def = r.m.c?.[node]?.[name];
        if (def === undefined)
          throw new StateError(
            "S1",
            `the snapshot has child "${a}", and state "${node}" runs no child "${name}". Resume it with the machine that saved it.`,
          );
        const key = encoded === undefined ? undefined : decodeURIComponent(encoded);
        adopt(r, a, node, name, def, key, (m, report) => t.rebuild(m, `${a}/`, part satisfies DurableChild, report));
      }
    },
    async rearm(r) {
      for (const kid of all.get(r)?.values() ?? []) await t.rearm(kid.run);
    },
    flush() {
      while (later.length > 0) {
        const now = later;
        later = [];
        for (const report of now) report();
      }
    },
  };
}
