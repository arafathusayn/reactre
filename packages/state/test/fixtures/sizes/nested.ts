// What nested and history cost an app that uses them: the editor (a parent with a timer, `back`).

import { createActor } from "@reactre/state";

import { editorMachine } from "../editor.ts";

export function run(): string[] {
  const actor = createActor(editorMachine);
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(s.state));
  actor.send({ type: "open" });
  actor.send({ type: "submit", by: "ann" });
  actor.send({ type: "leave" });
  actor.send({ type: "resume" });
  actor.stop();
  return seen;
}
