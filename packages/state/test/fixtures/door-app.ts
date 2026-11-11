// An app of one plain machine, as a bundler sees it.

import { createActor } from "@reactre/state";

import { doorMachine } from "./door.ts";

export function run(): string[] {
  const actor = createActor(doorMachine);
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(s.state));
  actor.send({ type: "push", by: "ann" });
  actor.send({ type: "close" });
  actor.send({ type: "lock", code: "1" });
  actor.send({ type: "unlock", code: "2" });
  actor.send({ type: "unlock", code: "1" });
  return seen;
}
