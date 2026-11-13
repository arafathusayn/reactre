// test/fixtures/job.ts in XState v6: the task is invoked async logic, its result `onDone`, its
// failure `onError`, and the timer `after`. Both are cancelled when the state exits.

import { createAsyncLogic, setup, types } from "xstate6";

/** What the task does, swapped by each run. */
let save: (text: string, signal: AbortSignal) => Promise<string> = async () => "";
export function useSave(fn: (text: string, signal: AbortSignal) => Promise<string>): void {
  save = fn;
}

const store = createAsyncLogic({
  run: ({ input, signal }: { input: { text: string }; signal: AbortSignal }) => save(input.text, signal),
});

export const jobMachine = setup({
  schemas: {
    context: types<{ text: string | null; id: string | null; error: string | null }>(),
    events: { save: types<{ text: string }>(), cancel: types<{}>(), retry: types<{}>() },
  },
  states: {
    saving: { schemas: { context: types<{ text: string }>() } },
    saved: { schemas: { context: types<{ id: string }>() } },
    failed: { schemas: { context: types<{ error: string }>() } },
  },
}).createMachine({
  context: { text: null, id: null, error: null },
  initial: "idle",
  states: {
    idle: { on: { save: ({ event }) => ({ target: "saving", context: { text: event.text, id: null, error: null } }) } },
    saving: {
      invoke: {
        src: store,
        input: ({ context }) => ({ text: context.text }),
        onDone: ({ event }) => ({ target: "saved", context: { text: null, id: event.output, error: null } }),
        onError: ({ event }) => ({ target: "failed", context: { text: null, id: null, error: String(event.error) } }),
      },
      on: { cancel: { target: "idle" } },
      after: { "20ms": { target: "failed", context: { text: null, id: null, error: "timed out" } } },
    },
    saved: { type: "final" },
    failed: { on: { retry: { target: "idle" } } },
  },
});
