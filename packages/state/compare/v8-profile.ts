// bench.ts's cases for @reactre/state, in V8: the door compiled for production by the esbuild
// plugin (as an app ships it, but unminified so the profile names functions), run in headless
// Chrome. Apps run in browsers, so V8's view of the hot paths matters as much as Bun's (JSC).
//
// Run: bun packages/state/compare/v8-profile.ts time <actor|pure|create> [runs]
//      bun packages/state/compare/v8-profile.ts profile <actor|pure|create> [seconds] [name]
//
// - time: ops/s measured as bench.ts measures them (a warm-up round, then the median of 7 timed
//   rounds, but each round at least about 50 ms), each run on a fresh page; one line per run
//   (default 3 runs).
// - profile: the case in a hot loop for `seconds` (default 3) under DevTools' sampling profiler at
//   100 µs, then the functions by self time and the most sampled lines in the hottest ones. The
//   profile itself goes to out/prof/<name>.cpuprofile (default v8-<case>), which DevTools'
//   Performance panel loads.
//
// puppeteer-core is apps/profiling's dependency, resolved from there (this package doesn't depend
// on it); Chrome is found as apps/react-compat finds it ($CHROME first), with a fresh profile.

import { join } from "node:path";

import { build } from "esbuild";

import { byFunction, callTree, type CpuProfile, hotLines } from "../../../apps/profiling/flame.ts";
import { findChrome } from "../../../apps/react-compat/chrome.ts";
import esbuildPlugin from "../plugin/esbuild.ts";

const HERE = import.meta.dir;
const ROOT = join(HERE, "../../..");
type CaseName = "actor" | "pure" | "create";

// The cases as drivers.ts's `ours` writes them, with the same check: push opens, close closes.
const ENTRY = `
import { createActor, initial, transition } from "@reactre/state";
import { doorMachine } from "../test/fixtures/door.ts";

const PUSH = { type: "push", by: "ann" };
const CLOSE = { type: "close" };
const noop = () => {};

function make(which) {
  if (which === "actor") {
    const actor = createActor(doorMachine);
    actor.subscribe(noop);
    return { ops: 2, run: () => (actor.send(PUSH), actor.send(CLOSE)) };
  }
  if (which === "pure") {
    const s0 = initial(doorMachine, undefined);
    return {
      ops: 2,
      run: () => {
        const s1 = transition(doorMachine, s0, PUSH).snapshot;
        transition(doorMachine, s1, CLOSE);
      },
    };
  }
  return {
    ops: 1,
    run: () => {
      const a = createActor(doorMachine);
      a.subscribe(noop);
      a.stop();
    },
  };
}

function check() {
  const a = createActor(doorMachine);
  a.send(PUSH);
  const opened = a.snapshot().state;
  a.send(CLOSE);
  const closed = a.snapshot().state;
  if (opened !== "open" || closed !== "closed") throw new Error("push gave " + opened + ", close gave " + closed);
}

globalThis.__time = (which) => {
  check();
  const { ops, run } = make(which);
  let calls = which === "create" ? 20000 : 200000;
  const t = performance.now();
  for (let i = 0; i < calls; i++) run();
  const warm = performance.now() - t;
  // Unlike bench.ts, a fast round grows to about 50 ms: Chrome's clock is coarser than Bun's.
  if (warm > 1000 || warm < 50) calls = Math.max(1000, Math.round((calls * (warm > 1000 ? 1000 : 50)) / warm));
  const rates = [];
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) run();
    rates.push((calls * ops) / ((performance.now() - t0) / 1000));
  }
  return rates.sort((a, b) => a - b)[3];
};

globalThis.__loop = (which, seconds) => {
  check();
  const { run } = make(which);
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) for (let i = 0; i < 100000; i++) run();
};
`;

/** The parts of puppeteer-core this script uses (it is resolved at runtime, so typed here). */
interface Cdp {
  send(method: string, params?: object): Promise<unknown>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<A extends unknown[], R>(f: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
  createCDPSession(): Promise<Cdp>;
  close(): Promise<void>;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Puppeteer {
  launch(options: { executablePath: string; headless: boolean; args: string[] }): Promise<Browser>;
}
/** What the bundle puts on the page's global object. */
interface Bench {
  __time(which: CaseName): number;
  __loop(which: CaseName, seconds: number): void;
}

const [mode = "time", given = "actor", arg, name] = process.argv.slice(2);
if (mode !== "time" && mode !== "profile") throw new Error(`mode is time or profile, not ${mode}`);
if (given !== "actor" && given !== "pure" && given !== "create")
  throw new Error(`the case is actor, pure or create, not ${given}`);
const which: CaseName = given;

const bundled = await build({
  stdin: { contents: ENTRY, resolveDir: HERE, sourcefile: "v8-entry.ts", loader: "ts" },
  bundle: true,
  format: "iife",
  minify: false,
  write: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' },
  // @reactre/state's sources (its dist may not be built); "module" is esbuild's default, kept.
  conditions: ["reactre-source", "module"],
  plugins: [esbuildPlugin({ dev: false })],
});
const bundle = bundled.outputFiles[0]?.text;
if (bundle === undefined) throw new Error("no bundle");

// Cross-origin isolated, so `performance.now()` has Chrome's fine resolution (5 µs, not 100 µs): a
// timed round of the fast cases takes a few milliseconds.
const isolated = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
const server = Bun.serve({
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === "/bundle.js"
      ? new Response(bundle, { headers: { ...isolated, "content-type": "text/javascript" } })
      : new Response('<!doctype html><script src="/bundle.js"></script>', {
          headers: { ...isolated, "content-type": "text/html" },
        }),
});
const puppeteerPath = Bun.resolveSync("puppeteer-core", join(ROOT, "apps/profiling"));
const puppeteer = ((await import(puppeteerPath)) as { default: Puppeteer }).default;
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });
const open = async (): Promise<Page> => {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  return page;
};

try {
  if (mode === "time") {
    for (let r = 0; r < Number(arg ?? 3); r++) {
      const page = await open();
      const rate = await page.evaluate((w) => (globalThis as unknown as Bench).__time(w), which);
      console.log(JSON.stringify(rate));
      await page.close();
    }
  } else {
    const seconds = Number(arg ?? 3);
    const page = await open();
    const cdp = await page.createCDPSession();
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    await cdp.send("Profiler.start");
    await page.evaluate((w, s) => (globalThis as unknown as Bench).__loop(w, s), which, seconds);
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
    const file = join(HERE, "out/prof", `${name ?? `v8-${which}`}.cpuprofile`);
    await Bun.write(file, JSON.stringify(profile));

    const tree = callTree([profile], (url) => url.endsWith("/bundle.js"));
    const total = tree.total;
    const rows = byFunction(tree)
      .sort((a, b) => b.self - a.self)
      .slice(0, 14);
    const pct = (ms: number) => `${((ms / total) * 100).toFixed(1)}%`;
    console.log(`# V8 profile: ${which}, ${seconds}s (Chrome, headless), written to ${file}\n`);
    console.log("| Self | Total | Function (bundle line) |");
    console.log("| ---: | ----: | ---------------------- |");
    for (const r of rows) console.log(`| ${pct(r.self)} | ${pct(r.total)} | \`${r.name}\` |`);
    // The hottest lines of the hottest functions, with the bundle's text at each line.
    const lines = bundle.split("\n");
    const names = [...new Set(rows.slice(0, 6).map((r) => r.name.replace(/:\d+$/, "")))];
    const ticks = hotLines([profile], names);
    const all = ticks.reduce((n, t) => n + t.ticks, 0);
    console.log("\n| Ticks | Function | Line |");
    console.log("| ----: | -------- | ---- |");
    for (const t of ticks.slice(0, 14))
      console.log(
        `| ${((t.ticks / all) * 100).toFixed(1)}% | \`${t.fn}\` | \`${(lines[t.line - 1] ?? "").trim().slice(0, 110)}\` |`,
      );
  }
} finally {
  await browser.close();
  await server.stop();
}
