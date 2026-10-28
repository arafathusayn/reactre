// Standings pooled from several run.ts logs: every sample of each entry and test across the logs,
// each test's median, and the official weighted score.
//
// On a noisy machine one run swings an entry's score by several hundredths. A pool of runs with
// different --shift values steadies it, because each run puts every entry at a different place
// in each test's order, and drift that favors one place evens out across the pool.
//
//   bun pool.ts <log> [<log> ...]
//
// Each log is run.ts's standard output. Only the per-sample lines are read; the table at the end
// of each log is ignored and recomputed from the pooled samples.

import { benches, type Samples, standings } from "./run.ts";

// Samples by `${entry}|${test id}`, concatenated across every log.
const times: Samples = new Map();
// A sample line is `<test id> <entry> median <ms> <sample> <sample> ...`, as run.ts prints it.
for (const path of process.argv.slice(2))
  for (const line of (await Bun.file(path).text()).split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+median\s+\S+\s+(.*)$/.exec(line);
    if (m === null) continue;
    const key = `${m[2]}|${m[1]}`;
    times.set(key, [...(times.get(key) ?? []), ...m[3]!.trim().split(/\s+/).map(Number)]);
  }
const entries = [...new Set([...times.keys()].map((k) => k.split("|")[0]!))];
// Only tests every entry has samples for: a factor to the best median needs all entries.
const tests = benches.filter((b) => entries.every((e) => times.has(`${e}|${b.id}`)));
// The fewest samples any entry has for a test, reported so a thin pool is visible.
const n = (b: (typeof tests)[number]) => Math.min(...entries.map((e) => times.get(`${e}|${b.id}`)!.length));
console.log(
  `Pooled from ${process.argv.length - 2} logs, at least ${Math.min(...tests.map(n))} samples per test and entry\n`,
);
console.log(standings(entries, tests, times));
