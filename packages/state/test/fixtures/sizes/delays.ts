// What delays cost an app that uses them: a named delay, one read from the data at entry, and an
// ISO 8601 duration, in `after`.

import { createActor, setup, types } from "@reactre/state";
import { delays } from "@reactre/state/delays";

const reminder = setup({
  use: [delays],
  delays: { soon: "PT2S", sla: ({ data }: { data: { ms: number } }) => data.ms },
  states: { idle: types<{}>(), waiting: types<{ ms: number }>(), late: types<{}>(), done: types<{}>() },
  events: { start: types<{ ms: number }>(), answer: types<{}>() },
});

export const reminderMachine = reminder.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { start: ({ event, to }) => to("waiting", { ms: event.ms }) }, after: { P1D: ({ to }) => to("done") } },
    waiting: { after: { sla: ({ to }) => to("late") }, on: { answer: ({ to }) => to("done") } },
    late: { after: { soon: ({ to }) => to("done") } },
    done: { final: true },
  },
});

export function run(): string {
  const actor = createActor(reminderMachine);
  actor.send({ type: "start", ms: 1000 });
  actor.send({ type: "answer" });
  return actor.snapshot().state;
}
