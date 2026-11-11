// What tags cost an app that uses them (with nested): a job read with hasTag and getMeta.

import { createActor } from "@reactre/state";
import { getMeta } from "@reactre/state/utils/getMeta";
import { hasTag } from "@reactre/state/utils/hasTag";

import { jobMachine } from "../../features/tags/machines.ts";

export function run(): readonly [boolean, unknown] {
  const actor = createActor(jobMachine);
  actor.send({ type: "save", text: "a" });
  const s = actor.snapshot();
  return [hasTag(jobMachine, s, "busy"), getMeta(jobMachine, s)];
}
