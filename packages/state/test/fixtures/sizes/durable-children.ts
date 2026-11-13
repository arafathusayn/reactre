// What durable costs an app whose machine runs a child: the children hooks come in (`dk`).

import { setup, type Shape, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { durable, type Host } from "@reactre/state/durable";
import { reenter } from "@reactre/state/reenter";

// The label's task retries a second after it fails, and a purchase that hangs is restarted: reenter
// restarts it (a `to` to the same state would leave the hung task as it was). M432: a task state
// needs a way out; M475: a retry waits. The task buys the label from the carrier (M461: a task does
// its work, so it isn't a stub that reports a success it never earned).
async function buy(signal: AbortSignal): Promise<string> {
  const res = await fetch("/api/labels", { method: "POST", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const label = setup({
  use: [reenter],
  states: { buying: types<{}>(), retrying: types<{}>(), bought: types<{ code: string }>() },
  events: {},
  internal: { got: types<{ code: string }>() },
});

export const labelMachine = label.machine({
  start: ({ to }) => to("buying"),
  states: {
    buying: {
      task: {
        run: async ({ signal }) => ({ type: "got", code: await buy(signal) }),
        error: ({ to }) => to("retrying"),
      },
      on: { got: ({ event, to }) => to("bought", { code: event.code }) },
      after: { "30s": ({ reenter }) => reenter("buying") },
    },
    retrying: { after: { "1s": ({ to }) => to("buying") } },
    bought: { final: true },
  },
});

const ship = setup({
  use: [durable, children],
  shape: "efcsqf88",
  states: { idle: types<{}>(), shipping: types<{}>(), shipped: types<{ code: string }>() },
  events: { go: types<{}>() },
  children: { label: labelMachine },
});

export const shipMachine = ship.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("shipping") } },
    shipping: {
      children: {
        label: { done: ({ output, to }) => to("shipped", { code: output.state === "bought" ? output.data.code : "" }) },
      },
    },
    shipped: { final: true },
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
  const job = durable(shipMachine, host);
  await job.start();
  await job.send({ type: "go" });
  await new Promise((r) => setTimeout(r, 0));
  return [job.snapshot().state];
}
