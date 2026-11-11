// How fast each library runs the door: transitions through an actor (with one listener, as an app
// has), pure transitions with no actor, and creating and stopping actors. Each (library, case)
// runs in a process of its own, one after another, so no case warms or slows another; a case runs
// only for the libraries that have it (drivers.ts). Every library runs its production build
// (NODE_ENV=production, no "development" condition); @reactre/state runs the compiler's output.
// Before timing, each case checks that push opens the door and close closes it, so no library is
// timed doing nothing.
//
// Run: bun packages/state/compare/bench.ts   (on a quiet machine: nothing else running)
//      bun packages/state/compare/bench.ts run <lib> <case>   (one case, printing ops/s)

import { join } from "node:path";

import { type CaseName, type Lib, type LibKey, LIBS } from "./drivers.ts";

const HERE = import.meta.dir;
const PROCESSES = 3;
const CASES = ["actor", "pure", "create"] as const satisfies readonly CaseName[];
const TITLES: { readonly [C in CaseName]: string } = {
  actor: "Send through an actor (1 listener): push, then close",
  pure: "Pure transition, no actor: push, then close",
  create: "Create an actor, subscribe, stop",
};

/** Operations per second: the median of 7 timed rounds, after a warm-up round. */
async function time(key: LibKey, which: CaseName): Promise<number> {
  const lib: Lib = LIBS[key];
  const setup = lib.cases[which];
  if (!setup) throw new Error(`${lib.name} has no ${which} case`);
  const { ops, run, check } = await setup();
  const [opened, closed] = check();
  if (opened !== "open" || closed !== "closed")
    throw new Error(`${lib.name} ${which}: push gave ${opened}, close gave ${closed}`);
  let calls = which === "create" ? 20_000 : 200_000;
  const t = performance.now();
  for (let i = 0; i < calls; i++) run();
  // A slow library gets fewer calls per round (about a second's worth), never fewer than 1,000.
  const warm = performance.now() - t;
  if (warm > 1000) calls = Math.max(1000, Math.round((calls * 1000) / warm));
  const rates: number[] = [];
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) run();
    rates.push((calls * ops) / ((performance.now() - t0) / 1000));
  }
  return rates.sort((a, b) => a - b)[3]!;
}

const [, , mode, lib, which] = process.argv;
if (mode === "run") {
  console.log(JSON.stringify(await time(lib as LibKey, which as CaseName)));
} else {
  const keys = Object.keys(LIBS) as LibKey[];
  const results: { [C in CaseName]?: { [K in LibKey]?: number } } = {};
  for (const c of CASES) {
    const row: { [K in LibKey]?: number } = {};
    for (const k of keys) {
      if (!(LIBS[k] as Lib).cases[c]) continue;
      // The median of PROCESSES processes: one process's JIT can settle on a slower plan for its
      // whole life (JSC lands about a third low on a send now and then), so one run isn't enough.
      const rates: number[] = [];
      for (let n = 0; n < PROCESSES; n++) {
        const p = Bun.spawnSync(["bun", join(HERE, "bench.ts"), "run", k, c], {
          cwd: join(HERE, "../../.."),
          env: { ...process.env, NODE_ENV: "production" },
        });
        if (p.exitCode !== 0) throw new Error(`${k} ${c}: ${p.stderr.toString()}`);
        rates.push(Number(p.stdout.toString().trim().split("\n").pop()));
      }
      row[k] = rates.sort((a, b) => a - b)[PROCESSES >> 1]!;
    }
    results[c] = row;
  }

  const f = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(1)}k`);
  for (const c of CASES) {
    const row = results[c]!;
    const ours = row.ours!;
    console.log(`\n### ${TITLES[c]}\n`);
    console.log("| Library | ops/s | vs @reactre/state |");
    console.log("| ------- | ----: | ----------------- |");
    const sorted = (Object.entries(row) as [LibKey, number][]).sort((a, b) => b[1] - a[1]);
    for (const [k, rate] of sorted) {
      const lib: Lib = LIBS[k];
      const note = lib.notes?.[c];
      const name = note ? `${lib.name} (${note})` : lib.name;
      const vs =
        k === "ours"
          ? "—"
          : rate <= ours
            ? `${(ours / rate).toFixed(1)}× slower`
            : `${(rate / ours).toFixed(2)}× faster`;
      console.log(`| ${name} | ${f(rate)} | ${vs} |`);
    }
  }
  await Bun.write(join(HERE, "results", "bench.json"), `${JSON.stringify({ bun: Bun.version, results }, null, 2)}\n`);
}
