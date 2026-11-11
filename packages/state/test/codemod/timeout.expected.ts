// A call in XState v6: a state's timeout with onTimeout, entry as a function of enq, and a
// transition function that logs with enq.

import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { timeout } from "@reactre/state/timeout";

/** Who was rung, in order. */
export const rung: string[] = [];

const call = setup({
  use: [effects, timeout],
  states: {
    idle: types<{ to: string }>(),
    ringing: types<{ to: string }>(),
    talking: types<{ to: string }>(),
    missed: types<{ to: string }>(),
  },
  events: { dial: types<{ to: string }>(), answer: types<{}>(), hangUp: types<{}>() },
});

export const callMachine = call.machine({
  start: ({ to }) => to("idle", { to: "" }),
  states: {
    idle: {
      on: {
        dial: ({ event, enq, to }) => {
          enq.log("dialing", event.to);
          return to("ringing", { to: event.to });
        },
      },
    },
    ringing: {
      entry: ({ data, enq }) => {
        enq((to: string) => rung.push(to), data.to);
      },
      on: { answer: ({ data, to }) => to("talking", data) },
      timeout: 20,
      onTimeout: ({ data, to }) => to("missed", data),
    },
    talking: { on: { hangUp: ({ data, to }) => to("idle", data) } },
    missed: { final: true },
  },
});
