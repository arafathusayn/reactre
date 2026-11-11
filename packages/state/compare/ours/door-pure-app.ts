// The door app, walked with @reactre/state's pure transition: no actor.

import { initial, transition } from "@reactre/state";

import { doorMachine } from "../../test/fixtures/door.ts";

export function run(): string[] {
  let state = initial(doorMachine, undefined);
  const seen: string[] = [];
  for (const event of [
    { type: "push", by: "ann" },
    { type: "close" },
    { type: "lock", code: "1" },
    { type: "unlock", code: "2" },
    { type: "unlock", code: "1" },
  ] as const) {
    const r = transition(doorMachine, state, event);
    if (r.ok) seen.push(r.snapshot.state);
    state = r.snapshot;
  }
  return seen;
}
