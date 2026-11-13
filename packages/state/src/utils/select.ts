// @reactre/state/utils/select (prototype): a value derived from an actor's snapshot, told only when
// it changes (xstate docs: selectors.md). `select(actor, (s) => s.state)`, then `.get()` and
// `.subscribe(listener)`. React's `useSelector` (../entries/react.ts) is built on it.
//
// Design decisions:
//   - A function of this file, not a method of the actor, so an app that never selects ships none.
//   - `compare` (default `Object.is`) decides "changed": a selector that builds an object each time
//     takes a structural compare, or listeners hear every move.
//   - `actor.trigger.x()` isn't here: emit's `trigger(actor).x()` is that, typed by the machine.

import type { Actor, Shape, Snapshot } from "../index.ts";

/** A value derived from an actor's snapshot. */
export interface Selection<T> {
  /** The value now. */
  readonly get: () => T;
  /** Calls `listener` with each new value (not with the current one). Returns the unsubscribe. */
  readonly subscribe: (listener: (value: T) => void) => () => void;
}

/** `selector` over `actor`'s snapshot: its value now, and each time it changes (by `compare`). */
export function select<D extends Shape, T>(
  actor: Actor<D>,
  selector: (snapshot: Snapshot<D>) => T,
  compare: (a: T, b: T) => boolean = Object.is,
): Selection<T> {
  let seen = actor.snapshot();
  let value = selector(seen);
  let revision = 0;
  /** The value for the actor's snapshot now: recomputed only when the snapshot changed. */
  const get = (): T => {
    const s = actor.snapshot();
    if (s !== seen) {
      seen = s;
      const next = selector(s);
      if (!compare(value, next)) {
        value = next;
        revision++;
      }
    }
    return value;
  };
  return {
    get,
    subscribe: (listener) => {
      let last = get();
      let told = revision;
      return actor.subscribe(() => {
        const next = get();
        // Delivery follows the supplied comparison, including Object.is's NaN/signed-zero
        // behavior and comparators that deliberately report identical values as changed.
        if (told !== revision) {
          told = revision;
          if (!compare(last, next)) listener((last = next));
        }
      });
    },
  };
}
