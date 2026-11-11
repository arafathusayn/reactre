// @reactre/state/validate/decided (prototype): the check of a step decided outside a step. A
// timer's handler, a task's `error`, a timeout's and a child's reports reach the actor through the
// lifecycle's `go`, which no step hook sees, so the compiler wraps each one (with `validate` in use
// and a state with a schema): `__reactreStateDecided(handler, schemas.d, "a timer", 1)`. A module of
// its own, which the compiler imports (`Emitted.imports`): a machine without such a handler ships
// none of it.

import type { __Step } from "../../internal.ts";
import { __check } from "./index.ts";

/**
 * Internal: `handler`, checked: the data its step makes against the states' schemas (`data`).
 * `what` names it ("a timer"), and `state` is the position of its `state` argument, for the message.
 *
 * @throws ValidationError S23 where the handler ran (the timer's callback, the task's promise, the
 *   child's report): the machine doesn't move.
 */
export function __decided<A extends readonly unknown[], R extends __Step | null>(
  handler: (...args: A) => R,
  data: { readonly [leaf: string]: unknown },
  what: string,
  state: number,
): (...args: A) => R {
  return (...args) => {
    const step = handler(...args);
    if (step) __check(`${what} in state "${String(args[state])}"`, step, data);
    return step;
  };
}
