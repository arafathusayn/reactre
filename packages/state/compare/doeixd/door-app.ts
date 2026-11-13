// test/fixtures/door-app.ts in @doeixd/machine: an actor over the typestate snapshots.

import { createActor } from "@doeixd/machine";

import { closed, type Door } from "./door.ts";

export function run(): string[] {
  const actor = createActor<Door>(closed);
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(s.context.state));
  actor.dispatch({ type: "push", args: ["ann"] });
  actor.dispatch({ type: "close", args: [] });
  actor.dispatch({ type: "lock", args: ["1"] });
  actor.dispatch({ type: "unlock", args: ["2"] });
  actor.dispatch({ type: "unlock", args: ["1"] });
  return seen;
}
