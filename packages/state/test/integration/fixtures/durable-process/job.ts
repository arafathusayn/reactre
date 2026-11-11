// A durable machine for the process-boundary tests: a job that charges a card, gives up after a
// day, and retries a failure after a second. Its own fixture, not ../../durable/job.ts's, so the
// in-memory durable tests keep theirs untouched.
//
// The charge is a task: the side effect that must run exactly once across a crash. It appends to a
// file (the test's count of real executions, which survives the process) and then waits for the
// test to commit its result, so a process killed mid-charge leaves the charge pending, not done.

import { appendFileSync } from "node:fs";

import { type Machine, setup, types } from "@reactre/state";
import { durable, type DurableSnapshot } from "@reactre/state/durable";

const job = setup({
  use: [durable],
  shape: "dnga67tn",
  states: {
    idle: types<{}>(),
    charging: types<{ amount: number }>(),
    paid: types<{ id: string }>(),
    failed: types<{ error: string }>(),
  },
  events: { go: types<{}>() },
  internal: { charged: types<{ id: string }>() },
});

/** Where the charge records each real execution: one line per run, appended before it waits. */
let ledger = "";

/** Point the charge at `path`: the file the test counts executions in. */
export function useLedger(path: string): void {
  ledger = path;
}

/** How the charge waits for its result: the test resolves it, as the external host would. */
let wait: (() => Promise<string>) | null = null;

/** Make the charge wait for `fn`'s promise: the test commits the result when it chooses. */
export function useWait(fn: () => Promise<string>): void {
  wait = fn;
}

export const jobMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("charging", { amount: 5 }) } },
    charging: {
      task: {
        run: async () => {
          // The real execution: appended before the wait, so a kill after this line still counts it.
          appendFileSync(ledger, "charge\n");
          const id = wait === null ? "ch_1" : await wait();
          return { type: "charged", id };
        },
        error: ({ to }) => to("failed", { error: "declined" }),
      },
      on: { charged: ({ event, to }) => to("paid", { id: event.id }) },
      // A hung charge gives up after a day: a host timer at its deadline, not a setTimeout.
      after: { "24h": ({ to }) => to("failed", { error: "timed out" }) },
    },
    paid: { final: true },
    failed: { final: true },
  },
});

/** The machine's own saved-snapshot type: what `resume` takes, as the app's type gives it. */
export type JobSaved = DurableSnapshot<typeof jobMachine extends Machine<infer D> ? D : never>;
