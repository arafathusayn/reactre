// A durable machine the integration tests run on a journaling host, compiled by the plugin as a
// build compiles it (../../compiled.ts registers it). A job that charges a card: the charge is a
// task (the side effect that must run once), a failure waits a second and retries, a hung charge
// gives up after a day, a `retry` event reenters the node at once, and a cancel leaves it.

import { setup, types } from "@reactre/state";
import { durable } from "@reactre/state/durable";
import { reenter } from "@reactre/state/reenter";

const job = setup({
  use: [durable, reenter],
  shape: "yvfow3xm",
  states: {
    idle: types<{}>(),
    charging: types<{ amount: number; tries: number }>(),
    retrying: types<{ amount: number; tries: number }>(),
    paid: types<{ id: string }>(),
    failed: types<{ error: string }>(),
  },
  events: { go: types<{}>(), cancel: types<{}>(), retry: types<{}>() },
  internal: { charged: types<{ id: string }>() },
});

export const jobMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("charging", { amount: 5, tries: 0 }) } },
    charging: {
      task: {
        run: async ({ data, signal }) => ({ type: "charged", id: await charge(data.amount, signal) }),
        // A failure waits a second, then charges again: a new entry, with the attempt counted.
        error: ({ data, to }) => to("retrying", { amount: data.amount, tries: data.tries + 1 }),
      },
      on: {
        charged: ({ event, to }) => to("paid", { id: event.id }),
        cancel: ({ to }) => to("idle"),
        // A retry now: reenter restarts the task with the new data (a `to` to the same leaf would
        // stay, and the task would keep running with the data it started with).
        retry: ({ data, reenter }) => reenter("charging", { amount: data.amount, tries: data.tries + 1 }),
      },
      // A hung charge gives up after a day: a host timer at its deadline, not a setTimeout.
      after: { "24h": ({ to }) => to("failed", { error: "timed out" }) },
    },
    retrying: {
      after: { "1s": ({ data, to }) => to("charging", { amount: data.amount, tries: data.tries }) },
    },
    paid: { final: true },
    failed: { final: true },
  },
});

/** The charge, swapped by each test: the side effect that must run once. */
let charge: (amount: number, signal: AbortSignal) => Promise<string> = async (amount) => `ch_${amount}`;
export function useCharge(fn: (amount: number, signal: AbortSignal) => Promise<string>): void {
  charge = fn;
}
