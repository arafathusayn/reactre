import { createActor } from "@reactre/state";

import { editorMachine, log } from "./installed-nested.ts";

/** Exercise hierarchy, parent cancellation, task delivery and final status from the installed build. */
export async function run(): Promise<{ state: string; status: string }> {
  const actor = createActor(editorMachine);
  actor.send({ type: "open" });
  actor.send({ type: "submit", by: "ann" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (log.join() !== "run ") throw new Error("the nested task did not run");
  actor.stop();

  const cancelled = createActor(editorMachine);
  cancelled.send({ type: "open" });
  cancelled.send({ type: "leave" });
  await new Promise((resolve) => setTimeout(resolve, 45));
  if (cancelled.snapshot().state !== "away") throw new Error("the parent timer ran after its region exited");
  cancelled.stop();

  return { state: actor.snapshot().state, status: actor.status() };
}
