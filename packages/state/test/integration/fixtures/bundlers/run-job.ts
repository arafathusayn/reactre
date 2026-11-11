// Executed from a bundle produced by the installed plugin and dist runtime: no source condition.
// A delayed send also proves that cancelling a state without a task cancels its timer by itself.
import { createActor } from "@reactre/state";

import { jobMachine } from "./job.ts";

export async function run(): Promise<{
  readonly done: unknown;
  readonly stale: unknown;
  readonly after: unknown;
}> {
  const actor = createActor(jobMachine);
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(s.state));
  actor.send({ type: "run" });
  // A timer-only state's cleanup, separately from the successful task's exit and final status.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stale = actor.send({ type: "stale" });
  const after = seen.slice();
  await new Promise((resolve) => setTimeout(resolve, 30));
  actor.stop();
  return { done: actor.snapshot(), stale, after };
}
