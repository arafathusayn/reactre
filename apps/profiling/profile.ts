// CPU profiles of one benchmark operation, from Chrome's DevTools sampling profiler, for finding
// hot spots: self and total time by function, a flame graph, and the profile itself for the
// DevTools Performance panel.
//
// The benchmark's duration says how long a click takes; this says which functions the time goes
// to, so a change can target the code that costs the most.
//
//   bun profile.ts [op] [repeat] [--entry name] [--throttle n] [--out dir] [--lines f,g] [--cold]
//
// op: create | replace | update | select | swap | remove | runlots | add | clear (default update)
//
// Each op runs as the benchmark runs it: its setup clicks unsampled, five unsampled warmups, then
// `repeat` (default 10) sampled clicks, each sampled until the frame after it is drawn, under the
// benchmark's CPU throttling for that op (--throttle overrides). Many warm clicks on one page
// give the profiler enough samples to rank functions with short self times.
//
// The entry is reactre-compat by default; any of our entries (jfb/prepare.ts's OURS) is built
// unminified so the names are readable, and one of the top 5 loads as prepared. Written to --out
// (default apps/jfb/.cache/profiles): <entry>-<op>.svg, the flame graph of all sampled clicks,
// and <entry>-<op>.cpuprofile, the last click's profile. --lines lists the most sampled source
// lines of the named functions.
//
// --cold profiles the click the benchmark measures instead: the runner's browser, the
// benchmark's own setup and warmup (fewer clicks than the warm default, so less optimized code),
// its throttling and the forced GC before the click, on a new page for each of the `repeat`
// clicks. --no-inline builds reactre-compat's app without the compiler's inline component
// elements; --no-gc skips the forced GC (to see what it costs the click after it).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { findChrome } from "jfb/chrome";
import { buildEntry, cache, keyed, OURS, root } from "jfb/prepare";
import { benches, startBrowser } from "jfb/run";
import puppeteer, { type Page } from "puppeteer-core";

import { byFunction, callTree, type CpuProfile, flameSvg, hotLines } from "./flame.ts";

// #region Options and operations

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    cold: { type: "boolean", default: false },
    "no-inline": { type: "boolean", default: false },
    "no-gc": { type: "boolean", default: false },
    entry: { type: "string", default: "reactre-compat" },
    throttle: { type: "string" },
    lines: { type: "string" },
    out: { type: "string", default: join(cache, "profiles") },
  },
});
const op = positionals[0] ?? "update";
const repeat = Number(positionals[1] ?? 10);
const entry = values.entry!;

/** The CSS selector of a table cell: row n (1-based), column col. */
const sel = (n: number, col: number) => `tbody>tr:nth-of-type(${n})>td:nth-of-type(${col})`;
/**
 * A warm-mode operation: its CPU throttling (the benchmark's for the matching test), the clicks
 * that reset the page before each repetition, and the selector to click on repetition i.
 */
type Op = { throttle: number; setup?: string[]; click: (i: number) => string };
// Select clicks a different row each time (rows 2 to 51), so every click changes the selection;
// clicking the selected row again would do nothing.
const OPS: Record<string, Op> = {
  create: { throttle: 1, setup: ["#clear"], click: () => "#run" },
  replace: { throttle: 1, click: () => "#run" },
  update: { throttle: 4, click: () => "#update" },
  select: { throttle: 4, click: (i) => `${sel((i % 50) + 2, 2)}>a` },
  swap: { throttle: 4, click: () => "#swaprows" },
  remove: { throttle: 2, click: () => `${sel(4, 3)}>a>span` },
  runlots: { throttle: 1, setup: ["#clear"], click: () => "#runlots" },
  add: { throttle: 1, setup: ["#clear", "#run"], click: () => "#add" },
  clear: { throttle: 4, setup: ["#run"], click: () => "#clear" },
};
const spec = OPS[op];
if (spec === undefined) throw new Error(`unknown op ${op}; one of ${Object.keys(OPS).join(", ")}`);
/** The benchmark test each op matches; --cold runs that test's own setup and click. */
const BENCH: Record<string, string> = {
  create: "01_run1k",
  replace: "02_replace1k",
  update: "03_update10th1k_x16",
  select: "04_select1k",
  swap: "05_swap1k",
  remove: "06_remove-one-1k",
  runlots: "07_create10k",
  add: "08_create1k-after1k_x2",
  clear: "09_clear1k_x8",
};
const bench = benches.find((b) => b.id === BENCH[op])!;
const throttle = Number(values.throttle ?? (values.cold ? (bench.throttle ?? 1) : spec.throttle));

// #endregion

// #region Page setup

// The entry's page under the checkout. Our entries are rebuilt as <entry>-profile so the
// prepared, minified build that run.ts measures stays as it is.
let path = `frameworks/keyed/${entry}/`;
let bundle = "";
const ours = OURS[entry];
if (ours !== undefined) {
  await buildEntry(`${entry}-profile`, ours, { minify: false, inlineElements: !values["no-inline"] });
  bundle = await Bun.file(join(keyed, `${entry}-profile`, "dist/main.js")).text();
  path = `frameworks/keyed/${entry}-profile/`;
} else {
  // A top 5 entry may serve from its package.json's js-framework-benchmark.customURL, as run.ts
  // also handles.
  const pkg = Bun.file(join(keyed, entry, "package.json"));
  const custom = (await pkg.exists()) ? (await pkg.json())["js-framework-benchmark"]?.customURL : undefined;
  if (custom) path = `frameworks/keyed/${entry}${custom.replace(/\/?$/, "/")}`;
}

// The checkout, served as run.ts serves it; pages are always requested by full file path here.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const f = Bun.file(join(root, decodeURIComponent(new URL(req.url).pathname)));
    return (await f.exists()) ? new Response(f) : new Response("", { status: 404 });
  },
});
const profiles: CpuProfile[] = [];
// Cold mode uses the benchmark's own browser, flags and all, so the profiled click runs as the
// measured one does; warm mode needs only a plain headless Chrome.
const browser = values.cold
  ? await startBrowser()
  : await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });
/**
 * A fresh page on the entry, with the profiler enabled but not yet started. The 50 µs sampling
 * interval gives a click of a few milliseconds enough samples to rank its functions.
 */
const open = async () => {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/${path}index.html`);
  await page.waitForSelector("#run");
  const cdp = await page.createCDPSession();
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 50 });
  return { page, cdp };
};
/** Stops the profiler and keeps the profile. */
const stop = async (cdp: Awaited<ReturnType<typeof open>>["cdp"]) =>
  profiles.push(((await cdp.send("Profiler.stop")) as { profile: CpuProfile }).profile);
// A click, then the frame after it: the sample covers its style, layout and paint too. The
// setTimeout after requestAnimationFrame waits until that frame's rendering work has run.
const click = (p: Page, s: string) =>
  p.evaluate(
    (s) => (
      (document.querySelector(s) as HTMLElement).click(),
      new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    ),
    s,
  );
// #endregion

// #region Sampling

if (values.cold) {
  // A new page per click, as the benchmark measures: each click sees the code as optimized after
  // the benchmark's own warmup, no more.
  for (let i = 0; i < repeat; i++) {
    const { page, cdp } = await open();
    await bench.init(page);
    if (throttle > 1) await page.emulateCPUThrottling(throttle);
    if (!values["no-gc"]) await page.evaluate("window.gc({type:'major',execution:'sync',flavor:'last-resort'})");
    await cdp.send("Profiler.start");
    await bench.run(page);
    // Wait for the frame after the click, so its rendering work lands in the profile too.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
    await stop(cdp);
    await page.close();
  }
} else {
  const { page, cdp } = await open();
  // Every op but the creates acts on an existing table of 1,000 rows.
  if (op !== "create" && op !== "runlots") await click(page, "#run");
  for (let i = 0; i < 5 + repeat; i++) {
    // Setup runs at full speed and unsampled; only the op's own click is throttled and profiled.
    for (const s of spec.setup ?? []) await click(page, s);
    if (throttle > 1) await page.emulateCPUThrottling(throttle);
    // The first five rounds are warmups, unsampled.
    if (i >= 5) await cdp.send("Profiler.start");
    await click(page, spec.click(i));
    if (i >= 5) await stop(cdp);
    if (throttle > 1) await page.emulateCPUThrottling(1);
  }
}
await browser.close();
server.stop();

// #endregion

// #region Report

// The page's own code: its bundle (with our packages, unminified, in it). Samples with none of it
// on the stack (the harness's clicks and DOM polling) are totaled apart; GC and (program) count.
const tree = callTree(profiles, (url) => url.includes("/frameworks/keyed/"));
const fns = byFunction(tree);
/** A per-click millisecond figure, right-aligned for the tables. */
const ms = (v: number) => (v / repeat).toFixed(2).padStart(8);
console.log(
  `${entry} ${op}${values.cold ? " cold" : ""} (${throttle}x), ${repeat} clicks: ${(tree.total / repeat).toFixed(2)} ms busy per click`,
);
console.log("\n  self/click   total/click  function");
for (const f of fns.sort((a, b) => b.self - a.self).slice(0, 20))
  console.log(`  ${ms(f.self)}   ${ms(f.total)}   ${f.name}`);
console.log("\n  total/click  self/click   function");
for (const f of fns.sort((a, b) => b.total - a.total).slice(0, 20))
  console.log(`  ${ms(f.total)}   ${ms(f.self)}   ${f.name}`);
// The hot lines are looked up in our unminified bundle; for a top 5 entry `bundle` is empty and
// only the line numbers print.
if (values.lines) {
  const src = bundle.split("\n");
  const hot = hotLines(profiles, values.lines.split(","));
  const all = hot.reduce((a, h) => a + h.ticks, 0);
  console.log(`\n  share  line  (${values.lines})`);
  for (const h of hot.slice(0, 25))
    console.log(
      `  ${((h.ticks / all) * 100).toFixed(1).padStart(5)}%  ${h.fn}:${h.line}  ${(src[h.line - 1] ?? "").trim().slice(0, 110)}`,
    );
}
// The .cpuprofile holds one click, which the DevTools Performance panel opens; the SVG merges
// every click.
const out = values.out!;
mkdirSync(out, { recursive: true });
await Bun.write(join(out, `${entry}-${op}${values.cold ? "-cold" : ""}.cpuprofile`), JSON.stringify(profiles.at(-1)));
await Bun.write(
  join(out, `${entry}-${op}${values.cold ? "-cold" : ""}.svg`),
  flameSvg(
    tree,
    `${entry} · ${op}${values.cold ? " (cold, as measured)" : ""} (${throttle}x CPU) · ${repeat} clicks merged`,
  ),
);
console.log(`\nwrote ${join(out, `${entry}-${op}${values.cold ? "-cold" : ""}.svg`)} and .cpuprofile`);

// #endregion
