// What timeout costs an app that uses it: a deadline read from the data at entry, and one written
// as a duration, each with its onTimeout.

import { createActor, setup, types } from "@reactre/state";
import { timeout } from "@reactre/state/timeout";

const sla = setup({
  use: [timeout],
  states: { waiting: types<{ ms: number }>(), escalated: types<{}>(), done: types<{}>() },
  events: { answer: types<{}>() },
});

export const slaMachine = sla.machine({
  start: ({ to }) => to("waiting", { ms: 1000 }),
  states: {
    waiting: {
      timeout: ({ data }) => data.ms,
      onTimeout: ({ to }) => to("escalated"),
      on: { answer: ({ to }) => to("done") },
    },
    escalated: { timeout: "1h", onTimeout: ({ to }) => to("done"), on: { answer: ({ to }) => to("done") } },
    done: { final: true },
  },
});

export function run(): string {
  const actor = createActor(slaMachine);
  actor.send({ type: "answer" });
  return actor.snapshot().state;
}
