// A durable machine whose "busy" node runs a "job" child with a task and a timer, for the
// parent-cancel/restart lifecycle: cancelling leaves the node, so the child's task is dropped and
// its timer cancelled; going again starts a new child at a new address, with new ids. The child's
// task is gated, so a test can finish it after the node exited and prove the result lands nowhere.
//
// Its own fixture, not ./parallel-children.ts's: that one proves a reenter restarts one region's
// child, this one proves a cancel stops the child and a restart starts a new one.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { durable } from "@reactre/state/durable";

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
      // The task is the side effect a cancel must drop: it waits for the test to finish it.
      task: {
        run: async ({ data, signal }) => ({ type: "started", id: await work(data.id, signal) }),
        error: ({ data, keep }) => keep("working", data),
      },
      on: {
        // The task's result ends the child, whose done moves the parent: a result that lands is
        // observable as the parent's move, and one dropped after a cancel is not.
        started: ({ event, to }) => to("done", { id: event.id }),
        finish: ({ data, to }) => to("done", { id: data.id }),
      },
      // A timer, so the child's entry is visible in the host's schedule and its cancel is provable.
      after: { "900ms": ({ data, to }) => to("done", { id: data.id }) },
    },
    done: { final: true },
  },
});

/** How the child's task waits for its result: the test resolves it, as the external host would. */
let work: (id: string, signal: AbortSignal) => Promise<string> = async (id) => id;

/** Make the child's task wait for `fn`'s promise: the test commits the result when it chooses. */
export function useWork(fn: (id: string, signal: AbortSignal) => Promise<string>): void {
  work = fn;
}

const parent = setup({
  use: [durable, children],
  shape: "emtn02o7",
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
