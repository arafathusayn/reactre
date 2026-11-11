// The app every bundler's plugin path builds: a plain machine, so the bundle is the actor and its
// table, and nothing of setup, types or the compiler.

import { createActor } from "@reactre/state";

import { doorMachine } from "./door.ts";

export function run(): string[] {
  const actor = createActor(doorMachine);
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(s.state));
  actor.send({ type: "push", by: "ann" });
  actor.send({ type: "close" });
  return seen;
}
