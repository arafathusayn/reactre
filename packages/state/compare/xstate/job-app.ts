// test/fixtures/job-app.ts in XState v6.

import { createActor } from "xstate6";

import { jobMachine, useSave } from "./job.ts";

export async function run(): Promise<string[]> {
  useSave(async (text) => `id:${text}`);
  const actor = createActor(jobMachine).start();
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(String(s.value)));
  actor.send({ type: "save", text: "hi" });
  await new Promise((r) => setTimeout(r, 0));
  return seen;
}
