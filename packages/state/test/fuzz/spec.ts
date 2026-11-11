// The fuzz lane's machine spec: a machine as data, before it is source or a table. A generator
// makes one from a seed; the renderer (./generate.ts) writes it as valid TypeScript, and the
// reference evaluator (./reference.ts) runs it without the compiler or the runtime. The spec is the
// contract both sides are held to, so a disagreement is a bug in one of them, never in the spec.
//
// Design decisions:
//   - Data is a flat record of numbers and strings only. That keeps the reference's data rules
//     (copy on write, JSON) small enough to be obviously right, and keeps every generated machine
//     inside the compiler's data contract (an object literal, no shared module values).
//   - A handler is one of a few shapes the reference can evaluate exactly: a move to a state with
//     data built from `data` and `event`, a guard that declines, or a guard that moves. Nothing
//     here needs a function the reference can't see.
//   - Every state is reachable from `start` by construction (the generator only targets states it
//     has already made reachable), so a generated machine is a machine a person could write.

/** A field of a state's data or an event's payload: a number or a string. */
export type Field = { readonly name: string; readonly kind: "number" | "string" };

/** How a handler builds the data of the state it moves to. */
export type DataExpr =
  | { readonly kind: "none" }
  /** `{ ...data, <field>: <value> }`: the state's data is the current data with one field set. */
  | { readonly kind: "set"; readonly field: string; readonly value: ValueExpr }
  /** `{ <field>: <value>, ... }`: a fresh object with exactly the state's fields. */
  | { readonly kind: "fresh"; readonly fields: readonly { readonly name: string; readonly value: ValueExpr }[] };

/** A value a handler can compute: a literal, a field of data, or a field of the event. */
export type ValueExpr =
  | { readonly kind: "literal"; readonly value: number | string }
  | { readonly kind: "data"; readonly field: string }
  | { readonly kind: "event"; readonly field: string }
  /** `data.<field> + <n>` for a number field: a counter that grows, so a walk can bound it. */
  | { readonly kind: "plus"; readonly field: string; readonly by: number };

/** A guard: the handler moves only when it holds, and declines (`null`) otherwise. */
export type Guard =
  | { readonly kind: "always" }
  /** `event.<field> === <literal>` */
  | { readonly kind: "eventIs"; readonly field: string; readonly value: number | string }
  /** `data.<field> > <n>` */
  | { readonly kind: "dataAbove"; readonly field: string; readonly n: number }
  /** `data.<field> === <literal>` */
  | { readonly kind: "dataIs"; readonly field: string; readonly value: number | string };

/**
 * One transition: from a state, on an event, when the guard holds, to a state with data. `from` may
 * be a parent ("edit" of "edit.draft"): its handler applies to every leaf under it, after the
 * leaf's own, and a `null` from the leaf bubbles on to it.
 */
export interface Transition {
  readonly from: string;
  readonly event: string;
  readonly guard: Guard;
  readonly to: string;
  readonly data: DataExpr;
}

/** The nodes from the root down to `name`: "a.b.c" is ["a", "a.b", "a.b.c"]. */
export function chain(name: string): string[] {
  const parts = name.split(".");
  return parts.map((_, i) => parts.slice(0, i + 1).join("."));
}

/** The parents of a leaf, innermost first: "a.b.c" is ["a.b", "a"]. */
export function parents(name: string): string[] {
  return chain(name).slice(0, -1).reverse();
}

/** Whether `state` is `node` or under it. */
export function within(state: string, node: string): boolean {
  return state === node || state.startsWith(`${node}.`);
}

/**
 * A task on a state: `run` resolves to an internal event after `ms` (or rejects, when `fails`), and
 * `error` moves to `onError`. The reference models the timing exactly: the event arrives `ms` after
 * the state is entered, and a rejection arrives the same way, to `error`.
 */
export interface Task {
  readonly state: string;
  /** The internal event `run` resolves to. */
  readonly event: string;
  /** The payload the event carries. */
  readonly payload: readonly { readonly name: string; readonly value: number | string }[];
  /** How long the task takes, in milliseconds. */
  readonly ms: number;
  /** The task rejects instead of resolving. */
  readonly fails: boolean;
  /** Where a failure goes. */
  readonly onError: string;
}

/** A timer on a state: `after: { "<ms>ms": ... }` moves to `to` when it fires. */
export interface Timer {
  readonly state: string;
  readonly ms: number;
  readonly to: string;
  readonly data: DataExpr;
}

/**
 * A parallel node: its regions, each a small machine of its own, all in a leaf at once. The node's
 * snapshot is `{ state: node, data: { <region>: { state, data }, ... } }`, and an event is offered
 * to each region in order, then to the node's own handlers. When every region is in a final leaf,
 * the node's `done` moves the whole unit.
 */
export interface Parallel {
  /** The node's name: its leaves are `<node>.<region>.<leaf>`. */
  readonly node: string;
  readonly regions: readonly {
    readonly name: string;
    /** The region's leaves, in the order the generator made them; the first is where it starts. */
    readonly leaves: readonly string[];
    /** The leaf the region starts in. */
    readonly start: string;
    /** The data the region's start leaf is entered with (its fields, as literals). */
    readonly startData: readonly { readonly name: string; readonly value: number | string }[];
  }[];
  /** Where the node's `done` moves when every region has ended. */
  readonly done: string;
}

/** A machine as data: its states and their data, its events and their payloads, its transitions. */
export interface Spec {
  /** The seed that made it: a failure reruns with it. */
  readonly seed: number;
  readonly version: number;
  /** Each state's data fields, by state name. */
  readonly states: readonly { readonly name: string; readonly fields: readonly Field[] }[];
  /** Each event's payload fields, by event name. */
  readonly events: readonly { readonly name: string; readonly fields: readonly Field[] }[];
  /** The start state and the data it starts with. */
  readonly start: {
    readonly state: string;
    readonly data: readonly { readonly name: string; readonly value: number | string }[];
  };
  /** The final states: an actor there is done. */
  readonly final: readonly string[];
  readonly transitions: readonly Transition[];
  /** The states' tasks (async work that resolves to an internal event). */
  readonly tasks?: readonly Task[];
  /** The states' timers. */
  readonly timers?: readonly Timer[];
  /** The parallel node, when the machine has one. */
  readonly parallel?: Parallel;
}

/** A state's fields, by name. */
export function fieldsOf(spec: Spec, state: string): readonly Field[] {
  return spec.states.find((s) => s.name === state)?.fields ?? [];
}

/** An event's payload fields, by name. */
export function payloadOf(spec: Spec, event: string): readonly Field[] {
  return spec.events.find((e) => e.name === event)?.fields ?? [];
}

/** The task on `state`, if any. */
export function taskOf(spec: Spec, state: string): Task | undefined {
  return spec.tasks?.find((t) => t.state === state);
}

/** The timers on `state`. */
export function timersOf(spec: Spec, state: string): readonly Timer[] {
  return spec.timers?.filter((t) => t.state === state) ?? [];
}

/** The transitions out of `state` on `event`. */
export function transitionsOf(spec: Spec, state: string, event: string): readonly Transition[] {
  return spec.transitions.filter((t) => t.from === state && t.event === event);
}

/** A spec as JSON, for a failure message: the contract a seed stands for. */
export function showSpec(spec: Spec): string {
  return JSON.stringify(spec, null, 2);
}
