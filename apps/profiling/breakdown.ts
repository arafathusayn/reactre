// Where one measured click's time goes, per entry: the click's main-thread events in the trace
// summed by kind (script, style, layout, paint and commit, gc). For telling a runtime's own cost
// from the browser's work.
//
//   bun breakdown.ts [entries] [op] [throttle] [--names]
//
// entries: comma-separated (default vanillajs,re,reactre-compat).
// op: run (create 1,000 rows) | runlots | update | select | swaprows | clear (default run).
// throttle: Chrome's CPU slowdown factor during the click (default 1).
// --names lists the top-level events by name instead of by kind.
//
// This is a quick, simplified setup, not the benchmark's: every op gets the same warmup (five
// rounds of create and clear, then a create unless the op creates), a plain headless Chrome, and
// a fixed 300 ms after the click. It counts everything from the click to the end of that wait,
// not the official window, so it suits comparing entries' shares, not their scores; window.ts
// measures the official window. Each figure is the mean of five samples.

import { join } from "node:path";

import { findChrome } from "jfb/chrome";
import { root } from "jfb/prepare";
import puppeteer from "puppeteer-core";

// #region Options and setup

const entries = (process.argv[2] ?? "vanillajs,re,reactre-compat").split(",");
const op = process.argv[3] ?? "run";
const throttle = Number(process.argv[4] ?? 1);
const byName = process.argv.includes("--names");
// The checkout, served as run.ts serves it; pages are requested by full file path here.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const f = Bun.file(join(root, decodeURIComponent(new URL(req.url).pathname)));
    return (await f.exists()) ? new Response(f) : new Response("", { status: 404 });
  },
});
// `--expose-gc` gives the page `window.gc` for the GC before each click.
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--js-flags=--expose-gc"],
});
// Trace event names mapped to the kind they count toward. A wider list than jfb/kinds.ts's, as
// it also covers script evaluation, style sheet parsing and older event names. Names not listed
// are left out of the totals.
const KINDS: Record<string, string> = {
  FunctionCall: "script",
  EventDispatch: "script",
  EvaluateScript: "script",
  "v8.callFunction": "script",
  RunMicrotasks: "script",
  TimerFire: "script",
  UpdateLayoutTree: "style",
  RecalculateStyles: "style",
  ParseAuthorStyleSheet: "style",
  Layout: "layout",
  PrePaint: "paint",
  Paint: "paint",
  PaintImage: "paint",
  CompositeLayers: "paint",
  Layerize: "paint",
  Commit: "paint",
  MajorGC: "gc",
  MinorGC: "gc",
  "V8.GCScavenger": "gc",
  "BlinkGC.AtomicPhase": "gc",
};
// #endregion

// #region Sampling and report

for (const e of entries) {
  const totals: Record<string, number> = {};
  for (let rep = 0; rep < 5; rep++) {
    const page = await browser.newPage();
    // A top 5 entry may serve from its package.json's js-framework-benchmark.customURL.
    const pkg = Bun.file(join(root, "frameworks/keyed", e, "package.json"));
    const custom = (await pkg.exists()) ? (await pkg.json())["js-framework-benchmark"]?.customURL : undefined;
    await page.goto(
      `http://127.0.0.1:${server.port}/frameworks/keyed/${e}${(custom ?? "/").replace(/\/?$/, "/")}index.html`,
    );
    await page.waitForSelector("#run");
    for (let i = 0; i < 5; i++) {
      await page.click("#run");
      await page.waitForSelector("tbody>tr:nth-of-type(1000)");
      await page.click("#clear");
      await page.waitForFunction(() => !document.querySelector("tbody>tr"));
    }
    if (op !== "run" && op !== "runlots") {
      await page.click("#run");
      await page.waitForSelector("tbody>tr:nth-of-type(1000)");
    }
    if (throttle > 1) await page.emulateCPUThrottling(throttle);
    await page.tracing.start({ categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8"] });
    // Collect the warmups' garbage first, so its collection does not land in the click's time.
    await page.evaluate("window.gc()");
    const sel = op === "select" ? "tbody>tr:nth-of-type(2)>td:nth-of-type(2)>a" : "#" + op;
    await page.click(sel);
    // Long enough for the click's frame to render and commit, even throttled.
    await new Promise((r) => setTimeout(r, 300));
    const trace = JSON.parse(new TextDecoder().decode((await page.tracing.stop())!)) as {
      traceEvents: { name: string; ph: string; dur?: number; tid: number; pid: number; ts: number }[];
    };
    // The click's dispatch fixes the thread to read: the renderer's main thread.
    const click = trace.traceEvents.find((x) => x.name === "EventDispatch" && x.ph === "X");
    const main = click
      ? trace.traceEvents.filter((x) => x.pid === click.pid && x.tid === click.tid && x.ph === "X" && x.ts >= click.ts)
      : [];
    // Top-level events only: skip any event inside another on the same thread.
    let end = 0;
    for (const x of main.sort((a, b) => a.ts - b.ts)) {
      if (x.ts < end) continue;
      const k = byName ? x.name : KINDS[x.name];
      if (!k) continue;
      // Divided by the five samples, so the totals are means per click.
      totals[k] = (totals[k] ?? 0) + (x.dur ?? 0) / 1000 / 5;
      end = x.ts + (x.dur ?? 0);
    }
    await page.close();
  }
  console.log(
    e.padEnd(16),
    Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k} ${v.toFixed(1)}`)
      .join("  "),
  );
}
// #endregion

await browser.close();
server.stop();
