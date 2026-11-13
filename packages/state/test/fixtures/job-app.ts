// An app of a machine with a task and a timer, as a bundler sees it.

import { createActor } from "@reactre/state";

import { jobMachine, useSave } from "./job.ts";

export async function run(): Promise<string[]> {
  useSave(async (text) => `id:${text}`);
  const actor = createActor(jobMachine);
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(s.state));
  actor.send({ type: "save", text: "hi" });
  await new Promise((r) => setTimeout(r, 0));
  return seen;
}
