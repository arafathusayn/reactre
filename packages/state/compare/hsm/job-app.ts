// test/fixtures/job-app.ts in @stateforward/hsm.

import * as hsm from "@stateforward/hsm";

import { Job, jobModel, Save, useSave } from "./job.ts";

export async function run(): Promise<string[]> {
  useSave(async (text) => `id:${text}`);
  const seen: string[] = [];
  const job = hsm.start(new Job((s) => seen.push(s)), jobModel);
  void job.dispatch({ ...Save, data: { text: "hi" } });
  await new Promise((r) => setTimeout(r, 0));
  return seen;
}
