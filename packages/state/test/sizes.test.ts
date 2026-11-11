// What each opt-in costs, gzipped, the whole app bundled by esbuild with the plugin (minified,
// production). Two measures:
//   - listed: DOOR with `use: [feature]` (and what it needs), less DOOR alone. An opt-in a machine
//     doesn't use should cost nothing; one that costs bytes anyway is pinned here, with why.
//   - used: an app that uses the feature (./fixtures/sizes/<feature>.ts), its table included.
// Each is pinned to a budget: a change that grows one fails here, with the numbers. The bars of the
// core (door, job) are in ARCHITECTURE.md, "Size and speed".

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import esbuildPlugin from "@reactre/state/plugin/esbuild";
import { build } from "esbuild";

import { DOOR, withUse } from "./sources.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

/** The gzipped size of `entry`'s bundle. */
async function size(entry: string): Promise<number> {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    logLevel: "silent",
    // @reactre/state's sources, as the repository's own builds resolve them: dist may not be built.
    // "module" is esbuild's default, which a list of conditions replaces.
    conditions: ["reactre-source", "module"],
    plugins: [esbuildPlugin({ dev: false })],
  });
  const [file] = r.outputFiles;
  if (file === undefined) throw new Error(`no bundle for ${entry}`);
  // Run the exact emitted bundle, not just a source check: a size is of a working app. Bun supports
  // the emitted JS as a data URL, so no test runtime or written JS artifact is introduced.
  const { run } = (await import(`data:text/javascript;base64,${Buffer.from(file.contents).toString("base64")}`)) as {
    run(): unknown;
  };
  // No return-shape requirement: exporting and successfully invoking run proves the emitted app is
  // executable, including the `false` returned by an explicit refusal. Machine behavior stays in
  // the feature suites, not in a made-up size-fixture oracle.
  await run();
  return gzipSync(file.contents).length;
}

const sizes: { [what: string]: number } = {};
afterAll(() => console.log("gzipped bytes (esbuild):", JSON.stringify(sizes)));

describe("the core", () => {
  // door: a plain machine. job: a flat machine with a task and a timer (the lean lifecycle). The
  // job's goal is 940 (ARCHITECTURE.md, "Size and speed"), and its unchanged regression pin is
  // 1060. It currently measures 1119: an open failing gate, not an accepted new pin. Size history
  // before the listener round and the lean task's block: 1002 (1009 before those changes). The
  // lean lifecycle is about 220 of it (a task with its signal, timers, S6 to the task's error), the
  // job's table about 165, and the core's actor and step the rest. What is left of the gap is
  // behaviour: the listeners' re-told rounds (with try/finally, so a throwing listener doesn't stop
  // the next ones), `declined` apart from `unhandled`, the graph (`g`) and development freeze
  // (`d`) every step reads, and `~r` for persist and child.
  test.each([
    // The limit is 1.5 KB (the user's, 2026-11-10); these pins sit just above where each stands,
    // so a regression shows. +28 from 671/1002: listeners isolated from each other's throws, no
    // round without listeners, and the step's two direct calls (faster sends). Then +27/+29 from
    // 699/1029 for speed (compare/bench.ts): `to` compiled to the snapshot itself (-4/-1), one
    // frozen empty data shared by every state without data (+21/+21, 13 of it the freeze), the
    // listeners in an array (+6/+5), and the start entered without a move (+4/+4).
    ["door", "door-app.ts", 728],
    ["job", "job-app.ts", 1060],
  ] as const)("%s ships within its bar", async (name, file, bar) => {
    sizes[name] = await size(join(FIXTURES, file));
    expect(sizes[name]).toBeLessThanOrEqual(bar);
  });
});

// Each feature with what it needs, and what listing it on a machine that doesn't use it costs.
// Nothing, except: persist gives the machine the general lifecycle (`persist(actor)` reads the
// runners' work from it, and a machine that lists persist is one the app persists), and durable
// adds its marker (`u`), which `durable(machine, host)` checks.
const LISTED: readonly (readonly [feature: string, needs: readonly string[], budget: number])[] = [
  ["nested", [], 0],
  ["parallel", ["nested"], 0],
  ["history", ["nested"], 0],
  ["output", [], 0],
  ["choice", [], 0],
  ["route", [], 0],
  ["always", [], 0],
  ["reenter", [], 0],
  ["wildcards", [], 0],
  ["tags", [], 0],
  ["effects", [], 0],
  ["emit", ["effects"], 0],
  ["provide", [], 0],
  ["delays", [], 0],
  ["timeout", [], 0],
  ["children", [], 0],
  ["logic", [], 0],
  // wave1-actors: spawn needs effects. Listing inspect is using it: the machine's every step and
  // move go through its hooks, so an inspector given to createActor sees them (the hooks and the
  // logger's lines, about 565).
  ["spawn", ["effects"], 0],
  ["system", [], 0],
  ["inspect", [], 580],
  ["validate", [], 0],
  ["persist", [], 480],
  ["durable", [], 16],
];

describe("an opt-in a machine doesn't use", () => {
  const dir = join(import.meta.dir, "sizes-out");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = (source: string) =>
    `${source}\nexport function run(): string { return actor.send({ type: "push", by: "ann" }).snapshot.state; }\n`;

  test.each(LISTED)("%s", async (feature, needs, budget) => {
    const base = join(dir, "door.ts");
    writeFileSync(base, app(DOOR));
    const file = join(dir, `${feature}.ts`);
    writeFileSync(file, app(withUse([...needs, feature])));
    const cost = (await size(file)) - (await size(base));
    sizes[`listed ${feature}`] = cost;
    // A few bytes either way are gzip's: the import's name moves the dictionary.
    expect(cost).toBeLessThanOrEqual(budget === 0 ? 8 : budget);
  });
});

describe("an app that uses the feature", () => {
  // Each pin moved on 2026-11-10 with the core's speed work (see "the core" above): about +25 for
  // the shared frozen empty data, the listener array and the start without a move, less what
  // compiling `to` to the snapshot saved (the tuple and `__snap`'s copy; back and reenter steps
  // became objects too).
  test.each([
    // nested: + about 165 since wave 1 for parallel nodes inside regions (units found, entered and
    // placed all the way down), shallow history's steps, a compound done in a region, and each move
    // settled through the composed graph (`m.g`), which always, choice and reenter wrap.
    ["nested and history: the editor", "nested.ts", 2455],
    ["nested and parallel: the player", "parallel.ts", 1925],
    // always and choice: + the settle wrapper on the graph, with the eventless loop's guard (S50).
    ["always: a cart that settles eventless transitions", "always.ts", 1060],
    ["choice: an order routed by a choice state", "choice.ts", 1125],
    // output: + nested, and the parent's done found from the active nodes.
    ["output (with nested): a parent that completes", "output.ts", 2075],
    // reenter: + the general lifecycle (the timer restarts), and the graph that marks the move.
    ["reenter: a retry that restarts its leaf's timer", "reenter.ts", 1500],
    ["route: a checkout routed to from anywhere", "route.ts", 825],
    ["wildcards: a canvas with pointer.* and *", "wildcards.ts", 965],
    // tags: + nested, and hasTag and getMeta, which read the active nodes. Since wave 2 a final
    // state's tags, meta and description compile too (the fixture's final state has a tag).
    ["tags (with nested): a job read with hasTag and getMeta", "tags.ts", 1810],
    // wave1-actors: children, + about 320 since wave 1: a child's error and sent events (`x`, `o`),
    // the options a child inherits (clock, inspect with its path as id, system), registryKey, and
    // an end read by `__outcome` (a logic's output or error, a machine's final state).
    ["children: a page with an upload child", "children.ts", 2595],
    // validate: + the data transitions make (S23), ValidationError, a schema that throws (S24).
    ["validate: a form with Standard Schemas", "validate.ts", 2235],
    // persist: + migrations, with the stored JSON's check (S20–S22), about 1100 of it. Then about
    // +60 from 3209 for a bug fix: the reminder's saved delays wait past setTimeout's limit in parts
    // (../src/features/delays/saved.ts's `__wait`, llm:B2, apps:C24).
    ["persist: a reminder, persisted, migrated and restored", "persist.ts", 3275],
    // durable: 3176 before the children's hooks moved to their own module (`dk`, imported only by a
    // machine with children: ../src/features/durable/children.ts), 2615 after. M432: a task state
    // needs a way out, so the payment's task has a timeout (`after`), and the timers come in: 2851.
    // That includes about 135 of bug fixes in the run (dur:D3): delays's and timeout's timers (`l`)
    // run on a durable host, a timer's id is its delay instead of its place, and a machine that
    // records effects throws S12 (about 110 of it, the message).
    ["durable: a payment on a journaling host", "durable.ts", 2865],
    // durable with children: + the children hooks (the tree of runs, a child's error, logic children
    // journaled whole, their sent events), the children feature and the general lifecycle. 5610
    // before the label's failed task retried with reenter (a `to` to its own state left it failed):
    // + about 140 for reenter's graph, which marks the move so the task restarts. M432 and M475: a
    // task state needs a way out, and a retry waits, so the label has two timers (a hung purchase
    // restarts, a failed one retries a second later): 6005, with the durable run's fixes above. M461:
    // the label's task was a stub that resolved to a fixed code; it buys the label with a fetch and
    // the signal now, the app's own code (+about 70, no library bytes): 6080.
    ["durable (with children): a shipment whose label child is journaled", "durable-children.ts", 6095],
    // effects: + the general lifecycle (../src/run.ts, about 600), the recorder and step hook, the
    // dispatcher and the runners (fn, raise, sendTo, cancel, log, effect), about 1100; and about 340
    // for the lifecycle wrap that settles timers' and tasks' moves (`l`), a declining handler's
    // effects dropped, a restore's pending delays, and their ledger for persist.
    ["effects: a door with entry, exit, raises, a send, a log and a cleanup", "effects.ts", 3140],
    // emit: + effects, the emit runner and on(actor, ...)'s listeners.
    ["emit (with effects): a player heard through on", "emit.ts", 3225],
    // provide: + effects, the action runner, and provide(machine, ...).
    ["provide (with effects): named actions and a guard, one swapped", "provide.ts", 3145],
    // delays and timeout: + the general lifecycle and the timer resolved at entry (`l`, `w`). Their
    // deadlines are saved only with persist in use (../src/features/delays/saved.ts, its own
    // import): 1589 and 1318 before, when every app shipped the saving code. Then +67/+62 from
    // 1566/1298 for a bug fix (llm:B2, llm:B3, apps:C24): a delay past setTimeout's limit (2^31 − 1
    // ms, which it fires at once) is waited in parts (`__wait`), so a computed 30-day delay waits 30 days.
    ["delays: a named delay, one from the data, and ISO 8601", "delays.ts", 1640],
    ["timeout: a deadline from the data and a duration", "timeout.ts", 1365],
    // wave1-actors: logic, system, inspect and spawn.
    // logic: + children, the logic's table built at runtime with its lifecycle (start, received
    // events, the end), async logic's timeout (TimeoutError, S30, S31) and its recorded steps.
    ["logic (with children): a profile loaded by async logic", "logic.ts", 3310],
    // system: + children, createSystem's registry (S32) and the root's registration.
    ["system (with children): an order's payment reached by its key", "system.ts", 2795],
    // inspect: + the step and lifecycle hooks, and the logger's lines.
    ["inspect: a light with an inspector and a logger", "inspect.ts", 1215],
    // spawn: + effects and the general lifecycle, the spawned children by key with their reports,
    // their save, and the options they inherit (clock, inspect, logger, system). The restore wrap
    // (restoreActor) comes only with persist in use (../src/features/spawn/restore.ts): 5316 before,
    // when every spawn app shipped it, 5293 after, inheritance included.
    ["spawn (with children and effects): a pool of workers by key", "spawn.ts", 5325],
  ] as const)("%s", async (name, file, budget) => {
    sizes[name] = await size(join(FIXTURES, "sizes", file));
    expect(sizes[name]).toBeLessThanOrEqual(budget);
  });
});
