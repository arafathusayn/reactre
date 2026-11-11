// test/fixtures/door.ts in yay-machine, as its docs write it: states are a union tagged by `name`,
// so each state has its own data (as here); `data()` gives the target's, `when` guards. An instance
// (`newInstance().start()`) has `send`, `subscribe` and `stop`; there is no pure transition.

import { defineMachine } from "yay-machine";

export type DoorState =
  | { readonly name: "closed" }
  | { readonly name: "open"; readonly by: string }
  | { readonly name: "locked"; readonly code: string };
export type DoorEvent =
  | { readonly type: "push"; readonly by: string }
  | { readonly type: "close" }
  | { readonly type: "lock"; readonly code: string }
  | { readonly type: "unlock"; readonly code: string };

export const doorMachine = defineMachine<DoorState, DoorEvent>({
  initialState: { name: "closed" },
  states: {
    closed: {
      on: {
        push: { to: "open", data: ({ event }) => ({ by: event.by }) },
        lock: { to: "locked", data: ({ event }) => ({ code: event.code }) },
      },
    },
    open: { on: { close: { to: "closed" } } },
    locked: { on: { unlock: { to: "closed", when: ({ state, event }) => event.code === state.code } } },
  },
});
