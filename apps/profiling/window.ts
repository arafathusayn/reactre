// What the official duration measures for one click, per entry: the trace's duration and its
// commit count, largest gap between commits, and layouts (from jfb/trace.ts), median of several
// samples. For finding a runtime whose measured window holds more than its click's work (a
// second frame).
//
// The official window ends at a commit, not when the click's work ends, so a runtime that
// schedules work for a later frame can be charged for the wait. This tool shows the window's
// contents, so such a case can be told from slow code.
//
//   bun window.ts [entries] [benchmark id] [samples] [--events] [--save] [--flame] [--kinds]
//
// entries: comma-separated (default re,reactre-compat); benchmark id: default 01_run1k; samples:
// default 5.
//
// --events sums the window's trace events by name; --save writes each trace to
// apps/jfb/.cache/traces/<entry>-<id>-<sample>.json, for the DevTools Performance panel (Load
// profile). --flame merges the JS samples inside the windows into a self/total table and
// apps/jfb/.cache/traces/<entry>-<id>.svg. --kinds prints the medians of the window's main-thread
// time by kind (script, style, layout, paint, gc), each the union of its events' spans.
//
// Each sample is taken as run.ts takes it (the benchmark's browser flags, warmups, throttling,
// waits and forced GC), so the window here is the window the benchmark scores, though one browser
// serves every entry. The trace adds the v8 and compile categories, which run.ts leaves out, to
// show GC and compile time.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { byKind } from "jfb/kinds";
import { cache, root } from "jfb/prepare";
import { benches, startBrowser } from "jfb/run";
import { computeDuration } from "jfb/trace";

import { byFunction, callTree, type CpuProfile, flameSvg, fromTrace } from "./flame.ts";

// #region Options and setup

const entries = (process.argv[2] ?? "re,reactre-compat").split(",");
const id = process.argv[3] ?? "01_run1k";
const samples = Number(process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : 5);
const b = benches.find((x) => x.id === id)!;
// The checkout, served as run.ts serves it; pages are requested by full file path here.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const f = Bun.file(join(root, decodeURIComponent(new URL(req.url).pathname)));
    return (await f.exists()) ? new Response(f) : new Response("", { status: 404 });
  },
});
// The runner's own browser: same flags and viewport.
const browser = await startBrowser();
// run.ts's trace categories, plus V8's own, for the GC and compile events below.
const cats = [
  "disabled-by-default-v8.cpu_profiler",
  "blink.user_timing",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "v8",
  "disabled-by-default-v8.compile",
];
// #endregion

// #region Sampling and report

for (const e of entries) {
  const rows: string[] = [];
  const windows: CpuProfile[] = [];
  const kinds: Record<string, number[]> = { total: [], script: [], style: [], layout: [], paint: [], gc: [] };
  for (let i = 0; i < samples; i++) {
    const page = await browser.newPage();
    // A top 5 entry may serve from its package.json's js-framework-benchmark.customURL.
    const pkg = Bun.file(join(root, "frameworks/keyed", e, "package.json"));
    const custom = (await pkg.exists()) ? (await pkg.json())["js-framework-benchmark"]?.customURL : undefined;
    await page.goto(
      `http://127.0.0.1:${server.port}/frameworks/keyed/${e}${(custom ?? "/").replace(/\/?$/, "/")}index.html`,
    );
    await page.waitForSelector("#run");
    await b.init(page);
    if (b.throttle) await page.emulateCPUThrottling(b.throttle);
    // The same pauses and forced GC as run.ts's `measure`, so the window matches the scored one.
    await page.tracing.start({ categories: cats });
    await new Promise((r) => setTimeout(r, 50));
    await page.evaluate("window.gc({type:'major',execution:'sync',flavor:'last-resort'})");
    await b.run(page);
    await new Promise((r) => setTimeout(r, 100));
    const raw = new TextDecoder().decode((await page.tracing.stop())!);
    if (process.argv.includes("--save")) {
      mkdirSync(join(cache, "traces"), { recursive: true });
      await Bun.write(join(cache, "traces", `${e}-${id}-${i + 1}.json`), raw);
    }
    const t = JSON.parse(raw);
    const d = computeDuration(t.traceEvents);
    windows.push(...fromTrace(t.traceEvents, d.tsStart, d.tsEnd));
    kinds.total!.push(d.duration);
    for (const [k, v] of Object.entries(byKind(t.traceEvents, d.tsStart, d.tsEnd))) kinds[k]!.push(v);
    // GC inside the measured window, matched by name on any thread; events that started in the
    // window count whole.
    const ev = t.traceEvents as { name: string; ph: string; ts: number; dur?: number; pid: number }[];
    const gc = ev
      .filter((x) => x.ph === "X" && /GC|Scavenge|MarkCompact/i.test(x.name) && x.ts >= d.tsStart && x.ts <= d.tsEnd)
      .reduce((a, x) => a + (x.dur ?? 0) / 1000, 0);
    // Parsing and compiling inside the window: bytecode the forced GC discarded, which the click
    // then pays to compile again.
    const compile = ev
      .filter((x) => x.ph === "X" && /Compile|Parse/i.test(x.name) && x.ts >= d.tsStart && x.ts <= d.tsEnd)
      .reduce((a, x) => a + (x.dur ?? 0) / 1000, 0);
    rows.push(
      `${d.duration.toFixed(1)} ms (gc ${gc.toFixed(1)}, compile ${compile.toFixed(1)}, ${d.numberCommits} commits, gap ${d.maxDeltaBetweenCommits.toFixed(0)}, ${d.layouts} layouts)`,
    );
    if (process.argv.includes("--events")) {
      // Every complete event inside the window, summed by name (nested ones too).
      const by = new Map<string, number>();
      for (const x of ev) {
        if (x.ph !== "X" || x.ts < d.tsStart || x.ts > d.tsEnd) continue;
        by.set(x.name, (by.get(x.name) ?? 0) + (x.dur ?? 0) / 1000);
      }
      console.log(
        `  ${e} sample ${i + 1}: ` +
          [...by]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 14)
            .map(([k, v]) => `${k} ${v.toFixed(1)}`)
            .join(", "),
      );
    }
    await page.close();
  }
  if (process.argv.includes("--kinds")) {
    // The upper median, which is close enough for a diagnostic table.
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
    console.log(
      e.padEnd(24),
      Object.entries(kinds)
        .map(([k, xs]) => `${k} ${med(xs).toFixed(1).padStart(6)}`)
        .join("  "),
    );
    continue;
  }
  console.log(e.padEnd(15), rows.join(" | "));
  if (process.argv.includes("--flame")) {
    const tree = callTree(windows);
    const per = (v: number) => (v / samples).toFixed(2).padStart(7);
    console.log(`  JS samples in the window: ${per(tree.total)} ms per click; self, total, function:`);
    for (const f of byFunction(tree)
      .sort((a, b) => b.self - a.self)
      .slice(0, 18))
      console.log(`  ${per(f.self)} ${per(f.total)}  ${f.name}`);
    mkdirSync(join(cache, "traces"), { recursive: true });
    await Bun.write(
      join(cache, "traces", `${e}-${id}.svg`),
      flameSvg(tree, `${e} · ${id} · JS in the measured window, ${samples} clicks merged`),
    );
  }
}
// #endregion

await browser.close();
server.stop();
