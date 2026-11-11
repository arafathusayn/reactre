// A call in XState v6: a state's timeout with onTimeout, entry as a function of enq, and a
// transition function that logs with enq.

import { setup, types } from "xstate6";

/** Who was rung, in order. */
export const rung: string[] = [];

export const callMachine = setup({
  schemas: {
    context: types<{ to: string }>(),
    events: { dial: types<{ to: string }>(), answer: types<{}>(), hangUp: types<{}>() },
  },
}).createMachine({
  context: { to: "" },
  initial: "idle",
  states: {
    idle: {
      on: {
        dial: ({ event }, enq) => {
          enq.log("dialing", event.to);
          return { target: "ringing", context: { to: event.to } };
        },
      },
    },
    ringing: {
      entry: ({ context }, enq) => {
        enq((to: string) => rung.push(to), context.to);
      },
      timeout: 20,
      onTimeout: { target: "missed" },
      on: { answer: { target: "talking" } },
    },
    talking: { on: { hangUp: { target: "idle" } } },
    missed: { type: "final" },
  },
});
