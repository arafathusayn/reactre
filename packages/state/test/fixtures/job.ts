// A machine with a task and a timer: compiled, it imports @reactre/state/tasks.

import { setup, types } from "@reactre/state";

/** What the task does, swapped by each test. A task's run may do anything: it is the effect. */
let save: (text: string, signal: AbortSignal) => Promise<string> = async () => "";
export function useSave(fn: (text: string, signal: AbortSignal) => Promise<string>): void {
  save = fn;
}

const job = setup({
  states: {
    idle: types<{}>(),
    saving: types<{ text: string }>(),
    saved: types<{ id: string }>(),
    failed: types<{ error: string }>(),
  },
  events: { save: types<{ text: string }>(), cancel: types<{}>(), retry: types<{}>() },
  internal: { stored: types<{ id: string }>() },
});

export const jobMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data, signal }) => ({ type: "stored", id: await save(data.text, signal) }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: {
        stored: ({ event, to }) => to("saved", { id: event.id }),
        cancel: ({ to }) => to("idle"),
      },
      after: { "20ms": ({ to }) => to("failed", { error: "timed out" }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
