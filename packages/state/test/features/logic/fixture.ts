// Machines that run actor logic as children, compiled as a build compiles them (../../compiled.ts
// registers the plugin): an async load with a timeout, and a callback ticker that sends events back.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { createAsyncLogic, createCallbackLogic, logic, TimeoutError } from "@reactre/state/logic";

/** What the tests control: each load resolves or rejects when they say. */
export const calls: { id: string; resolve: (name: string) => void; reject: (e: unknown) => void }[] = [];

export const load = createAsyncLogic({
  id: "load",
  timeout: "50ms",
  run: ({ input }: { input: { id: string }; signal: AbortSignal }) =>
    new Promise<{ name: string }>((resolve, reject) =>
      calls.push({ id: input.id, resolve: (name) => resolve({ name }), reject }),
    ),
});

export const ticker = createCallbackLogic<{ type: "stop" }, { every: number }, { type: "tick"; n: number }>(
  ({ input, sendBack, receive }) => {
    let n = 0;
    const t = setInterval(() => sendBack({ type: "tick", n: ++n }), input.every);
    receive(() => clearInterval(t));
    return () => clearInterval(t);
  },
);

const user = setup({
  use: [children, logic],
  states: {
    idle: types<{ id: string }>(),
    loading: types<{ id: string; ticks: number }>(),
    ready: types<{ name: string }>(),
    failed: types<{ reason: string }>(),
  },
  events: { load: types<{}>(), retry: types<{}>() },
  children: { load, ticker },
});

export const userMachine = user.machine({
  start: ({ to }) => to("idle", { id: "u1" }),
  states: {
    idle: { on: { load: ({ data, to }) => to("loading", { id: data.id, ticks: 0 }) } },
    loading: {
      children: {
        load: {
          input: ({ data }) => ({ id: data.id }),
          done: ({ output, to }) => to("ready", { name: output.name }),
          error: ({ error, to }) => to("failed", { reason: error instanceof TimeoutError ? "timeout" : String(error) }),
        },
        ticker: {
          input: () => ({ every: 5 }),
          error: ({ to }) => to("failed", { reason: "ticker" }),
          on: { tick: ({ data, event, to }) => to("loading", { id: data.id, ticks: event.n }) },
        },
      },
    },
    ready: { final: true },
    failed: { on: { retry: ({ to }) => to("idle", { id: "u1" }) } },
  },
});
