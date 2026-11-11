// The independent reference: a Spec (./spec.ts) run as a machine, with no compiler and no runtime.
// It is the model the compiled output is checked against, so it must not share code with the thing
// it checks: it never imports @reactre/state, never calls `transition` or `__step`, and reads the
// spec's own transitions rather than a compiled table. A disagreement between this and the compiled
// machine is a bug in one of them; the fuzz test reports which, with the seed and the contract.
//
// What it models, exactly as the runtime's contract says:
//   - A snapshot is `{ state, data, version }`, and data is a fresh object per move (the runtime
//     builds one from the handler's `to`), so a reference snapshot and a compiled one compare by
//     JSON, not by identity.
//   - An event not in the machine's events is `unknown`; an event the state has no handler for is
//     `unhandled`; a handler whose guard fails is `declined`. A move is `ok: true`.
//   - A final state ends the actor: a send after it is `inactive`, and the snapshot doesn't change.
//   - A guard chain tries each transition in order; the first whose guard holds moves, and if none
//     holds the result is `declined` (the last handler returned `null`).

import {
  chain,
  type DataExpr,
  fieldsOf,
  type Guard,
  parents,
  payloadOf,
  type Spec,
  taskOf,
  timersOf,
  type Transition,
  transitionsOf,
  type ValueExpr,
} from "./spec.ts";

/**
 * A unit: a leaf with its data (numbers and strings), or a parallel node whose data is a unit per
 * region. One recursive record covers both, so a walk can descend without a cast.
 */
export interface RefUnit {
  readonly state: string;
  readonly data: { readonly [key: string]: number | string | RefUnit };
}

/** A snapshot as the reference holds it: the runtime's `{ state, data, version }`. */
export interface RefSnapshot {
  readonly state: string;
  readonly data: { readonly [key: string]: number | string | RefUnit };
  readonly version: number;
}

/** A result as the runtime's `Result` reports it, without the runtime's types. */
export type RefResult =
  | { readonly ok: true; readonly snapshot: RefSnapshot }
  | {
      readonly ok: false;
      readonly reason: "unhandled" | "declined" | "unknown" | "inactive";
      readonly snapshot: RefSnapshot;
    };

/** An event: its type and payload. */
export interface RefEvent {
  readonly type: string;
  readonly [field: string]: number | string;
}

/** The data a value expression computes, from `data` and `event`. */
/** A leaf's data: the fields a handler reads and builds (a parallel node's is its regions). */
type LeafData = { readonly [field: string]: number | string };

function value(v: ValueExpr, data: LeafData, event: RefEvent): number | string {
  switch (v.kind) {
    case "literal":
      return v.value;
    case "data":
      return data[v.field]!;
    case "event":
      return event[v.field]!;
    case "plus":
      return (data[v.field] as number) + v.by;
  }
}

/** The data a transition builds, from `data` and `event`. */
function build(d: DataExpr, data: LeafData, event: RefEvent): LeafData {
  switch (d.kind) {
    case "none":
      return {};
    case "set":
      return { ...data, [d.field]: value(d.value, data, event) };
    case "fresh": {
      const out: { [field: string]: number | string } = {};
      for (const f of d.fields) out[f.name] = value(f.value, data, event);
      return out;
    }
  }
}

/** Whether a guard holds, from `data` and `event`. */
function holds(g: Guard, data: LeafData, event: RefEvent): boolean {
  switch (g.kind) {
    case "always":
      return true;
    case "eventIs":
      return event[g.field] === g.value;
    case "dataAbove":
      return (data[g.field] as number) > g.n;
    case "dataIs":
      return data[g.field] === g.value;
  }
}

/** The reference machine: `initial` and `transition`, over the spec. */
export interface Reference {
  readonly initial: () => RefSnapshot;
  readonly transition: (from: RefSnapshot, event: RefEvent) => RefResult;
  /**
   * A task's internal event: the same walk as `transition`, but the event is the machine's own (a
   * task's `run` resolves to it), so it is never `unknown`. A task's event is not in setup's
   * `events`, and the runtime delivers it as a step, not as a send.
   */
  readonly internal: (from: RefSnapshot, event: RefEvent) => RefResult;
  readonly isFinal: (state: string) => boolean;
}

/** A reference over `spec`. */
export function reference(spec: Spec): Reference {
  const isFinal = (state: string): boolean => spec.final.includes(state);
  const initial = (): RefSnapshot => {
    const data: { [field: string]: number | string } = {};
    for (const d of spec.start.data) data[d.name] = d.value;
    return { state: spec.start.state, data, version: spec.version };
  };
  const parallel = spec.parallel;
  /** The unit a move to `t` enters: a leaf, or a parallel node with each region's start. */
  const enter = (t: Transition, data: LeafData, event: RefEvent): RefUnit => {
    if (parallel !== undefined && t.to === parallel.node) {
      const regions: { [region: string]: RefUnit } = {};
      for (const r of parallel.regions) {
        const data: { [field: string]: number | string } = {};
        for (const d of r.startData) data[d.name] = d.value;
        regions[r.name] = { state: r.start, data };
      }
      return { state: t.to, data: regions };
    }
    return { state: t.to, data: build(t.data, data, event) };
  };
  /** Whether a unit is a parallel node (its data is its regions). */
  const isNode = (u: RefUnit): boolean => parallel !== undefined && u.state === parallel.node;
  /** A node's regions, by name. */
  const regionsOf = (u: RefUnit): { readonly [region: string]: RefUnit } =>
    u.data as { readonly [region: string]: RefUnit };
  /** The unit named `name` in `u`, all the way down its regions. */
  const unitOf = (u: RefUnit, name: string): RefUnit | undefined => {
    if (u.state === name) return u;
    if (!isNode(u) || !name.startsWith(`${u.state}.`)) return undefined;
    const region = name.slice(u.state.length + 1).split(".")[0]!;
    const v = regionsOf(u)[region];
    return v === undefined ? undefined : unitOf(v, name);
  };
  /** `t` put where it goes in `u`: into the region it is in, or in place of `u`. */
  const place = (u: RefUnit, t: RefUnit): RefUnit => {
    if (!isNode(u) || !t.state.startsWith(`${u.state}.`)) return t;
    const region = t.state.slice(u.state.length + 1).split(".")[0]!;
    const at = regionsOf(u)[region];
    return { state: u.state, data: { ...regionsOf(u), [region]: at === undefined ? t : place(at, t) } };
  };
  /** The `done` step of the node in `u` when every region has ended, if it has one. */
  const finished = (u: RefUnit): Transition | undefined => {
    if (!isNode(u) || parallel === undefined) return undefined;
    for (const r of parallel.regions) {
      const v = regionsOf(u)[r.name];
      if (v === undefined || !isFinal(v.state)) return undefined;
    }
    return transitionsOf(spec, u.state, "__done").find((t) => t.guard.kind === "always");
  };
  /**
   * The walk both `transition` and `internal` take; `known` says whether the event is setup's.
   * With a parallel node, the event is offered to each region in order, then to the node's own
   * handlers; a region that moves stays in place, and a node handler that moves replaces the unit.
   */
  const step = (from: RefSnapshot, event: RefEvent, known: boolean): RefResult => {
    if (isFinal(from.state)) return { ok: false, reason: "inactive", snapshot: from };
    if (!known) return { ok: false, reason: "unknown", snapshot: from };
    let declined = false;
    /** The first step `names` (innermost first) give for `unit`, or null. */
    const find = (names: readonly string[], unit: RefUnit): Transition | null => {
      for (const name of names) {
        for (const t of transitionsOf(spec, name, event.type)) {
          if (!holds(t.guard, unit.data as LeafData, event)) {
            declined = true;
            continue;
          }
          return t;
        }
      }
      return null;
    };
    /**
     * Offer the event to the unit `name` in `at`; returns the unit's new form, or null. `depth` is
     * how many of `name`'s chain nodes are above the unit being offered: a region's walk stops at
     * the parallel node, so the node's own handler is not reached from inside a region (the
     * runtime's `offer` passes the same bound).
     */
    const offer = (name: string, at: RefUnit, depth: number): RefUnit | null => {
      const unit = unitOf(at, name);
      if (unit === undefined) return null;
      if (isNode(unit)) {
        let moved = false;
        let next: RefUnit = unit;
        for (const r of parallel!.regions) {
          const v = regionsOf(next)[r.name];
          if (v === undefined || isFinal(v.state)) continue;
          const after = offer(v.state, v, chain(name).length);
          if (after !== null) {
            next = { state: next.state, data: { ...regionsOf(next), [r.name]: after } };
            moved = true;
          }
        }
        if (moved) return next;
      }
      const t = find(chain(name).slice(depth).reverse(), unit);
      if (t === null) return null;
      return enter(t, unit.data as LeafData, event);
    };
    if (parallel !== undefined) {
      const offered = offer(from.state, { state: from.state, data: from.data }, 0);
      if (offered !== null) {
        // The node's `done` fires when every region has ended, in the same step.
        const done = finished(offered);
        const unit = done === undefined ? offered : enter(done, offered.data as LeafData, event);
        return { ok: true, snapshot: { state: unit.state, data: unit.data, version: spec.version } };
      }
      return { ok: false, reason: declined ? "declined" : "unhandled", snapshot: from };
    }
    // The leaf's handlers, then its parents' (innermost first): the first step found decides, and a
    // `null` (a guard that failed) bubbles on. A node with no handler for the event is skipped.
    for (const node of [from.state, ...parents(from.state)]) {
      const candidates = transitionsOf(spec, node, event.type);
      if (candidates.length === 0) continue;
      for (const t of candidates) {
        if (!holds(t.guard, from.data as LeafData, event)) {
          declined = true;
          continue;
        }
        return {
          ok: true,
          snapshot: { state: t.to, data: build(t.data, from.data as LeafData, event), version: spec.version },
        };
      }
    }
    return { ok: false, reason: declined ? "declined" : "unhandled", snapshot: from };
  };
  const transition = (from: RefSnapshot, event: RefEvent): RefResult =>
    step(
      from,
      event,
      spec.events.some((e) => e.name === event.type),
    );
  const internal = (from: RefSnapshot, event: RefEvent): RefResult => step(from, event, true);
  return { initial, transition, internal, isFinal };
}

/** A scheduled arrival: a task's result or a timer, at `at` (ms since the start), for `state`. */
export interface Arrival {
  readonly at: number;
  /** The state the arrival belongs to: it is dropped if the machine has left it. */
  readonly state: string;
  readonly kind: "task" | "timer";
  /** The event a task delivers, or the step a timer takes. */
  readonly event?: RefEvent;
  readonly to?: string;
  readonly data?: DataExpr;
}

/**
 * The arrivals a state schedules when it is entered at `at`: its task (resolving or rejecting after
 * `ms`) and its timers. The reference and the compiled machine both schedule these; the reference
 * computes them from the spec, the machine from its table, so a disagreement is a bug.
 */
export function arrivals(spec: Spec, state: string, at: number): Arrival[] {
  const out: Arrival[] = [];
  const task = taskOf(spec, state);
  if (task !== undefined) {
    const payload: { [field: string]: number | string } = {};
    for (const p of task.payload) payload[p.name] = p.value;
    out.push({
      at: at + task.ms,
      state,
      kind: "task",
      // A failing task delivers its error to `error`, which moves to `onError`; a resolving one
      // delivers its event. Both are modelled as an arrival the machine handles.
      event: task.fails ? { type: "__error", to: task.onError } : { type: task.event, ...payload },
    });
  }
  for (const timer of timersOf(spec, state))
    out.push({ at: at + timer.ms, state, kind: "timer", to: timer.to, data: timer.data });
  return out;
}

/** The fields a state's data has, for a walk to build a payload of the right shape. */
export { fieldsOf, payloadOf };
