// @reactre/core/server/reaction: @reactre/core/features/reaction in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). An effect does not run on the
// server: `reaction` computes its value, as Solid 2.0's server `createEffect` does, and never
// applies it; with `ssrSource: "client"` it does not compute either.

import type { ReactionOptions } from "@reactre/core/features/reaction";
import { memo } from "@reactre/core/server";

/**
 * `reaction` from @reactre/core/features/reaction, on the server: `compute` runs, in a memo as
 * on the client, and `apply` does not. With `ssrSource: "client"`, neither runs: the reaction is
 * the client's alone.
 */
export function reaction<T>(
  compute: () => T,
  _apply: (value: T, prev: T | undefined) => void | (() => void),
  options?: ReactionOptions,
): void {
  if (options?.ssrSource !== "client") memo(compute);
}
