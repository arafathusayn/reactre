// test/fixtures/job.ts in XState v5: the task is an invoked `fromPromise` actor (its result
// `onDone`, its failure `onError`), the timer `after`. Both are cancelled when the state exits.

import { assign, fromPromise, setup } from "xstate";

/** What the task does, swapped by each run. */
let save: (text: string, signal: AbortSignal) => Promise<string> = async () => "";
export function useSave(fn: (text: string, signal: AbortSignal) => Promise<string>): void {
  save = fn;
}

export const jobMachine = setup({
  types: {
    context: {} as { text: string | null; id: string | null; error: string | null },
    events: {} as { type: "save"; text: string } | { type: "cancel" } | { type: "retry" },
  },
  actors: {
    store: fromPromise<string, { text: string }>(({ input, signal }) => save(input.text, signal)),
  },
}).createMachine({
  context: { text: null, id: null, error: null },
  initial: "idle",
  states: {
    idle: { on: { save: { target: "saving", actions: assign(({ event }) => ({ text: event.text })) } } },
    saving: {
      invoke: {
        src: "store",
        input: ({ context }) => ({ text: context.text ?? "" }),
        onDone: { target: "saved", actions: assign(({ event }) => ({ id: event.output })) },
        onError: { target: "failed", actions: assign(({ event }) => ({ error: String(event.error) })) },
      },
      on: { cancel: { target: "idle" } },
      after: { 20: { target: "failed", actions: assign({ error: "timed out" }) } },
    },
    saved: { type: "final" },
    failed: { on: { retry: { target: "idle" } } },
  },
});
