// @reactre/state/utils/assertEvent (prototype): narrows an event of a union to the types expected,
// or throws (xstate docs: testing.md). `assertEvent(event, "submit")`, or `["submit", "save"]`.
//
// A handler here is per event (`on: { submit: ({ event }) => ... }`), so its `event` is narrowed
// already: this is for app code that holds a union (an inspector's events, a parent's `on`).

import { StateError } from "../index.ts";

/**
 * Narrows `event` to the types given.
 *
 * @throws StateError S39 for an event of another type.
 */
export function assertEvent<E extends { readonly type: string }, T extends E["type"]>(
  event: E,
  type: T | readonly T[],
): asserts event is Extract<E, { readonly type: T }> {
  const types: readonly string[] = typeof type === "string" ? [type] : type;
  if (!types.includes(event.type))
    throw new StateError(
      "S39",
      `expected an event of type ${types.map((t) => `"${t}"`).join(" or ")}, and got "${event.type}": check where it was sent from.`,
    );
}
