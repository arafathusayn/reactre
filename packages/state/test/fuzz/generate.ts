// The generator: a seed to a Spec (./spec.ts), and a Spec to valid TypeScript source. The source is
// what a person would write: `setup({ states, events })`, then `.machine({ start, states })` with
// `to(...)` in place, guards as conditions, and `null` to decline. It is annotation-free, so the
// compiler compiles it and the type checker accepts it (the fuzz test holds a batch to `bun check`).
//
// Design decisions:
//   - Every state is reachable: the generator grows the machine from `start`, and only ever targets
//     a state it has already made reachable, so no generated machine has a dead state.
//   - Data is flat (numbers and strings), and a handler's data is `{ ...data, field: value }` or a
//     fresh object literal: both are the compiler's data contract, and both the reference can build.
//   - A guard is a condition the reference evaluates exactly: `event.f === v`, `data.f > n`,
//     `data.f === v`. A handler that declines returns `null`, which the reference models as a
//     `declined` result, so the differential covers refusals, not only moves.

import { type Rng, rng } from "./random.ts";
import {
  type DataExpr,
  type Field,
  type Guard,
  type Parallel,
  type Spec,
  type Task,
  type Timer,
  type Transition,
  type ValueExpr,
} from "./spec.ts";

const NUMBER_FIELDS = ["n", "count", "total", "step"] as const;
const STRING_FIELDS = ["tag", "label", "who"] as const;
const EVENT_NAMES = ["go", "tick", "set", "reset", "bump", "mark"] as const;
const STATE_NAMES = ["idle", "ready", "busy", "done", "paused", "held"] as const;

/** A field of `kind`, named from the pool, unique within `taken`. */
function field(r: Rng, kind: "number" | "string", taken: Set<string>): Field {
  const pool = kind === "number" ? NUMBER_FIELDS : STRING_FIELDS;
  for (const name of r.shuffle(pool)) if (!taken.has(name)) return { name, kind };
  // The pool is small: a second field of a kind gets a suffix.
  let i = 2;
  for (;;) {
    const name = `${pool[0]}${i++}`;
    if (!taken.has(name)) return { name, kind };
  }
}

/** A literal of `kind`. */
function literal(r: Rng, kind: "number" | "string"): number | string {
  return kind === "number" ? r.int(5) : r.pick(["a", "b", "c"]);
}

/** A value expression for a field of `kind`, from the fields in scope. */
function value(r: Rng, kind: "number" | "string", data: readonly Field[], event: readonly Field[]): ValueExpr {
  const options: ValueExpr[] = [{ kind: "literal", value: literal(r, kind) }];
  for (const f of data) if (f.kind === kind) options.push({ kind: "data", field: f.name });
  for (const f of event) if (f.kind === kind) options.push({ kind: "event", field: f.name });
  if (kind === "number")
    for (const f of data) if (f.kind === "number") options.push({ kind: "plus", field: f.name, by: 1 });
  return r.pick(options);
}

/** The data a transition builds for `to`, from the fields in scope. */
function dataExpr(r: Rng, to: readonly Field[], from: readonly Field[], event: readonly Field[]): DataExpr {
  if (to.length === 0) return { kind: "none" };
  // `{ ...data, f: v }` when the target's fields are a subset of the source's (plus one set).
  const subset = to.every((f) => from.some((g) => g.name === f.name && g.kind === f.kind));
  if (subset && r.chance(0.6)) {
    const f = r.pick(to);
    return { kind: "set", field: f.name, value: value(r, f.kind, from, event) };
  }
  return {
    kind: "fresh",
    fields: to.map((f) => ({ name: f.name, value: value(r, f.kind, from, event) })),
  };
}

/** A guard over the fields in scope. */
function guard(r: Rng, data: readonly Field[], event: readonly Field[]): Guard {
  const options: Guard[] = [{ kind: "always" }];
  for (const f of event) options.push({ kind: "eventIs", field: f.name, value: literal(r, f.kind) });
  for (const f of data) {
    if (f.kind === "number") options.push({ kind: "dataAbove", field: f.name, n: r.int(4) });
    options.push({ kind: "dataIs", field: f.name, value: literal(r, f.kind) });
  }
  return r.pick(options);
}

/**
 * A spec from `seed`. `size` bounds the states and events (a small machine is easier to shrink and
 * to read); the default makes 2–4 states and 1–3 events. `nested` makes a machine with a parent:
 * some leaves are under a dotted parent ("edit.draft"), and the parent gets its own transitions,
 * which apply to every leaf under it. `async` gives some states a task (an internal event after a
 * delay, or a failure to `error`) and some a timer (`after`).
 */
export function generate(
  seed: number,
  size: { states?: number; events?: number; nested?: boolean; async?: boolean; parallel?: boolean } = {},
): Spec {
  if (size.parallel === true) return generateParallel(seed, size);
  const r = rng(seed);
  const stateCount = size.states ?? 2 + r.int(3);
  const eventCount = size.events ?? 1 + r.int(3);

  // States: the first is `start`'s, each with 0–2 fields. With `nested`, the last two leaves are
  // put under one parent ("edit.draft", "edit.review"), so the parent's handlers apply to both. The
  // parent is a name of its own (not a leaf), and the start stays a leaf.
  const names: string[] = r.shuffle(STATE_NAMES).slice(0, stateCount);
  let parent: string | null = null;
  if (size.nested === true && names.length >= 3) {
    parent = r.pick(STATE_NAMES.filter((n) => !names.includes(n)));
    names[names.length - 2] = `${parent}.${names[names.length - 2]}`;
    names[names.length - 1] = `${parent}.${names[names.length - 1]}`;
  }
  const states = names.map((name, i) => {
    const taken = new Set<string>();
    const count = i === 0 ? r.int(2) : r.int(3);
    const fields: Field[] = [];
    for (let k = 0; k < count; k++) {
      const f = field(r, r.chance(0.6) ? "number" : "string", taken);
      taken.add(f.name);
      fields.push(f);
    }
    return { name, fields };
  });

  // Events: each with 0–2 fields.
  const events = r
    .shuffle(EVENT_NAMES)
    .slice(0, eventCount)
    .map((name) => {
      const taken = new Set<string>();
      const count = r.int(3);
      const fields: Field[] = [];
      for (let k = 0; k < count; k++) {
        const f = field(r, r.chance(0.5) ? "number" : "string", taken);
        taken.add(f.name);
        fields.push(f);
      }
      return { name, fields };
    });

  const startState = states[0]!;
  const start = {
    state: startState.name,
    data: startState.fields.map((f) => ({ name: f.name, value: literal(r, f.kind) })),
  };

  // Transitions: from each reachable state, on each event, 0–2 of them. A state is reachable once
  // it is `start` or a target of a transition from a reachable state; the generator only targets
  // states it has already made reachable, so the machine has no dead state.
  const reachable = new Set<string>([startState.name]);
  const transitions: Transition[] = [];
  for (const from of states) {
    if (!reachable.has(from.name)) continue;
    for (const event of events) {
      const count = r.int(3);
      for (let k = 0; k < count; k++) {
        const to = r.pick(states);
        reachable.add(to.name);
        transitions.push({
          from: from.name,
          event: event.name,
          guard: guard(r, from.fields, event.fields),
          to: to.name,
          data: dataExpr(r, to.fields, from.fields, event.fields),
        });
      }
    }
  }

  // A parent's transitions: on each event, 0–1, from the parent to any state. They apply to every
  // leaf under it, after the leaf's own, so a leaf that declines bubbles to the parent.
  if (parent !== null) {
    const under = states.filter((s) => s.name.startsWith(`${parent}.`));
    // A parent's handler reads the data of whichever leaf is under it, so it may read only the
    // fields every leaf under it has: the intersection, which the type checker would require too.
    const fields = (under[0]?.fields ?? []).filter((f) =>
      under.every((s) => s.fields.some((g) => g.name === f.name && g.kind === f.kind)),
    );
    for (const event of events) {
      if (!r.chance(0.8)) continue;
      const to = r.pick(states);
      reachable.add(to.name);
      transitions.push({
        from: parent,
        event: event.name,
        guard: guard(r, fields, event.fields),
        to: to.name,
        // A parent's `data` is whichever leaf is under it, which has more fields than the parent
        // may read: a fresh object, never `{ ...data }`, so the target's data has exactly its keys.
        data: dataExpr(r, to.fields, [], event.fields),
      });
    }
  }

  // Final states: a state no transition leaves, or one the generator marks. A machine with no
  // transition at all would be a dead end the compiler refuses, so the start always has one.
  const leaves = states.filter((s) => !transitions.some((t) => t.from === s.name)).map((s) => s.name);
  const final = leaves.length > 0 ? leaves : r.chance(0.5) ? [r.pick(states).name] : [];

  // Tasks and timers, when asked for. A task's state gets an internal event (a name no external
  // event uses) and an `error` that moves to another state; a timer's state gets an `after` that
  // moves to another state. Both are only on non-final states, and a state has at most one task.
  const tasks: Task[] = [];
  const timers: Timer[] = [];
  if (size.async === true) {
    // Which states get a task, decided first: a task's target must not have one. A 0ms task moves
    // on a microtask, so a cycle of them (a -> b -> a, each 0ms) would spin forever in the runtime
    // and in the reference alike. Keeping the task edges acyclic (a task's target has no task) is
    // what makes a generated machine terminate; errors and timers are unaffected.
    const withTask = new Set(states.filter((s) => !final.includes(s.name) && r.chance(0.4)).map((s) => s.name));
    const sinks = states.filter((s) => !withTask.has(s.name));
    const internal = new Set<string>();
    for (const state of states) {
      if (final.includes(state.name)) continue;
      if (withTask.has(state.name)) {
        let name = "done";
        while (internal.has(name) || events.some((e) => e.name === name)) name = `${name}x`;
        internal.add(name);
        // A sink: a state with no task of its own, so the task's move can't start another.
        const target = r.pick(sinks);
        const onError = r.pick(sinks);
        reachable.add(target.name);
        reachable.add(onError.name);
        // The task's event moves to `target`; the state's `on` handles it.
        transitions.push({
          from: state.name,
          event: name,
          guard: { kind: "always" },
          to: target.name,
          data: dataExpr(r, target.fields, state.fields, []),
        });
        tasks.push({
          state: state.name,
          event: name,
          payload: [],
          // A task's `run` may not use `setTimeout` (M438), so the generated task resolves on a
          // microtask: its delay is 0, and the reference models it as arriving at once.
          ms: 0,
          fails: r.chance(0.3),
          onError: onError.name,
        });
      }
      if (r.chance(0.4)) {
        const target = r.pick(states);
        reachable.add(target.name);
        timers.push({
          state: state.name,
          ms: 1 + r.int(5),
          to: target.name,
          data: dataExpr(r, target.fields, state.fields, []),
        });
      }
    }
  }

  return { seed, version: r.int(3), states, events, start, final, transitions, tasks, timers };
}

/**
 * A machine with a parallel node: `off` (a plain leaf), then `on`, whose two regions each have a
 * two-leaf chain ending in a final leaf. The node's `done` moves to `off`. The shape is fixed (a
 * parallel node's regions are a structure the reference must model exactly, not a random graph), and
 * the seed varies the data, the guards and the events, so a walk exercises: an event offered to each
 * region in turn, a region that declines while another moves, a region that ends, and the `done`
 * that fires when both have.
 */
function generateParallel(seed: number, size: { events?: number }): Spec {
  const r = rng(seed);
  const node = "on";
  // Each region starts in a leaf with a number field, so entering the node must pass data: the
  // type layer requires a step for every region, with the start leaf's data.
  const regions = [
    { name: "a", leaves: ["on.a.x", "on.a.y"], start: "on.a.x", startData: [{ name: "n", value: r.int(4) }] },
    { name: "b", leaves: ["on.b.z", "on.b.w"], start: "on.b.z", startData: [{ name: "n", value: r.int(4) }] },
  ] as const;
  const states = [
    { name: "off", fields: [] as Field[] },
    { name: "on.a.x", fields: [{ name: "n", kind: "number" } as Field] },
    { name: "on.a.y", fields: [] as Field[] },
    { name: "on.b.z", fields: [{ name: "n", kind: "number" } as Field] },
    { name: "on.b.w", fields: [] as Field[] },
  ];
  const eventCount = size.events ?? 2 + r.int(2);
  const events = r
    .shuffle(EVENT_NAMES)
    .slice(0, eventCount)
    .map((name) => ({
      name,
      fields: r.chance(0.5) ? [{ name: "n", kind: "number" } as Field] : [],
    }));
  const [first, second] = events;
  const transitions: Transition[] = [
    // `off` enters the node: each region's start, in place.
    {
      from: "off",
      event: first!.name,
      guard: { kind: "always" },
      to: node,
      data: { kind: "none" },
    },
    // Each region's first leaf moves to its second on the second event, when its guard holds.
    {
      from: "on.a.x",
      event: second!.name,
      guard: r.chance(0.5) ? { kind: "always" } : { kind: "dataAbove", field: "n", n: r.int(3) },
      to: "on.a.y",
      data: { kind: "none" },
    },
    {
      from: "on.b.z",
      event: second!.name,
      guard: r.chance(0.5) ? { kind: "always" } : { kind: "dataAbove", field: "n", n: r.int(3) },
      to: "on.b.w",
      data: { kind: "none" },
    },
  ];
  // The node's own handler: the first event leaves it (dropping both regions), so a walk can go
  // back to `off` and enter again.
  transitions.push({ from: node, event: first!.name, guard: { kind: "always" }, to: "off", data: { kind: "none" } });
  return {
    seed,
    version: r.int(3),
    states,
    events,
    start: { state: "off", data: [] },
    final: [],
    transitions,
    parallel: { node, regions: regions.map((x) => ({ ...x, leaves: [...x.leaves] })), done: "off" },
  };
}

// #region Rendering

/** A value expression as TypeScript. */
function renderValue(v: ValueExpr): string {
  switch (v.kind) {
    case "literal":
      return typeof v.value === "string" ? JSON.stringify(v.value) : String(v.value);
    case "data":
      return `data.${v.field}`;
    case "event":
      return `event.${v.field}`;
    case "plus":
      return `data.${v.field} + ${v.by}`;
  }
}

/** A data expression as the object literal `to` takes. */
function renderData(d: DataExpr): string {
  switch (d.kind) {
    case "none":
      return "";
    case "set":
      return `{ ...data, ${d.field}: ${renderValue(d.value)} }`;
    case "fresh":
      return `{ ${d.fields.map((f) => `${f.name}: ${renderValue(f.value)}`).join(", ")} }`;
  }
}

/** A guard as a condition, or null for `always`. */
function renderGuard(g: Guard): string | null {
  switch (g.kind) {
    case "always":
      return null;
    case "eventIs":
      return `event.${g.field} === ${typeof g.value === "string" ? JSON.stringify(g.value) : g.value}`;
    case "dataAbove":
      return `data.${g.field} > ${g.n}`;
    case "dataIs":
      return `data.${g.field} === ${typeof g.value === "string" ? JSON.stringify(g.value) : g.value}`;
  }
}

/** A field's type, as `types<...>` writes it. */
function renderType(fields: readonly Field[]): string {
  if (fields.length === 0) return "{}";
  return `{ ${fields.map((f) => `${f.name}: ${f.kind}`).join("; ")} }`;
}

/** The names a handler's code reads, so its destructuring lists only those (no unused binding). */
function used(code: string): string {
  const names = ["data", "event"].filter((n) => new RegExp(`\\b${n}\\b`).test(code));
  return [...names, "to"].join(", ");
}

/**
 * A move's code: `to(target)` or `to(target, data)`. A move to a parallel node writes each region's
 * step in place (`to("on", { a: to("on.a.x"), b: to("on.b.z") })`), which is the only form the
 * compiler accepts for a parallel node's target.
 */
function renderMove(t: Transition, parallel: Parallel | undefined): string {
  if (parallel !== undefined && t.to === parallel.node) {
    const regions = parallel.regions
      .map((r) => {
        const data =
          r.startData.length === 0
            ? ""
            : `, { ${r.startData.map((d) => `${d.name}: ${typeof d.value === "string" ? JSON.stringify(d.value) : d.value}`).join(", ")} }`;
        return `${JSON.stringify(r.name)}: to(${JSON.stringify(r.start)}${data})`;
      })
      .join(", ");
    return `to(${JSON.stringify(t.to)}, { ${regions} })`;
  }
  const data = renderData(t.data);
  return data === "" ? `to(${JSON.stringify(t.to)})` : `to(${JSON.stringify(t.to)}, ${data})`;
}

/** The handler for one transition: a move, or a guard that moves or declines. */
function renderHandler(t: Transition, parallel?: Parallel): string {
  const move = renderMove(t, parallel);
  const condition = renderGuard(t.guard);
  const body = condition === null ? move : `(${condition} ? ${move} : null)`;
  return `({ ${used(body)} }) => ${body}`;
}

/**
 * The spec as TypeScript source: a module with one `setup`, one `.machine`, and the machine
 * exported. `name` is the machine's export (the harness imports it by this name). `persist` adds
 * the persist opt-in (`use: [persist]`), so the machine saves its timers' deadlines and restores
 * them: the host-restart lane's fixture.
 */
export function render(spec: Spec, name = "machine", options: { persist?: boolean; shape?: string } = {}): string {
  const states = spec.states.map((s) => `    ${JSON.stringify(s.name)}: types<${renderType(s.fields)}>(),`).join("\n");
  const events = spec.events.map((e) => `    ${JSON.stringify(e.name)}: types<${renderType(e.fields)}>(),`).join("\n");
  const startData =
    spec.start.data.length === 0
      ? ""
      : `, { ${spec.start.data.map((d) => `${d.name}: ${typeof d.value === "string" ? JSON.stringify(d.value) : d.value}`).join(", ")} }`;

  // The parallel node, when the machine has one: its `done` and its regions' starts are part of the
  // configs below, so it is read before them.
  const parallel = spec.parallel;
  // A parallel node's `done`: when every region has ended, the whole unit moves. It goes in the
  // node's own config, beside its handlers (a second key for the node would replace them).
  const done = parallel === undefined ? "" : `      done: ({ to }) => to(${JSON.stringify(parallel.done)}),\n`;
  // Each state's handlers, by event: the transitions out of it, in order. A state with two
  // transitions on one event is a guard chain: the first that holds moves, the rest decline.
  const byState = new Map<string, Map<string, Transition[]>>();
  for (const t of spec.transitions) {
    const events = byState.get(t.from) ?? new Map<string, Transition[]>();
    byState.set(t.from, events);
    const list = events.get(t.event) ?? [];
    events.set(t.event, list);
    list.push(t);
  }
  /** A node's config: its handlers, its task and timers, and `final` for a leaf that ends. */
  const config = (name: string, isLeaf: boolean): string => {
    const events = byState.get(name);
    const final = isLeaf && spec.final.includes(name) ? "    final: true,\n" : "";
    const task = spec.tasks?.find((t) => t.state === name);
    const timers = spec.timers?.filter((t) => t.state === name) ?? [];
    // A task: `run` resolves to its event (on a microtask), or rejects; `error` moves to `onError`.
    // A task's `run` may not use `setTimeout` (M438: it outlives a cancel), so the delay is a
    // microtask, and the reference models the arrival as immediate.
    const taskCode =
      task === undefined
        ? ""
        : `      task: {\n        run: async ({ signal }) => {\n          await Promise.resolve();\n          if (signal.aborted) throw new Error("aborted");\n          ${task.fails ? 'throw new Error("failed");' : `return { type: ${JSON.stringify(task.event)} };`}\n        },\n        error: ({ to }) => to(${JSON.stringify(task.onError)}),\n      },\n`;
    // Timers: `after: { "<ms>ms": ... }`, each moving to its target.
    // A timer's handler gets `data` (the leaf under the node now), so it may read it; the data it
    // builds is a fresh object, since the target's fields may differ from the source's.
    const timerCode =
      timers.length === 0
        ? ""
        : `      after: {\n${timers
            .map((t) => {
              const data = renderData(t.data);
              const move = data === "" ? `to(${JSON.stringify(t.to)})` : `to(${JSON.stringify(t.to)}, ${data})`;
              return `        ${JSON.stringify(`${t.ms}ms`)}: ({ ${used(move)} }) => ${move},`;
            })
            .join("\n")}\n      },\n`;
    const on =
      events === undefined || events.size === 0
        ? ""
        : `      on: {\n${[...events]
            .map(([event, list]) => {
              // One transition: its handler. Several: a chain, each guard tried in turn.
              const body =
                list.length === 1
                  ? renderHandler(list[0]!, spec.parallel)
                  : (() => {
                      const chain = list
                        .map((t) => {
                          const move = renderMove(t, spec.parallel);
                          const condition = renderGuard(t.guard);
                          return condition === null ? move : `(${condition} ? ${move} : null)`;
                        })
                        .join(" ?? ");
                      return `({ ${used(chain)} }) => ${chain}`;
                    })();
              return `        ${JSON.stringify(event)}: ${body},`;
            })
            .join("\n")}\n      },\n`;
    // A parallel node's `done` is part of its own config, not a second key for it.
    const own = parallel !== undefined && name === parallel.node ? done : "";
    if (final === "" && taskCode === "" && timerCode === "" && on === "" && own === "")
      return `    ${JSON.stringify(name)}: {\n    },`;
    return `    ${JSON.stringify(name)}: {\n${final}${taskCode}${timerCode}${on}${own}    },`;
  };

  // The leaves, then any parent a transition names (a parent is a node, not a leaf: no data).
  const parents = [
    ...new Set(spec.transitions.map((t) => t.from).filter((n) => !spec.states.some((s) => s.name === n))),
  ];
  const stateConfigs = [...spec.states.map((s) => config(s.name, true)), ...parents.map((p) => config(p, false))].join(
    "\n",
  );
  const nested = parents.length > 0;
  const persist = options.persist === true;
  const uses = [
    nested ? "nested" : null,
    parallel === undefined ? null : "parallel",
    persist ? "persist" : null,
  ].filter((u) => u !== null);
  const imports = [
    nested ? 'import { nested } from "@reactre/state/nested";' : null,
    parallel === undefined ? null : 'import { parallel } from "@reactre/state/parallel";',
    persist ? 'import { persist } from "@reactre/state/persist";' : null,
  ].filter((i) => i !== null);
  // The node's `start` enters each region's start leaf, in place: `to(node, { region: to(leaf) })`.
  const startMove =
    parallel === undefined
      ? `to(${JSON.stringify(spec.start.state)}${startData})`
      : `to(${JSON.stringify(spec.start.state)}${startData})`;

  return `// Generated by test/fuzz/generate.ts from seed ${spec.seed}. Do not edit: rerun the seed.
import { setup, types } from "@reactre/state";${imports.length > 0 ? `\n${imports.join("\n")}` : ""}

const shape = setup({${uses.length > 0 ? `\n  use: [${uses.join(", ")}],` : ""}${parallel === undefined ? "" : `\n  parallel: [${JSON.stringify(parallel.node)}],`}${options.shape === undefined ? "" : `\n  shape: ${JSON.stringify(options.shape)},`}
  version: ${spec.version},
  states: {
${states}
  },
  events: {
${events}
  },
});

export const ${name} = shape.machine({
  start: ({ to }) => ${startMove},
  states: {
${stateConfigs}
  },
});
`;
}

// #endregion
