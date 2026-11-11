// A durable machine whose charge can fail, for the retry-after-error test: a failure is a committed
// step result in the first process, and the retry is a host-driven timer in a second process. Its
// own fixture, so the crash tests' machine (./job.ts) keeps its shape.
//
// The charge appends to a ledger before it runs, so the test counts real executions across both
// processes: a retry must charge again (a new entry, a new id), and a replayed result must not.

import { appendFileSync } from "node:fs";

import { type Machine, setup, types } from "@reactre/state";
import { durable, type DurableSnapshot } from "@reactre/state/durable";

const job = setup({
  use: [durable],
  shape: "7agf3caa",
  states: {
    idle: types<{}>(),
    charging: types<{ amount: number; tries: number }>(),
    retrying: types<{ amount: number; tries: number }>(),
    paid: types<{ id: string }>(),
    failed: types<{ error: string }>(),
  },
  events: { go: types<{}>() },
  internal: { charged: types<{ id: string }>() },
});

/** Where the charge records each real execution: one line per run. */
let ledger = "";

/** Point the charge at `path`: the file the test counts executions in. */
export function useLedger(path: string): void {
  ledger = path;
}

/** How the charge behaves: the test swaps it (a failure, then a success). */
let charge: (amount: number, tries: number) => Promise<string> = async (amount) => `ch_${amount}`;

/** Make the charge `fn`: the test decides whether it fails. */
export function useCharge(fn: (amount: number, tries: number) => Promise<string>): void {
  charge = fn;
}

export const retryMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("charging", { amount: 5, tries: 0 }) } },
    charging: {
      task: {
        run: async ({ data }) => {
          // The real execution: appended before the work, so a failure still counts it.
          appendFileSync(ledger, "charge\n");
          return { type: "charged", id: await charge(data.amount, data.tries) };
        },
        // A failure waits a second, then charges again: a new entry, with the attempt counted.
        error: ({ data, to }) => to("retrying", { amount: data.amount, tries: data.tries + 1 }),
      },
      on: { charged: ({ event, to }) => to("paid", { id: event.id }) },
      after: { "24h": ({ to }) => to("failed", { error: "timed out" }) },
    },
    retrying: { after: { "1s": ({ data, to }) => to("charging", { amount: data.amount, tries: data.tries }) } },
    paid: { final: true },
    failed: { final: true },
  },
});

/** The retry machine's own saved-snapshot type: what `resume` takes, as the app's type gives it. */
export type RetrySaved = DurableSnapshot<typeof retryMachine extends Machine<infer D> ? D : never>;
