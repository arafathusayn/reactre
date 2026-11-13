// How an actor ended, as code that waits for it reads it: a parent's child runner, subscription
// logic, `toPromise`. A module of its own, so each of them ships this and nothing else of logic.

import type { __Actor } from "../../index.ts";

/**
 * Internal: an actor as code that observes it reads it. The public `Actor` hides `~r`, which every
 * actor has: read here as optional, which both accept.
 */
export type Observed = Pick<__Actor, "snapshot" | "status" | "subscribe"> & { readonly "~r"?: __Actor["~r"] };

/**
 * Internal: how an ended actor ended: an actor of logic (its table has `lg`) with its output (`done`)
 * or its error (`error`); a machine with its final `{ state, data }`.
 */
export function __outcome(a: Observed): { readonly error: unknown } | { readonly output: unknown } {
  const { state, data } = a.snapshot();
  if (a["~r"]?.m?.lg === undefined) return { output: { state, data } };
  // The cast: a logic's `done` and `error` states hold `{ output }` and `{ error }`.
  const end = data as { readonly output?: unknown; readonly error?: unknown };
  return state === "error" ? { error: end.error } : { output: end.output };
}
