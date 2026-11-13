// What reenter costs an app that uses it: a retry that re-enters its leaf, so its timer restarts
// (the reenter graph, and the general lifecycle it needs).

import { createActor } from "@reactre/state";

import { fetcherMachine } from "../../features/reenter/machines.ts";

export function run(): string {
  const actor = createActor(fetcherMachine);
  actor.send({ type: "retry" });
  actor.stop();
  return actor.snapshot().state;
}
