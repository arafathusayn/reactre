// test/fixtures/door-app.ts in XState v6: the same events, the same states seen.

import { createActor } from "xstate6";

import { doorMachine } from "./door.ts";

export function run(): string[] {
  const actor = createActor(doorMachine).start();
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(String(s.value)));
  actor.send({ type: "push", by: "ann" });
  actor.send({ type: "close" });
  actor.send({ type: "lock", code: "1" });
  actor.send({ type: "unlock", code: "2" });
  actor.send({ type: "unlock", code: "1" });
  return seen;
}
