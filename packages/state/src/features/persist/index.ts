// @reactre/state/persist (prototype): `persist(actor)`, an actor's snapshot with what its running
// nodes saved: each pending timer's deadline, each child's snapshot. `restoreActor` takes it back,
// so timers wait only what is left and children resume instead of starting fresh. Also the stored
// snapshot's JSON shape (`PersistedJSON`), migrations between versions (`migrations`), and the
// backend-workflow step (`processEvent`): restore, process one event, persist.
//
// `persist` is both the opt-in and the function: `setup({ use: [persist], ... })`, then
// `persist(actor)`. With it in use, the compiler gives the machine the general lifecycle with this
// feature's tasks runner (`r: __run([persist.t, ...])`), which saves timers' absolute deadlines; the
// core's lean runner (../../tasks.ts) saves nothing, so an app that never persists ships none of it.
// `migrations` and `processEvent` need the opt-in too: they read what persist saves.
//
// Design decisions:
//   - Each runner saves its own part, by node and by runner id (`run: { saving: { t: [deadline] } }`),
//     and gets the same part back as `saved` on restore: this module knows no other runner's format.
//   - A timer's deadline is absolute (`now() + ms` at entry), and `save` gives the pending ones,
//     so a restored actor waits only what is left, and an overdue timer fires at once. A fired
//     timer saves as null, so a node that stayed active doesn't fire it again after a restore.
//   - The task isn't saved: it restarts on restore (a durable host journals it instead: ../durable).
//   - The result is JSON whenever the data is (data is JSON by type): store it as it is.
//   - A machine without the opt-in (one the type checker didn't see) throws S11, naming the import.
//
// Migrations (XState's `machineVersions` and `migrateSnapshot`), shaped differently:
//   - The version is setup's `version`, a number, and every snapshot carries it: there is no
//     unversioned snapshot and no machine `id`, so no `unversioned` policy and no `'*'` route.
//   - One step per version, from each version to the next, written newest first:
//     `migrations(machine).from<1, { idle: {}; saving: { text: string } }>(({ state, data, to }) => ...)`.
//     The old version's states are a type (`types<T>()` is for setup, and a type is all a step
//     needs), and each step builds the next version's snapshot with that version's `to`, so its
//     data is exact, as in a transition: the last step's `to` is the machine's own. XState migrates
//     straight to the target and validates with snapshot schemas; here each step is typed by the
//     version after it, so the type checker holds the whole chain, and no schema is needed.
//   - A step is synchronous and pure, like a transition: data in, data out.
//   - A migrated snapshot starts its state's work anew: `run` (deadlines by timer position in the
//     old node) and `history` describe the old version's nodes, and are dropped.
//   - Event histories (`adaptEvents`) aren't offered: the library keeps snapshots, not event logs.
//
// The stored JSON (`PersistedJSON`) is checked by `migrations(machine)(stored)` before anything
// reads it: its fields' types, JSON values only (no Date, Map or undefined from a driver), and a
// version the machine can reach. A problem throws S20, naming the path; restoreActor then checks the
// state's name (S1) and its schema (S7).
//
// Backend workflows (`backend-workflows.md`): `processEvent(machine, stored, event)` restores the
// stored snapshot (migrating it) or starts a new actor, sends one event, persists and stops. It is
// synchronous: the host owns storage, one request at a time per entity, and idempotency keys.

import {
  type __Actor,
  __snap,
  type Actor,
  type ActorInput,
  type ActorOptions,
  type AnyNext,
  createActor,
  type DeepReadonly,
  type Feature,
  type Machine,
  type NeedsOptIn,
  restoreActor,
  type Result,
  type SendEvent,
  type Shape,
  type Snapshot,
  StateError,
  type To,
  type Type,
} from "../../index.ts";
import type {
  __Compiled,
  __Event,
  __Leaf,
  __Options,
  __Persisted,
  __Result,
  __Runner,
  __Snapshot,
  __Step,
  __To,
} from "../../internal.ts";
import { __wait } from "../../wait.ts";
import type { NotText, NoWork, OldStates } from "./types.ts";

/** A snapshot, with what each running node saved: give it to `restoreActor`. */
export type Persisted<D extends Shape> = Snapshot<D> & { readonly run?: __Persisted["run"] };

/** A JSON value. */
export type JSONValue = null | boolean | number | string | readonly JSONValue[] | { readonly [key: string]: JSONValue };

/**
 * A persisted snapshot as stored: what `persist(actor)` returns, through `JSON.stringify`. The
 * version and state are checked against the machine when it is read back (`migrations`).
 */
export interface PersistedJSON {
  /** The leaf, or a parallel node (then `data` is its regions: `{ [region]: { state, data } }`). */
  readonly state: string;
  /** The state's data: a JSON object. */
  readonly data: { readonly [field: string]: JSONValue };
  /** setup's `version` when it was saved. */
  readonly version: number;
  /** For each parent the machine goes `back` to, the leaf it held when it was last left. */
  readonly history?: { readonly [parent: string]: { readonly state: string; readonly data: JSONValue } };
  /** What each running node saved, by node and then by runner (a timer's deadlines, a child's snapshot). */
  readonly run?: { readonly [node: string]: { readonly [runner: string]: JSONValue } };
}

/** Internal: the tasks runner of a machine with persist: timers with deadlines that are saved. */
export const __saved: __Runner = {
  id: "t",
  start(m, { node, state, data }, ctx) {
    const task = m.t?.[node];
    const after = m.a?.[node];
    if (task === undefined && after === undefined) return null;
    const controller = new AbortController();
    if (task !== undefined) {
      const fail = (error: unknown): void => {
        const now = ctx.current();
        ctx.go(task[1](now.data, error, now.state));
      };
      task[0](data, controller.signal, state).then((event) => {
        const r = ctx.deliver(event);
        if (r?.ok === false && r.error) fail(r.error);
      }, fail);
    }
    // Each timer's deadline, or null once it fired. The cast: `saved` is what `save` below returned
    // for this node (through JSON), and the core checked the snapshot's version.
    const saved = ctx.saved as readonly (number | null)[] | undefined;
    const pending: (number | null)[] = [];
    // `__wait`, not setTimeout: a deadline past 2^31 − 1 ms away fires at once with setTimeout.
    const timers = (after ?? []).map(([ms, handler], i) => {
      const was = saved?.[i];
      const at = (pending[i] = was === undefined ? ctx.now() + ms : was);
      return at === null
        ? undefined
        : __wait(at - ctx.now(), () => {
            pending[i] = null;
            const now = ctx.current();
            ctx.go(handler(now.data, now.state));
          });
    });
    return {
      stop() {
        controller.abort();
        for (const cancel of timers) cancel?.();
      },
      save: () => [...pending],
    };
  },
};

// #region persist(actor)

/**
 * The persist opt-in, and the function that persists an actor of a machine that has it.
 *
 * @throws StateError S11 for a machine without persist in its `use`; S28 for a stopped actor.
 */
export interface Persist extends Feature<"persist"> {
  /** The actor's snapshot, with its timers' deadlines and its children's snapshots, for `restoreActor`. */
  <D extends Shape>(actor: Actor<D> & NeedsOptIn<D, "persist", "persist(actor)">): Persisted<D>;
  /** Internal: the tasks runner that saves deadlines. */
  readonly t: __Runner;
}

/** S11: `what` on a machine without the opt-in. */
function optIn(m: __Compiled | undefined, what: string): void {
  if (m?.u?.["persist"] !== 1)
    throw new StateError(
      "S11",
      `${what} needs persist in setup's use (import { persist } from "@reactre/state/persist").`,
    );
}

// `"~r"` is optional here only because the public `Actor` doesn't name it; every actor has it.
function save(actor: Pick<__Actor, "snapshot" | "status"> & Partial<Pick<__Actor, "~r">>): __Persisted {
  const live = actor["~r"];
  optIn(live?.m, "persist(actor)");
  // M264: a stopped actor's snapshot restores into an actor that runs again, which is not what the
  // app stopped. Refuse it, naming the fix, rather than save a snapshot that lies about the run.
  if (actor.status() === "stopped")
    throw new StateError(
      "S28",
      "persist(actor) was given a stopped actor: its snapshot would restore into a running one. Save before stop().",
    );
  const snapshot = actor.snapshot();
  const run: { [node: string]: { [runner: string]: unknown } } = {};
  for (const [node, list] of live?.works ?? [])
    for (const { id, work } of list) {
      const part = work.save?.();
      if (part !== undefined) (run[node] ??= {})[id] = part;
    }
  // A node in `run` is a runner that saved: the same test as a flag, without the flag.
  for (const _ in run) return { ...snapshot, run };
  return snapshot;
}

/**
 * `setup({ use: [persist], ... })`, then `persist(actor)`: the snapshot with what each running node
 * saved, JSON, for `restoreActor(machine, saved, { now })`.
 *
 * @throws StateError S11 for an actor whose machine doesn't have persist in its `use`.
 */
// A cast: `save`'s parameter is the runtime's view of an actor; the signature above is the app's.
export const persist: Persist = /* @__PURE__ */ Object.assign(save, { t: __saved }) as unknown as Persist;

// #endregion

// #region The stored JSON

/** S20: the stored value isn't a persisted snapshot; `path` says where. */
function malformed(path: string, problem: string): StateError {
  return new StateError(
    "S20",
    `not a stored snapshot: ${path} ${problem}. Save it with JSON.stringify and read it with JSON.parse.`,
  );
}

/** Checks that `value` is a JSON value: plain objects, arrays, strings, finite numbers, booleans, null. */
function json(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw malformed(path, `is ${value}, which JSON can't hold, and a snapshot holds JSON values only`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => json(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      for (const [k, v] of Object.entries(value)) json(v, `${path}.${k}`);
      return;
    }
    // The proto is already here: its constructor names the class, for the same diagnostic.
    const name: unknown = proto?.constructor?.name;
    throw malformed(
      path,
      `is a ${typeof name === "string" && name ? name : "class instance"}, and a snapshot holds JSON values only`,
    );
  }
  throw malformed(
    path,
    `is ${typeof value === "undefined" ? "undefined" : `a ${typeof value}`}, and a snapshot holds JSON values only`,
  );
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `{ state, data }` pair at `path`. */
function leaf(value: unknown, path: string): __Leaf {
  if (!isObject(value)) throw malformed(path, "isn't an object with state and data");
  const { state, data } = value;
  if (typeof state !== "string") throw malformed(`${path}.state`, "isn't a state's name (a string)");
  if (!isObject(data)) throw malformed(`${path}.data`, "isn't an object (a state's data is one: {} for none)");
  return { state, data };
}

/**
 * Internal: `stored` as a persisted snapshot (`PersistedJSON`): its fields' types, JSON values
 * only. The version and state aren't checked against a machine here.
 *
 * @throws StateError S20, naming the path.
 */
export function __parse(stored: unknown): __Persisted {
  json(stored, "snapshot");
  // leaf() first: a non-object (null, a string) is refused as that, not as a version.
  const out: { -readonly [K in keyof __Persisted]: __Persisted[K] } = {
    ...leaf(stored, "snapshot"),
    version: (stored as { readonly version: number }).version,
  };
  // Number.isInteger is false for anything that isn't a number, so it is the type check too.
  if (!Number.isInteger(out.version) || out.version < 0)
    throw malformed("snapshot.version", "isn't setup's version (a whole number, 0 when setup has none)");
  const history = (stored as { readonly [key: string]: unknown })["history"];
  if (history !== undefined) {
    if (!isObject(history)) throw malformed("snapshot.history", "isn't an object of parents");
    // fromEntries, not `kept[parent] = ...`: a "__proto__" key (JSON.parse keeps it as own data) must
    // stay an own property, not set the prototype of a plain {}.
    out.history = Object.fromEntries(
      Object.entries(history).map(([parent, at]) => [parent, leaf(at, `snapshot.history.${parent}`)]),
    );
  }
  const run = (stored as { readonly [key: string]: unknown })["run"];
  if (run !== undefined) {
    if (!isObject(run) || !Object.entries(run).every(([, parts]) => isObject(parts)))
      throw malformed("snapshot.run", "isn't an object of nodes, each an object of runners' parts");
    out.run = run as NonNullable<__Persisted["run"]>; // checked just above: nodes, each an object
  }
  return out;
}

// #endregion

// #region Migrations

/** A shape for an old version's states, so its `to` is typed as a machine's is. */
type OldShape<S> = { readonly states: { readonly [K in keyof S]: Type<S[K] & object> }; readonly events: {} };

/** What a step from an old version gets: each old state with its data, and the next version's `to`. */
type StepArgs<S, N extends Shape> = {
  [K in keyof S & string]: { readonly state: K; readonly data: DeepReadonly<S[K]>; readonly to: To<N> };
}[keyof S & string];

/** The version before `V`: never for 0. */
type Down<V extends number, T extends readonly unknown[] = []> = [...T, unknown]["length"] extends V
  ? T["length"]
  : T["length"] extends V
    ? never
    : Down<V, [...T, unknown]>;

/** The machine's version: setup's `version`, 0 without one. */
type VersionOf<D extends Shape> = D extends { readonly version: infer V extends number } ? V : 0;

/**
 * Reads a stored snapshot (`unknown`, from JSON) into one `restoreActor` takes, migrating it from an
 * older version one step at a time. Add a step per old version with `.from`, newest first.
 *
 * @throws StateError S20 for a value that isn't a persisted snapshot (naming the path), S21 for a
 *   version with no step from it, S22 for a version newer than the machine's.
 */
export interface Migrate<D extends Shape, N extends Shape = D, V extends number = VersionOf<D>> {
  <St = unknown>(stored: St & NotText<St>): Persisted<D>;
  /**
   * A step from version `F` (the version before the last step's, or the machine's), whose states
   * and data are `S`: `({ state, data, to }) => to(...)`, with the next version's `to`.
   */
  readonly from: <F extends number, S extends { readonly [state: string]: object }>(
    this: OldStates<S>,
    step: [Down<V>] extends [never]
      ? `version ${V} is the first: there is no version before it to migrate from`
      : [F] extends [Down<V>]
        ? (args: StepArgs<S, N>) => AnyNext<N>
        : `migrations go one version at a time, newest first: after the step to version ${V}, the next is .from<${Down<V>}, { ...its states }>(...)`,
  ) => Migrate<D, OldShape<S>, F>;
}

interface __Migrate {
  (stored: unknown): __Persisted;
  readonly from: (step: (args: { state: string; data: unknown; to: typeof to }) => __Step) => __Migrate;
}

/**
 * `to` in a migration step: the step a transition's `to(state, data)` compiles to. Its version is
 * set where the step is taken: the version it migrates to.
 */
const to = (state: string, data: unknown = {}): __To => ({ state, data, version: 0 });

function migrator(m: __Compiled, steps: readonly ((args: never) => __Step)[]): __Migrate {
  const migrate = (stored: unknown): __Persisted => {
    let s: __Persisted = __parse(stored);
    if (s.version > m.v)
      throw new StateError(
        "S22",
        `the snapshot is of version ${s.version}, newer than the machine's ${m.v}: a later build wrote it. Restore it with that build, or discard it and createActor.`,
      );
    while (s.version < m.v) {
      // A step's parameter type is its own version's states; here it gets the stored snapshot. Steps
      // are written newest first, so the one from `s.version` sits at `m.v - 1 - s.version`.
      const step = steps[m.v - 1 - s.version] as
        ((args: { state: string; data: unknown; to: typeof to }) => __Step) | undefined;
      if (step === undefined)
        throw new StateError(
          "S21",
          `the snapshot is of version ${s.version}, and nothing migrates it: ${steps.length === 0 ? "migrations(machine) has no steps" : `the steps go from version ${m.v - steps.length} up to ${m.v}`}. Add .from<${s.version}, { ...its states }>() to migrations(machine), or discard the snapshot and createActor.`,
        );
      // The cast: a migration's `to` makes a `to` step (it has no back or reenter).
      const next = step({ state: s.state, data: s.data, to }) as __To;
      const at: __To = { state: next.state, data: next.data, version: s.version + 1 };
      s = at.version === m.v ? __snap(m, at) : at;
    }
    return s;
  };
  return Object.assign(migrate, {
    from: (step: (args: never) => __Step) => migrator(m, [...steps, step]),
  });
}

/**
 * `migrations(machine)`: reads stored snapshots for `restoreActor`, checking their JSON (S20) and
 * migrating older versions. Add one step per old version, newest first:
 *
 * ```ts
 * const migrate = migrations(jobMachine) // at version 2
 *   .from<1, { idle: {}; saving: { text: string } }>(({ state, data, to }) =>
 *     state === "saving" ? to("saving", { text: data.text, tries: 0 }) : to("idle"));
 * restoreActor(jobMachine, migrate(JSON.parse(stored)));
 * ```
 *
 * @throws StateError S11 for a machine without persist in its `use`.
 */
export function migrations<D extends Shape>(
  machine: Machine<D> & NeedsOptIn<D, "persist", "migrations(machine)">,
): Migrate<D>;
// The implementation's result is the runtime's view (`__Migrate`); the overload's is the app's, whose
// snapshot type depends on D, so the two are related only through `unknown`.
export function migrations(m: __Compiled): unknown {
  optIn(m, "migrations(machine)");
  return migrator(m, []);
}

// #endregion

// #region Backend workflows

/** What `processEvent` returns: the event's result, and the snapshot to store. */
export interface Processed<D extends Shape> {
  readonly result: Result<D>;
  /** Store it: the next request passes it back as `stored`. */
  readonly saved: Persisted<D>;
}

/** `processEvent`'s options: the actor's (input for a new one, the clock), and the migrations. */
export type ProcessOptions<D extends Shape> = ActorOptions<D> & {
  /** Reads the stored snapshot: `migrations(machine).from(...)`. Without it, `migrations(machine)`. */
  readonly migrate?: (stored: unknown) => Persisted<D>;
};

/**
 * One request of a backend workflow: restore the entity's stored snapshot (migrating it), or start
 * a new actor when nothing is stored; send the event; persist; stop. Store `saved`, and pass it back
 * as `stored` next time. Run one request at a time per entity (a row lock, a per-key queue, or a
 * compare-and-set on the version you read), and drop events whose idempotency key you've applied.
 *
 * ```ts
 * const { result, saved } = processEvent(orderMachine, row?.snapshot, event, { input: { orderId } });
 * await db.orders.save(orderId, saved);
 * ```
 *
 * @throws StateError S11 for a machine without persist in its `use`; S20, S21, S22 from `migrate`;
 *   S1, S7 from `restoreActor`.
 */
export function processEvent<D extends Shape, St = unknown>(
  machine: Machine<D> & NeedsOptIn<D, "persist", "processEvent(machine, stored, event)"> & NoWork<D>,
  stored: St & NotText<St>,
  event: SendEvent<D>,
  ...options: [ActorInput<D>] extends [undefined] ? [options?: ProcessOptions<D>] : [options: ProcessOptions<D>]
): Processed<D>;
export function processEvent(
  m: __Compiled,
  stored: unknown,
  event: __Event,
  options?: __Options & { readonly migrate?: (stored: unknown) => unknown },
): { readonly result: __Result; readonly saved: __Persisted } {
  optIn(m, "processEvent(machine, stored, event)");
  // `migrate` is a `Migrate` of this machine: what it returns is a persisted snapshot.
  const migrate = (options?.migrate ?? migrator(m, [])) as (stored: unknown) => __Persisted;
  // The overloads type a machine by its shape; the runtime's view is the compiled table.
  const actor =
    stored === undefined || stored === null
      ? (createActor as unknown as (m: __Compiled, o?: __Options) => __Actor)(m, options)
      : (restoreActor as unknown as (m: __Compiled, s: __Snapshot, o?: __Options) => __Actor)(
          m,
          migrate(stored),
          options?.now === undefined ? undefined : { now: options.now },
        );
  const result = actor.send(event);
  const saved = save(actor);
  actor.stop();
  return { result, saved };
}

// #endregion
