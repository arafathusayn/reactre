// Hand-written cases for the fuzz breadth lane: the source of each machine, the events a walk
// sends, and the trace a person computes from the contract by hand. Nothing here runs the runtime:
// the expectations are derived from the machine as written (the type layer's contract), so a
// disagreement is a bug in the compiler or the runtime, not in a second interpreter that shares
// their code.
//
// The lane covers what the generated differentials do not: a nested parent *inside* a parallel
// region (the parent's handler applying to the leaves under it, while a region's walk stops at
// the node), the snapshot and import shape the three variants must share, a version mismatch
// refused on restore, and a counting `always` loop with a decision beside it.

/** One step of a trace, as the runtime reports it: whether it moved, why, and the snapshot after. */
export interface ExpectedStep {
  readonly event: { readonly type: string; readonly [field: string]: number | string };
  readonly ok: boolean;
  /** Present only when `ok` is false: `declined`, `unhandled`, `unknown`, `inactive`. */
  readonly reason?: string;
  readonly state: string;
  readonly data: unknown;
  readonly version: number;
}

/** A hand-computed trace: the start snapshot, then a step per event. */
export interface ExpectedTrace {
  readonly start: { readonly state: string; readonly data: unknown; readonly version: number };
  readonly steps: readonly ExpectedStep[];
}

/**
 * A machine whose parallel node has a region holding a nested parent: `on.b` is a parent over
 * `on.b.edit.draft` and `on.b.edit.review`. Its `save` applies to whichever of the two leaves is
 * under it, which is the handler bubbling the generated differentials cannot place on a nested
 * node inside a region.
 */
export const NESTED_PARALLEL_SOURCE = `import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";

const shape = setup({
  use: [nested, parallel],
  parallel: ["on"],
  version: 2,
  states: {
    off: types<{}>(),
    "on.a.x": types<{ n: number }>(),
    "on.a.y": types<{}>(),
    "on.b.edit.draft": types<{ t: string }>(),
    "on.b.edit.review": types<{ t: string }>(),
  },
  events: {
    power: types<{}>(),
    step: types<{ n: number }>(),
    write: types<{ t: string }>(),
    save: types<{}>(),
  },
});

export const machine = shape.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: {
        power: ({ to }) =>
          to("on", { a: to("on.a.x", { n: 1 }), b: to("on.b.edit.draft", { t: "" }) }),
      },
    },
    // Region a ends when step carries 2; any other number declines (a guard that fails).
    "on.a.x": { on: { step: ({ event, to }) => (event.n === 2 ? to("on.a.y") : null) } },
    "on.a.y": { final: true },
    // The parent over region b's leaves: it reads whichever leaf's data is under it.
    "on.b": { on: { save: ({ data, to }) => to("on.b.edit.review", { t: data.t }) } },
    "on.b.edit.draft": { on: { write: ({ event, to }) => to("on.b.edit.draft", { t: event.t }) } },
    "on.b.edit.review": { final: true },
    // The node's done: every region final (a on.a.y, b on.b.edit.review) moves the unit off.
    on: { done: ({ to }) => to("off") },
  },
});
`;

/** The walk `NESTED_PARALLEL_SOURCE` is held to, and what it must do. */
export const NESTED_PARALLEL_EVENTS = [
  { type: "power" },
  { type: "step", n: 1 },
  { type: "write", t: "hi" },
  { type: "save" },
  { type: "write", t: "x" },
  { type: "step", n: 2 },
  { type: "zzz" },
] as const;

/**
 * Hand-computed: `start` is `off`; `power` enters the node with both regions' starts; `step` with 1
 * fails region a's guard and bubbles to the parent (none) so it declines; `write` edits the draft's
 * text; `save` bubbles to the parent `on.b`, moving the region's leaf to `review`; after the move,
 * `write` has no handler in `review` and the parent has none for it, so it is unhandled (a region's
 * walk stops at the node, so the node's `done` is not consulted for it); `step` with 2 ends region
 * a, and with b already final the node's `done` moves everything to `off` in the same step; `zzz`
 * is not one of the machine's events.
 */
export const NESTED_PARALLEL_EXPECTED: ExpectedTrace = {
  start: { state: "off", data: {}, version: 2 },
  steps: [
    {
      event: { type: "power" },
      ok: true,
      state: "on",
      data: {
        a: { state: "on.a.x", data: { n: 1 } },
        b: { state: "on.b.edit.draft", data: { t: "" } },
      },
      version: 2,
    },
    {
      event: { type: "step", n: 1 },
      ok: false,
      reason: "declined",
      state: "on",
      data: {
        a: { state: "on.a.x", data: { n: 1 } },
        b: { state: "on.b.edit.draft", data: { t: "" } },
      },
      version: 2,
    },
    {
      event: { type: "write", t: "hi" },
      ok: true,
      state: "on",
      data: {
        a: { state: "on.a.x", data: { n: 1 } },
        b: { state: "on.b.edit.draft", data: { t: "hi" } },
      },
      version: 2,
    },
    {
      event: { type: "save" },
      ok: true,
      state: "on",
      data: {
        a: { state: "on.a.x", data: { n: 1 } },
        b: { state: "on.b.edit.review", data: { t: "hi" } },
      },
      version: 2,
    },
    {
      event: { type: "write", t: "x" },
      ok: false,
      reason: "unhandled",
      state: "on",
      data: {
        a: { state: "on.a.x", data: { n: 1 } },
        b: { state: "on.b.edit.review", data: { t: "hi" } },
      },
      version: 2,
    },
    {
      event: { type: "step", n: 2 },
      ok: true,
      state: "off",
      data: {},
      version: 2,
    },
    {
      event: { type: "zzz" },
      ok: false,
      reason: "unknown",
      state: "off",
      data: {},
      version: 2,
    },
  ],
};

/**
 * A counting `always` loop beside a decision: `go` enters `counting` with `n: 0`, and the state's
 * `always` adds 2 per pass until 4, where it rests (a bounded loop, so the walk terminates). `poke`
 * decides by parity between `even` and `odd`, and each decision leaf has a guard that can send the
 * walk back to `idle`.
 */
export const LOOP_SOURCE = `import { setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";

const shape = setup({
  use: [always],
  version: 1,
  states: {
    idle: types<{}>(),
    counting: types<{ n: number }>(),
    even: types<{ n: number }>(),
    odd: types<{ n: number }>(),
  },
  events: { go: types<{}>(), poke: types<{ n: number }>() },
});

export const machine = shape.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("counting", { n: 0 }) } },
    counting: {
      always: ({ data, to }) => (data.n < 4 ? to("counting", { n: data.n + 2 }) : null),
      on: {
        poke: ({ event, to }) => (event.n % 2 === 0 ? to("even", { n: event.n }) : to("odd", { n: event.n })),
      },
    },
    even: { on: { poke: ({ event, to }) => (event.n === 0 ? to("idle") : null) } },
    odd: { on: { poke: ({ event, to }) => (event.n > 5 ? to("idle") : null) } },
  },
});
`;

/** The walk `LOOP_SOURCE` is held to. */
export const LOOP_EVENTS = [
  { type: "go" },
  { type: "poke", n: 2 },
  { type: "poke", n: 1 },
  { type: "poke", n: 9 },
  { type: "poke", n: 0 },
  { type: "go" },
  { type: "poke", n: 3 },
  { type: "poke", n: 7 },
] as const;

/**
 * Hand-computed: `go` moves to `counting` with 0, and the `always` runs in the same step until `n`
 * reaches 4 (0 -> 2 -> 4), where `n < 4` is false and it rests; `poke` with 2 decides `even`;
 * `poke` with 1 fails `even`'s guard (only 0 leaves) and declines; `poke` with 9 declines the same
 * way; `poke` with 0 leaves to `idle`; `go` loops again to `counting`, resting at 4; `poke` with 3
 * decides `odd`; `poke` with 7 (> 5) leaves `odd` to `idle`.
 */
export const LOOP_EXPECTED: ExpectedTrace = {
  start: { state: "idle", data: {}, version: 1 },
  steps: [
    { event: { type: "go" }, ok: true, state: "counting", data: { n: 4 }, version: 1 },
    { event: { type: "poke", n: 2 }, ok: true, state: "even", data: { n: 2 }, version: 1 },
    { event: { type: "poke", n: 1 }, ok: false, reason: "declined", state: "even", data: { n: 2 }, version: 1 },
    { event: { type: "poke", n: 9 }, ok: false, reason: "declined", state: "even", data: { n: 2 }, version: 1 },
    { event: { type: "poke", n: 0 }, ok: true, state: "idle", data: {}, version: 1 },
    { event: { type: "go" }, ok: true, state: "counting", data: { n: 4 }, version: 1 },
    { event: { type: "poke", n: 3 }, ok: true, state: "odd", data: { n: 3 }, version: 1 },
    { event: { type: "poke", n: 7 }, ok: true, state: "idle", data: {}, version: 1 },
  ],
};

/**
 * The `counting` decision's `odd` arm edited to `even`: a source that compiles, and moves wrongly
 * on an odd `poke`. Used to prove the minimizer keeps only the events that still show a failure.
 */
export const LOOP_CORRUPT = LOOP_SOURCE.replace(
  `(event.n % 2 === 0 ? to("even", { n: event.n }) : to("odd", { n: event.n }))`,
  `(event.n % 2 === 0 ? to("even", { n: event.n }) : to("even", { n: event.n }))`,
);

/**
 * A hand-written model of `LOOP_SOURCE`, for the corrupted-source shrinking: the same rules as the
 * comment on `LOOP_EXPECTED`, spelled out over the spec rather than the machine. It is independent
 * of the runtime and the compiler (no `createActor`, no table), so a shrink predicate built on it
 * is checking the machine, not a copy of it.
 */
export interface ModelStep {
  readonly ok: boolean;
  readonly reason?: string;
  readonly state: string;
  readonly data: { readonly n?: number };
}

/** A model trace: the start snapshot, then a step per event (no `event` field: the model is about
 * the move, and the walk is the caller's). */
export interface ModelTrace {
  readonly start: { readonly state: string; readonly data: unknown; readonly version: number };
  readonly steps: readonly ModelStep[];
}

export function loopModel(events: readonly { readonly type: string; readonly n?: number }[]): ModelStep[] {
  const steps: ModelStep[] = [];
  let state = "idle";
  let data: { n?: number } = {};
  for (const event of events) {
    if (event.type === "go" && state === "idle") {
      // Entering `counting` with 0, then the `always` adds 2 per pass while n < 4: 0 -> 2 -> 4.
      state = "counting";
      data = { n: 4 };
      steps.push({ ok: true, state, data });
    } else if (event.type === "poke" && state === "counting") {
      const n = event.n ?? 0;
      state = n % 2 === 0 ? "even" : "odd";
      data = { n };
      steps.push({ ok: true, state, data });
    } else if (event.type === "poke" && state === "even") {
      if (event.n === 0) {
        state = "idle";
        data = {};
        steps.push({ ok: true, state, data });
      } else steps.push({ ok: false, reason: "declined", state, data });
    } else if (event.type === "poke" && state === "odd") {
      if ((event.n ?? 0) > 5) {
        state = "idle";
        data = {};
        steps.push({ ok: true, state, data });
      } else steps.push({ ok: false, reason: "declined", state, data });
    } else if (event.type === "go" || event.type === "poke") {
      // A known event this state has no handler for.
      steps.push({ ok: false, reason: "unhandled", state, data });
    } else {
      steps.push({ ok: false, reason: "unknown", state, data });
    }
  }
  return steps;
}
