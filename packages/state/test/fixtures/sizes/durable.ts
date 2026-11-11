// What durable costs an app that uses it: a machine with a task, run on an in-memory host.

import { setup, type Shape, types } from "@reactre/state";
import { durable, type Host } from "@reactre/state/durable";

const pay = setup({
  use: [durable],
  shape: "xo8idf5m",
  states: { idle: types<{}>(), paying: types<{ amount: number }>(), paid: types<{ id: string }>() },
  events: { go: types<{}>() },
  internal: { charged: types<{ id: string }>() },
});

export const payMachine = pay.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("paying", { amount: 5 }) } },
    paying: {
      task: {
        run: async ({ data }) => ({ type: "charged", id: `c${data.amount}` }),
        error: ({ to }) => to("idle"),
      },
      on: { charged: ({ event, to }) => to("paid", { id: event.id }) },
      // A charge that hangs gives up (M432: a task state needs a way out).
      after: { "30s": ({ to }) => to("idle") },
    },
    paid: { final: true },
  },
});

const steps = new Map<string, Promise<unknown>>();
const host: Host<Shape> = {
  now: () => 0,
  step: <T>(id: string, fn: () => Promise<T>) => {
    const known = steps.get(id) ?? fn();
    steps.set(id, known);
    // The journal holds this step's own result.
    return known as Promise<T>;
  },
  schedule: () => {},
  cancel: () => {},
  save: () => {},
};

export async function run(): Promise<string[]> {
  const job = durable(payMachine, host);
  await job.start();
  await job.send({ type: "go" });
  await new Promise((r) => setTimeout(r, 0));
  return [job.snapshot().state];
}
