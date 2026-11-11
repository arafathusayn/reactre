// What choice costs an app that uses it: an order routed by a choice state it never rests in.

import { createActor } from "@reactre/state";

import { orderMachine } from "../../features/choice/machines.ts";

export function run(): string {
  const actor = createActor(orderMachine);
  actor.send({ type: "checkout", total: 150, vip: false });
  return actor.snapshot().state;
}
