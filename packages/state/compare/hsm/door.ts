// test/fixtures/door.ts in @stateforward/hsm, as its README writes it: a model built with
// `define`/`state`/`transition`, run on an `Instance` subclass by `start`, stopped by `stop`.
// - No per-state data: `by` and `code` are fields of the instance, written by transition
//   `effect`s; payloads ride in the event's `data`. The guard is `guard`.
// - No subscribe: each state's `entry` calls the one listener the instance is given (entry also
//   runs for the initial state, at `start`).
// - No pure transition: dispatch runs on a started instance.
// Its operations are typed `(ctx, instance: Instance, event)`, so they cast the instance to Door.
// States are reported by path: `/door/open`.

import * as hsm from "@stateforward/hsm";

export class Door extends hsm.Instance {
  by: string | null = null;
  code: string | null = null;
  constructor(readonly listener: (state: string) => void) {
    super();
  }
}

// Events are untyped beyond their name: `data` is `any` in the library's types.
export const Push = hsm.event("push");
export const Close = hsm.event("close");
export const Lock = hsm.event("lock");
export const Unlock = hsm.event("unlock");

const entered = (state: string) => hsm.entry((_ctx, door) => (door as Door).listener(state));

export const doorModel = hsm.define(
  "door",
  hsm.state(
    "closed",
    entered("closed"),
    hsm.transition(
      hsm.on(Push),
      hsm.target("../open"),
      hsm.effect((_ctx, door, event) => {
        (door as Door).by = event.data.by;
      }),
    ),
    hsm.transition(
      hsm.on(Lock),
      hsm.target("../locked"),
      hsm.effect((_ctx, door, event) => {
        (door as Door).code = event.data.code;
      }),
    ),
  ),
  hsm.state("open", entered("open"), hsm.transition(hsm.on(Close), hsm.target("../closed"))),
  hsm.state(
    "locked",
    entered("locked"),
    hsm.transition(
      hsm.on(Unlock),
      hsm.target("../closed"),
      hsm.guard((_ctx, door, event) => event.data.code === (door as Door).code),
    ),
  ),
  hsm.initial(hsm.target("closed")),
);

/** An event of the door, with its payload. */
export const push = (by: string): hsm.Event => ({ ...Push, data: { by } });
export const lock = (code: string): hsm.Event => ({ ...Lock, data: { code } });
export const unlock = (code: string): hsm.Event => ({ ...Unlock, data: { code } });
