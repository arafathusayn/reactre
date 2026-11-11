// test/fixtures/job-app.ts in yay-machine.

import { jobMachine, useSave } from "./job.ts";

export async function run(): Promise<string[]> {
  useSave(async (text) => `id:${text}`);
  const job = jobMachine.newInstance().start();
  const seen: string[] = [];
  job.subscribe(({ state }) => seen.push(state.name));
  job.send({ type: "save", text: "hi" });
  await new Promise((r) => setTimeout(r, 0));
  return seen;
}
