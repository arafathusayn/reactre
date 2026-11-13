// @reactre/state/utils/can (prototype): whether an event would move a snapshot (xstate docs:
// snapshots.md, `snapshot.can(event)`), through the pure `transition`: nothing runs, effects
// included. `can(machine, snapshot, event)`, or `can(machine, actor, event)` for an actor's snapshot
// (false once the actor isn't active).
//
// A snapshot is plain JSON here, and an actor doesn't hold its machine (that would cost every actor
// bytes), so the machine comes first. A declined event (a handler returned null) can't: it doesn't
// move. One that moves to the same state can.

import { __step, type Actor, type Machine, type SendEvent, type Shape, type Snapshot } from "../index.ts";
import type { __Compiled, __Event, __Snapshot } from "../internal.ts";

/** `can(machine, snapshot, { type: "submit" })`: the event would move the snapshot. */
export function can<D extends Shape>(machine: Machine<D>, at: Snapshot<D> | Actor<D>, event: SendEvent<D>): boolean;
export function can(
  m: __Compiled,
  at: __Snapshot | { readonly snapshot: () => __Snapshot; readonly status: () => string },
  event: __Event,
): boolean {
  if ("snapshot" in at && typeof at.snapshot === "function") {
    if (at.status() !== "active") return false;
    return __step(m, at.snapshot(), event, false).ok;
  }
  return __step(m, at as __Snapshot, event, false).ok;
}
