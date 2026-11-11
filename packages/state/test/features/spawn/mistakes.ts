// spawn's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says.

import { type Machine, setup, types } from "@reactre/state";
import { child, children } from "@reactre/state/children";
import { effects } from "@reactre/state/effects";
import { spawn } from "@reactre/state/spawn";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const worker = setup({
  input: types<{ id: string }>(),
  states: { busy: types<{ id: string }>(), over: types<{ id: string }>() },
  events: { end: types<{}>() },
});
const workerMachine = worker.machine({
  start: ({ input, to }) => to("busy", { id: input.id }),
  states: { busy: { on: { end: ({ data, to }) => to("over", data) } }, over: { final: true } },
});

// Needs effects, which `enq` comes from.
// @ts-expect-error "spawn needs effects: add effects to setup's use (…)" is missing.
setup({ use: [spawn], states: { idle: types<{}>() }, events: {} });

// Off: `enq.spawn` is a function whose only parameter is the fix.
const off = setup({
  use: [children, effects],
  states: { idle: types<{}>() },
  events: { add: types<{ id: string }>() },
  children: { worker: workerMachine },
});
off.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        add: ({ event, enq, to }) => {
          expect<
            Equal<
              Parameters<typeof enq.spawn>[0],
              `enq.spawn needs spawn: add spawn to setup's use (import { spawn } from "@reactre/state/spawn")`
            >
          >();
          // @ts-expect-error "worker" is not assignable to "enq.spawn needs spawn: add spawn to setup's use (…)".
          enq.spawn("worker", { key: event.id, input: { id: event.id } });
          return to("idle");
        },
      },
    },
  },
});

const pool = setup({
  use: [children, effects, spawn],
  states: { idle: types<{}>() },
  events: { add: types<{ id: string }>() },
  internal: { over: types<{ output: { state: "over"; data: { id: string } } }>(), seen: types<{ n: number }>() },
  children: { worker: workerMachine },
});
const poolMachine = pool.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        add: ({ event, enq, to }) => {
          enq.spawn("worker", { key: event.id, input: { id: event.id } });
          enq.subscribeTo("worker", { key: event.id, done: "over" });
          // @ts-expect-error "wroker" is not one of setup's children.
          enq.spawn("wroker", { input: { id: event.id } });
          // @ts-expect-error The worker takes input: { id }.
          enq.spawn("worker", { key: event.id });
          // @ts-expect-error "seen" has { n }, not { output }: done names an event whose data is the output.
          enq.subscribeTo("worker", { done: "seen" });
          return to("idle");
        },
        over: ({ to }) => to("idle"),
        seen: ({ to }) => to("idle"),
      },
    },
  },
});

// A spawned child is reached by its key.
declare const actor: import("@reactre/state").Actor<typeof poolMachine extends Machine<infer D> ? D : never>;
child(actor, "worker", "a")?.send({ type: "end" });
// @ts-expect-error A spawned child takes its key.
child(actor, "worker");

// The second round's rows, by their M#.
declare const parent: { readonly send: (event: { readonly type: "add" }) => void };
pool.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        add: ({ event, enq, to }) => {
          const input = { id: event.id, parent };
          // @ts-expect-error M532. An actor in a spawn's input: pass what it needs as data.
          enq.spawn("worker", { key: event.id, input });
          return to("idle");
        },
        over: ({ to }) => to("idle"),
        seen: ({ to }) => to("idle"),
      },
    },
  },
});
