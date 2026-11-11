// test/fixtures/door.ts in Robot (robot3), as its docs write it: `state`, `transition`, `reduce`
// for context, `guard` for the code check. Robot has no per-state data, so `by` and `code` are
// fields of one context. The actor is `interpret(machine, onChange)`: `onChange` is its one
// listener (there is no `subscribe`) and a service has no `stop`. There is no pure transition:
// `send` needs a service.
//
// No job port: Robot's `invoke` runs a promise, but it has no timers (no `after`), so the job's
// 20ms timeout can't be written in it.

import { createMachine, guard, reduce, state, transition } from "robot3";

export interface DoorContext {
  readonly by: string | null;
  readonly code: string | null;
}
export type DoorEvent =
  | { readonly type: "push"; readonly by: string }
  | { readonly type: "close" }
  | { readonly type: "lock"; readonly code: string }
  | { readonly type: "unlock"; readonly code: string };

export const doorMachine = createMachine(
  "closed",
  {
    closed: state(
      transition(
        "push",
        "open",
        reduce((_: DoorContext, e: { by: string }): DoorContext => ({ by: e.by, code: null })),
      ),
      transition(
        "lock",
        "locked",
        reduce((_: DoorContext, e: { code: string }): DoorContext => ({ by: null, code: e.code })),
      ),
    ),
    open: state(transition("close", "closed")),
    locked: state(
      transition(
        "unlock",
        "closed",
        guard((ctx: DoorContext, e: { code: string }) => e.code === ctx.code),
      ),
    ),
  },
  (): DoorContext => ({ by: null, code: null }),
);
