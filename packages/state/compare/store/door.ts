// test/fixtures/door.ts in @xstate/store. A store has no states, only context and an event-keyed
// reducer, so the nearest equivalent is a context that is a union tagged by `state` (which gives
// per-state data), and each reducer checks the state it may leave. A reducer that returns nothing
// leaves the store unchanged (no snapshot, no notification): that is the refusal. Its pure
// transition is `store.transition(snapshot, event)`; a store has `subscribe` but no `stop`.
//
// No job port: a store has effects (`enq.effect`), but no tasks it cancels and no timers.

import { createStoreConfig } from "@xstate/store";

export type Door =
  | { readonly state: "closed" }
  | { readonly state: "open"; readonly by: string }
  | { readonly state: "locked"; readonly code: string };

const start = (): Door => ({ state: "closed" });

export const doorStore = createStoreConfig({
  context: start(),
  on: {
    push: (door, e: { by: string }): Door | undefined =>
      door.state === "closed" ? { state: "open", by: e.by } : undefined,
    close: (door): Door | undefined => (door.state === "open" ? { state: "closed" } : undefined),
    lock: (door, e: { code: string }): Door | undefined =>
      door.state === "closed" ? { state: "locked", code: e.code } : undefined,
    unlock: (door, e: { code: string }): Door | undefined =>
      door.state === "locked" && door.code === e.code ? { state: "closed" } : undefined,
  },
});
