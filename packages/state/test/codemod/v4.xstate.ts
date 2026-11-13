// A counter written the XState v4 way: `createMachine<Context, Event>`, string targets, `cond`
// (inline and named, in the options), arrays of guarded transitions, and positional
// `(context, event)` arguments.

import { assign, createMachine } from "./xstate4.ts";

interface CounterContext {
  count: number;
}

type CounterEvent = { type: "INC"; by: number } | { type: "DEC" } | { type: "STOP" } | { type: "RESUME" };

export const counterMachine = createMachine<CounterContext, CounterEvent>(
  {
    id: "counter",
    context: { count: 0 },
    initial: "active",
    states: {
      active: {
        on: {
          INC: { actions: assign({ count: (ctx: CounterContext, e: { by: number }) => ctx.count + e.by }) },
          DEC: { cond: "positive", actions: assign({ count: (ctx: CounterContext) => ctx.count - 1 }) },
          STOP: [{ target: "stopped", cond: (ctx: CounterContext) => ctx.count >= 3 }, { target: "paused" }],
        },
      },
      paused: { on: { RESUME: "active" } },
      stopped: { type: "final" },
    },
  },
  {
    guards: { positive: (ctx: CounterContext) => ctx.count > 0 },
  },
);
