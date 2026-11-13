// The job in XState v6 (compare/xstate/job.ts): invoked async logic with onDone and onError, a
// timer, and a final state.

import { setup, types } from "@reactre/state";

/** What the task does, swapped by each run. */
let save: (text: string, signal: AbortSignal) => Promise<string> = async () => "";
export function useSave(fn: (text: string, signal: AbortSignal) => Promise<string>): void {
  save = fn;
}

const store = ({ input, signal }: { input: { text: string }; signal: AbortSignal }) => save(input.text, signal);

const job = setup({
  states: {
    idle: types<{}>(),
    saving: types<{ text: string }>(),
    saved: types<{ id: string }>(),
    failed: types<{ error: string }>(),
  },
  events: { save: types<{ text: string }>(), cancel: types<{}>(), retry: types<{}>() },
  internal: { storeDone: types<{ output: Awaited<ReturnType<typeof store>> }>() },
});

export const jobMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      on: { cancel: ({ to }) => to("idle"), storeDone: ({ event, to }) => to("saved", { id: event.output }) },
      after: { "20ms": ({ to }) => to("failed", { error: "timed out" }) },
      task: {
        run: async ({ data, signal }) => ({
          type: "storeDone",
          output: await store({ input: { text: data.text }, signal }),
        }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
