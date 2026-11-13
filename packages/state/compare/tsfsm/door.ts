// test/fixtures/door.ts in typescript-fsm, as its README writes it: a `SyncStateMachine` subclass
// with `t(from, event, to, callback)` rows, the callbacks bound to the instance by
// `addTransitions`. The library has states and event names only, so:
// - no per-state data or context: `by` and `code` are fields of the subclass, set by callbacks;
// - no event payloads: they are the callback's arguments (`syncDispatch(event, ...args)`);
// - no guards: `unlock`'s code check runs in `send`, before dispatching;
// - no subscribe: each transition's callback calls the one listener given to the constructor;
// - no pure transition, and no `stop` (an instance is dropped).
// `send` turns the door's event objects into `syncDispatch` calls, the API the bench sends.
//
// No job port: the library has async callbacks but no tasks it cancels and no timers.

import { type ITransition, type SyncCallback, SyncStateMachine, t } from "typescript-fsm";

export type DoorState = "closed" | "open" | "locked";
type Name = "push" | "close" | "lock" | "unlock";
export type DoorEvent =
  | { readonly type: "push"; readonly by: string }
  | { readonly type: "close" }
  | { readonly type: "lock"; readonly code: string }
  | { readonly type: "unlock"; readonly code: string };

export class Door extends SyncStateMachine<DoorState, Name> {
  by: string | null = null;
  code: string | null = null;
  constructor(readonly listener: (state: DoorState) => void) {
    super("closed");
    this.addTransitions(TRANSITIONS);
  }
  send(e: DoorEvent): boolean {
    switch (e.type) {
      case "push":
        return this.syncDispatch("push", e.by);
      case "close":
        return this.syncDispatch("close");
      case "lock":
        return this.syncDispatch("lock", e.code);
      case "unlock":
        return e.code === this.code && this.syncDispatch("unlock");
    }
  }
}

// A callback's arguments are `unknown` in the library's types (`(...args: unknown[]) => void`).
const TRANSITIONS: ITransition<DoorState, Name, SyncCallback>[] = [
  t("closed", "push", "open", function (this: Door, by: unknown) {
    this.by = String(by);
    this.listener("open");
  }),
  t("closed", "lock", "locked", function (this: Door, code: unknown) {
    this.code = String(code);
    this.listener("locked");
  }),
  t("open", "close", "closed", function (this: Door) {
    this.listener("closed");
  }),
  t("locked", "unlock", "closed", function (this: Door) {
    this.listener("closed");
  }),
];
