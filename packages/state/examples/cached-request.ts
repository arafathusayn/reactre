import { signal } from "@reactre/core";
import { createActor } from "@reactre/state";

import { requestMachine } from "./request.machine.ts";

// The cache owns this controller; individual views own only their reactive subscriptions.
export function createCachedRequest() {
  const actor = createActor(requestMachine);
  const [snapshot, setSnapshot] = signal(actor.snapshot());
  const unsubscribe = actor.subscribe((next) => setSnapshot(() => next));
  return {
    actor,
    snapshot,
    dispose() {
      unsubscribe();
      actor.stop();
    },
  };
}
