// @reactre/state/utils/toPromise (prototype): an actor's end as a promise (xstate docs:
// inspection.md, testing.md). `await toPromise(createActor(loadLogic, { input }))`.
//
// Design decisions:
//   - It resolves with what a parent's `done` gets: actor logic's output, or a machine's final
//     `{ state, data }`. It rejects with a logic's error (its `error` state), as thrown.
//   - An actor stopped from outside never ends, so the promise never settles, as XState's: race it
//     with a timeout, or use `waitFor` with one.

import type { OutputOf } from "../features/logic/index.ts";
import { __outcome, type Observed } from "../features/logic/outcome.ts";
import type { Actor, Shape } from "../index.ts";

/**
 * Resolves with the actor's output when it ends (a machine's: its final `{ state, data }`); rejects
 * with a logic's error. A machine with no final state never ends, so its actor is refused.
 */
export function toPromise<D extends Shape>(
  actor: Actor<D> &
    ("~endless" extends keyof D
      ? {
          readonly "the machine has no final state, so toPromise never settles: use waitFor with a condition, waitFor(actor, (s) => s.state === ...)": never;
        }
      : unknown),
): Promise<OutputOf<D>>;
export function toPromise(actor: Observed): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ended = (): boolean => {
      if (actor.status() !== "done") return false;
      const end = __outcome(actor);
      if ("error" in end) reject(end.error);
      else resolve(end.output);
      return true;
    };
    if (ended()) return;
    const off = actor.subscribe(() => {
      if (ended()) off();
    });
  });
}
