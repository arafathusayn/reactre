// What wildcards cost an app that uses them: a canvas with "pointer.*" and "*" handlers.

import { createActor } from "@reactre/state";

import { canvasMachine } from "../../features/wildcards/machines.ts";

export function run(): string {
  const actor = createActor(canvasMachine);
  actor.send({ type: "pointer.down", x: 1 });
  actor.send({ type: "pointer.move", x: 2 });
  actor.send({ type: "key.escape" });
  return actor.snapshot().state;
}
