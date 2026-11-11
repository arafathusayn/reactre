// test/fixtures/door.ts in @doeixd/machine, as its README writes typestates: each state is its own
// machine type, with its own context (so per-state data, as here) and only its own transitions.
// A transition is a method returning the next immutable snapshot: that is the pure transition. The
// actor is `createActor(snapshot)`, sent `{ type, args }` events (its `send.push(...)` proxy builds
// the same event per call). The transition objects are made once, at module level; `closed` has
// no data, so its one snapshot is shared.
//
// No job port: async transitions are supported (an actor waits for them), but there are no
// timers, and no task that leaving a state cancels.

import { createMachine, type TypeState } from "@doeixd/machine";

export type Closed = TypeState<{ readonly state: "closed" }, { push(by: string): Open; lock(code: string): Locked }>;
export type Open = TypeState<{ readonly state: "open"; readonly by: string }, { close(): Closed }>;
export type Locked = TypeState<
  { readonly state: "locked"; readonly code: string },
  { unlock(code: string): Closed | Locked }
>;
export type Door = Closed | Open | Locked;

const closedTransitions = {
  push: (by: string): Open => createMachine({ state: "open", by } as const, openTransitions),
  lock: (code: string): Locked => createMachine({ state: "locked", code } as const, lockedTransitions),
};
const openTransitions = { close: (): Closed => closed };
const lockedTransitions = {
  unlock(this: Locked, code: string): Closed | Locked {
    return code === this.context.code ? closed : this;
  },
};

export const closed: Closed = createMachine({ state: "closed" } as const, closedTransitions);
