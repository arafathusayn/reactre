// The same job at version 1, for the migration test: a version-0 snapshot on disk (written by an
// older build) is migrated to this shape and resumed. The only change from version 0 is `tries` on
// `charging` and `retrying`, which the migration backfills with 0.
//
// `persist` is in use because `migrations(machine)` is persist's: it reads the stored JSON and runs
// the steps. `durable` is in use because the run resumes on a journaling host. The two don't
// conflict: a durable run has its own enter/commit and never reads the lifecycle persist's compiler
// adds.

import { appendFileSync } from "node:fs";

import { type Machine, setup, types } from "@reactre/state";
import { durable, type DurableSnapshot } from "@reactre/state/durable";
import { migrations, persist } from "@reactre/state/persist";

const job = setup({
  use: [durable, persist],
  version: 1,
  shape: "vk7hm87h",
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

/** The charge, swapped by the test: the side effect that must run once. */
let charge: (amount: number) => Promise<string> = async (amount) => `ch_${amount}`;
export function useCharge(fn: (amount: number) => Promise<string>): void {
  charge = fn;
}

export const jobMachineV1 = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("charging", { amount: 5, tries: 0 }) } },
    charging: {
      task: {
        // The work is the charge: recorded before it runs, so a resumed run can prove it ran once.
        run: async ({ data }) => {
          appendFileSync(ledger, "charge\n");
          return { type: "charged", id: await charge(data.amount) };
        },
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

/**
 * The migration from version 0: `charging` and `retrying` gain `tries`, backfilled with 0. A
 * version-0 snapshot's `charging` data is `{ amount }`, so the step adds the field the new shape
 * requires, and the resumed run continues in the correct typed state.
 */
export const migrate = migrations(jobMachineV1).from<
  0,
  { idle: {}; charging: { amount: number }; paid: { id: string }; failed: { error: string } }
>(({ state, data, to }) => {
  if (state === "charging") return to("charging", { amount: data.amount, tries: 0 });
  if (state === "paid") return to("paid", { id: data.id });
  if (state === "failed") return to("failed", { error: data.error });
  return to("idle");
});

/** The v1 machine's own saved-snapshot type: what `resume` takes, as the app's type gives it. */
export type JobV1Saved = DurableSnapshot<typeof jobMachineV1 extends Machine<infer D> ? D : never>;
