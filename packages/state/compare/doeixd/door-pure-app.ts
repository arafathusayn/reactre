// The door app, walked with @doeixd/machine's pure transitions: each method returns the next
// snapshot, typed by the state it leads to. Each state has only its own methods, so the walk
// narrows by which method a snapshot has.

import { closed, type Door } from "./door.ts";

export function run(): string[] {
  const seen: string[] = [];
  const step = <D extends Door>(next: D, prev: Door): D => {
    if (next !== prev) seen.push(next.context.state);
    return next;
  };
  const open = step(closed.push("ann"), closed);
  const shut = step(open.close(), open);
  const locked = step(shut.lock("1"), shut);
  const still = step(locked.unlock("2"), locked);
  if ("unlock" in still) step(still.unlock("1"), still);
  return seen;
}
