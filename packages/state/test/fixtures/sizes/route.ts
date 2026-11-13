// What route costs an app that uses it: a shop whose checkout is routed to from anywhere.

import { createActor } from "@reactre/state";

import { shopMachine } from "../../features/route/machines.ts";

export function run(): string {
  const actor = createActor(shopMachine);
  actor.send({ type: "add" });
  actor.send({ type: "route", to: "checkout" });
  return actor.snapshot().state;
}
