// test/fixtures/job.ts in yay-machine. It has no tasks or timers of its own: both are a state's
// `onEnter` side effect, whose returned tear-down runs when the state exits (the library's way to
// tie resources to a state). The task's result, failure and the timeout come back as events.

import { defineMachine } from "yay-machine";

/** What the task does, swapped by each run. */
let save: (text: string, signal: AbortSignal) => Promise<string> = async () => "";
export function useSave(fn: (text: string, signal: AbortSignal) => Promise<string>): void {
  save = fn;
}

type JobState =
  | { readonly name: "idle" }
  | { readonly name: "saving"; readonly text: string }
  | { readonly name: "saved"; readonly id: string }
  | { readonly name: "failed"; readonly error: string };
type JobEvent =
  | { readonly type: "save"; readonly text: string }
  | { readonly type: "cancel" }
  | { readonly type: "retry" }
  | { readonly type: "stored"; readonly id: string }
  | { readonly type: "error"; readonly error: string }
  | { readonly type: "timeout" };

export const jobMachine = defineMachine<JobState, JobEvent>({
  initialState: { name: "idle" },
  states: {
    idle: { on: { save: { to: "saving", data: ({ event }) => ({ text: event.text }) } } },
    saving: {
      onEnter: ({ state, send }) => {
        const abort = new AbortController();
        save(state.text, abort.signal).then(
          (id) => abort.signal.aborted || send({ type: "stored", id }),
          (error: unknown) => abort.signal.aborted || send({ type: "error", error: String(error) }),
        );
        const timer = setTimeout(() => send({ type: "timeout" }), 20);
        return () => {
          abort.abort();
          clearTimeout(timer);
        };
      },
      on: {
        stored: { to: "saved", data: ({ event }) => ({ id: event.id }) },
        error: { to: "failed", data: ({ event }) => ({ error: event.error }) },
        timeout: { to: "failed", data: () => ({ error: "timed out" }) },
        cancel: { to: "idle" },
      },
    },
    failed: { on: { retry: { to: "idle" } } },
  },
});
