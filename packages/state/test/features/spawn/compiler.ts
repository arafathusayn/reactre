// spawn's compiler cases, collected by ../compiler.ts into test/compiler.test.ts. Names, keys,
// inputs and report events are typed; what compiler/features/spawn.ts checks is how a machine's
// calls go together: a key every spawn passes and a stop doesn't, a subscribeTo before its spawn.

import { readFileSync } from "node:fs";

import { type Case, change } from "../../sources.ts";

/** ./fixture.ts's pool, not persisted (its shape's hash is the fixture's). */
export const POOL = change(
  readFileSync(new URL("./fixture.ts", import.meta.url), "utf8").replace(/\n {2}shape: "\w+",/, ""),
  "use: [children, effects, spawn, persist],",
  "use: [children, effects, spawn],",
);
const ADD = `          enq.spawn("worker", { key: event.id, input: { id: event.id } });
          enq.subscribeTo("worker", { key: event.id, done: "finished" });
`;
const line = (source: string, text: string): number => source.split("\n").findIndex((l) => l.includes(text)) + 1;

const UNKEYED = change(POOL, 'enq.stop("worker", event.id);', 'enq.stop("worker");');
const EARLY = change(
  POOL,
  ADD,
  `          enq.subscribeTo("worker", { key: event.id, done: "finished" });
          enq.spawn("worker", { key: event.id, input: { id: event.id } });
`,
);

export const cases: Case[] = [
  [
    "M536: a stop without the key every spawn passes",
    UNKEYED,
    line(UNKEYED, 'enq.stop("worker")'),
    'every "worker" is spawned with a key: stop it by key, `enq.stop("worker", key)`',
  ],
  [
    "M537: a subscribeTo before its spawn",
    EARLY,
    line(EARLY, "enq.subscribeTo("),
    'subscribeTo("worker") before its spawn: spawn it first',
  ],
];
