// @reactre/state: its mutations are the cases' own (./cases.ts). Its build is the compiler the
// bundler plugin runs; at start, the case runs compiled in development (data frozen), as the
// runtime plugin loads it.

import { compile, StateCompileError } from "../../compiler/index.ts";
import { type CaseModule, CASES, type Library, SAVE, SCENARIO, settle } from "./cases.ts";

const tail = (machine: string) =>
  `\nimport { createActor } from "@reactre/state";\nexport const actor = createActor(${machine});\n`;

interface Actor {
  send(event: object): unknown;
}

const ours: Library = {
  name: "@reactre/state",
  bases: {
    door: { port: "../../test/fixtures/door.ts", tail: tail("doorMachine") },
    job: { port: "../../test/fixtures/job.ts", tail: tail("jobMachine") },
  },
  cases: Object.fromEntries(CASES.map((c) => [c.id, c.ours])),
  preload: async () => {
    const { statePreload } = await import("../../plugin/runtime.ts");
    Bun.plugin(statePreload({ filter: /\/\.cases\/ours\/[^/]+\.ts$/ }));
  },
  build: (path, source) => {
    try {
      compile(path, source);
      return null;
    } catch (e) {
      if (e instanceof StateCompileError) return e.problems[0]?.message ?? e.message;
      throw e;
    }
  },
  drive: async (mod: CaseModule, base) => {
    if (base === "job") (mod.useSave as (fn: typeof SAVE) => void)(SAVE);
    const actor = mod.actor as Actor;
    for (const event of SCENARIO[base]) actor.send(event);
    await settle();
  },
};
export default ours;
