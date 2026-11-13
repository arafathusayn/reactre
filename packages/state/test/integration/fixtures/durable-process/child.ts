// A durable machine whose "busy" node runs a "job" child with a task, for the process-boundary
// child test: the child's task appends to a ledger before it waits, so a SIGKILL mid-task leaves
// the entry on disk and the resume must replay the committed step result instead of running the
// task again. Its own fixture, not ./job.ts's (that one has no child): the crash tests' machines
// keep their shapes and versions untouched.
//
// The parent also persists a `version`, so the test can prove the saved snapshot's version is
// carried across the process boundary unchanged.

import { appendFileSync } from "node:fs";

import { type Machine, setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { durable, type DurableSnapshot } from "@reactre/state/durable";

const job = setup({
  input: types<{ id: string }>(),
  states: { working: types<{ id: string }>(), done: types<{ id: string }>() },
  events: { finish: types<{}>() },
  internal: { started: types<{ id: string }>() },
});

export const jobMachine = job.machine({
  start: ({ input, to }) => to("working", { id: input.id }),
  states: {
    working: {
      // The child's side effect: one ledger line per real execution, written before the wait.
      task: {
        run: async ({ data }) => {
          appendFileSync(ledger, "charge\n");
          return { type: "started", id: await work(data.id) };
        },
        error: ({ data, keep }) => keep("working", data),
      },
      on: {
        started: ({ event, to }) => to("done", { id: event.id }),
        finish: ({ data, to }) => to("done", { id: data.id }),
      },
      after: { "900ms": ({ data, to }) => to("done", { id: data.id }) },
    },
    done: { final: true },
  },
});

/** Where the child's task records each real execution: one line per run. */
let ledger = "";
/** Point the task at `path`: the file the test counts executions in. */
export function useLedger(path: string): void {
  ledger = path;
}

/** How the child's task waits for its result: the test (the worker) decides. */
let work: (id: string) => Promise<string> = async (id) => id;
/** Make the child's task wait for `fn`'s promise. */
export function useWork(fn: (id: string) => Promise<string>): void {
  work = fn;
}

const parent = setup({
  use: [durable, children],
  version: 1,
  shape: "83q18cts",
  states: {
    idle: types<{ n: number }>(),
    busy: types<{ n: number }>(),
    finished: types<{ n: number }>(),
  },
  events: { go: types<{}>(), cancel: types<{}>() },
  children: { job: jobMachine },
});

export const parentMachine = parent.machine({
  start: ({ to }) => to("idle", { n: 0 }),
  states: {
    idle: { on: { go: ({ data, to }) => to("busy", { n: data.n + 1 }) } },
    busy: {
      children: {
        job: {
          input: ({ data }) => ({ id: `job-${data.n}` }),
          done: ({ data, to }) => to("finished", { n: data.n }),
        },
      },
      on: { cancel: ({ data, to }) => to("idle", { n: data.n }) },
    },
    finished: { final: true },
  },
});

/** The parent's own saved-snapshot type: what `resume` takes, as the app's type gives it. */
export type ParentSaved = DurableSnapshot<typeof parentMachine extends Machine<infer D> ? D : never>;
