// A replica of js-framework-benchmark's CPU tests (webdriver-ts, puppeteer runner,
// krausest/js-framework-benchmark at prepare.ts's JFB_COMMIT) for the entries prepare.ts builds:
// the official keyed top 5 and ours (reactre, reactre-compat, React 19 and reactre-dom).
//
// It exists so our entries can be ranked against the official leaders on one machine, with the
// official tests, the official duration and the official weights, without the full upstream
// harness. Run prepare.ts first.
//
//   bun run.ts [--iterations 15] [--entries a,b] [--benchmarks 01_run1k,...] [--shift n] [--batch b]
//
// --iterations  samples per test and entry (select row takes 10 more, as upstream configures it)
// --entries     a comma-separated subset of the entries (default: the top 5, then ours)
// --benchmarks  a comma-separated subset of the test ids (default: all nine CPU tests)
// --shift       rotates every test's entry order further; see main
// --batch       interleaves the entries, b samples per fresh browser; see main
//
// As the official runner does (benchmarkRunner.ts, forkedBenchmarkRunnerPuppeteer.ts): per test
// and entry, a fresh browser that runs all of that entry's samples in a row (15, and 10 more for
// select row, as configured there), then closes. Entries never share a browser, so one entry's
// pages and forced GCs do not age another's compiled code.
//
// Per sample: a fresh page, the test's setup clicks and warmups (each waited for by its DOM
// check), CPU throttling where the test sets it, a trace around a forced GC and the measured
// click, and the duration from the trace (trace.ts, a port of the official computation).
//
// The entry order rotates from test to test, so drift in the machine's speed favors no one. Each
// test's median is divided by the best median of that test in this run, and an entry's score is
// the geometric mean of those factors with the official weights, as the results table computes
// it (1.000 = best on every test).

import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { findChrome } from "./chrome.ts";
import { byKind } from "./kinds.ts";
import { OURS, root, TOP5 } from "./prepare.ts";
import { computeDuration, NotOneClick } from "./trace.ts";

// #region Benchmark definitions

/** One official CPU test: how to set the page up, and the click it measures. */
export interface Bench {
  /** The official test id, e.g. "01_run1k"; logs and --benchmarks use it. */
  id: string;
  /** The row label in the official results table. */
  label: string;
  /** Chrome's CPU slowdown factor during the measured click; unset runs at full speed. */
  throttle?: number;
  /** Samples beyond --iterations (the official additionalNumberOfRuns). */
  extra?: number;
  /** The test's weight in the official weighted geometric mean. */
  weight: number;
  /** Setup and warmup clicks before tracing starts; each waits for its DOM result. */
  init(p: Page): Promise<void>;
  /** The measured click, and the wait for its DOM result. */
  run(p: Page): Promise<void>;
}

/** Warmup rounds before the measured click, as the official tests use. */
const WARMUP = 5;
/** The CSS selector of a table cell: row n (1-based), column col. */
const row = (n: number, col: number) => `tbody>tr:nth-of-type(${n})>td:nth-of-type(${col})`;

// The DOM checks below mirror the official tests' helpers. Each waits up to 20 s: a test that
// takes longer is broken, not slow, and should fail rather than hang the run.

/** Clicks `sel` once it exists. */
async function click(p: Page, sel: string): Promise<void> {
  await p.waitForSelector(sel, { timeout: 20000 });
  await p.click(sel);
}
/** Waits until `sel` exists. */
const exists = (p: Page, sel: string) => p.waitForSelector(sel, { timeout: 20000 }).then(() => {});
/** Waits until `sel` no longer exists. */
const gone = (p: Page, sel: string) =>
  p.waitForFunction((s) => !document.querySelector(s), { timeout: 20000 }, sel).then(() => {});
/** Waits until `sel`'s text contains `t`. */
const text = (p: Page, sel: string, t: string) =>
  p
    .waitForFunction((s, t) => document.querySelector(s)?.textContent?.includes(t) ?? false, { timeout: 20000 }, sel, t)
    .then(() => {});
/** Waits until `sel` has the class `c`. */
const hasClass = (p: Page, sel: string, c: string) =>
  p
    .waitForFunction((s, c) => document.querySelector(s)?.classList.contains(c) ?? false, { timeout: 20000 }, sel, c)
    .then(() => {});

/**
 * `n` rounds of create 1,000 rows then clear, the official warmup for the create and clear tests.
 * Row ids keep counting across rounds, so each round waits for its own first id.
 */
async function runClear(p: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await click(p, "#run");
    await text(p, row(1000, 1), ((i + 1) * 1000).toFixed());
    await click(p, "#clear");
    await gone(p, row(1000, 1));
  }
}

/**
 * The official tests and weights (webdriver-ts/src/benchmarksPuppeteer.ts,
 * webdriver-ts-results/src/Common.ts). Selectors, warmup counts and expected texts are kept as
 * upstream has them, so each entry does the same work before and during the measured click.
 */
export const benches: Bench[] = [
  {
    id: "01_run1k",
    label: "create rows",
    weight: 0.64280248137063,
    init: (p) => runClear(p, WARMUP),
    run: async (p) => {
      await click(p, "#run");
      await text(p, row(1000, 1), ((WARMUP + 1) * 1000).toFixed());
    },
  },
  {
    id: "02_replace1k",
    label: "replace all rows",
    weight: 0.5607178150466176,
    init: async (p) => {
      for (let i = 0; i < WARMUP; i++) {
        await click(p, "#run");
        await text(p, row(1, 1), (i * 1000 + 1).toFixed());
      }
    },
    run: async (p) => {
      await click(p, "#run");
      await text(p, row(1, 1), `${WARMUP * 1000 + 1}`);
    },
  },
  {
    id: "03_update10th1k_x16",
    label: "partial update",
    throttle: 4,
    weight: 0.5643800750716564,
    init: async (p) => {
      await click(p, "#run");
      await exists(p, row(1000, 1));
      for (let i = 0; i < 3; i++) {
        await click(p, "#update");
        await text(p, row(991, 2), " !!!".repeat(i + 1));
      }
    },
    run: async (p) => {
      await click(p, "#update");
      await text(p, row(991, 2), " !!!".repeat(4));
    },
  },
  {
    id: "04_select1k",
    label: "select row",
    throttle: 4,
    extra: 10,
    weight: 0.1925635870170522,
    init: async (p) => {
      await click(p, "#run");
      await text(p, row(1000, 1), "1000");
      for (let i = 0; i <= WARMUP; i++) {
        await click(p, `tbody>tr:nth-of-type(${i + 5})>td:nth-of-type(2)>a`);
        await hasClass(p, `tbody>tr:nth-of-type(${i + 5})`, "danger");
      }
    },
    run: async (p) => {
      await click(p, "tbody>tr:nth-of-type(2)>td:nth-of-type(2)>a");
      await hasClass(p, "tbody>tr:nth-of-type(2)", "danger");
    },
  },
  {
    id: "05_swap1k",
    label: "swap rows",
    throttle: 4,
    weight: 0.13200612879341714,
    init: async (p) => {
      await click(p, "#run");
      await exists(p, row(1000, 1));
      for (let i = 0; i <= WARMUP; i++) {
        await click(p, "#swaprows");
        await text(p, row(999, 1), i % 2 === 0 ? "2" : "999");
      }
    },
    run: async (p) => {
      await click(p, "#swaprows");
      await text(p, row(999, 1), WARMUP % 2 === 0 ? "999" : "2");
      await text(p, row(2, 1), WARMUP % 2 === 0 ? "2" : "999");
    },
  },
  {
    id: "06_remove-one-1k",
    label: "remove row",
    throttle: 2,
    weight: 0.5277091212292658,
    init: async (p) => {
      // Upstream's warmup: remove the row after the first `skip` rows WARMUP times, then once
      // more two rows further down, checking the neighbors' ids each time.
      const skip = 4;
      await click(p, "#run");
      await exists(p, row(1000, 1));
      for (let i = 0; i < WARMUP; i++) {
        const r = WARMUP - i + skip;
        await text(p, row(r, 1), `${r}`);
        await click(p, `${row(r, 3)}>a>span:nth-of-type(1)`);
        await text(p, row(r, 1), `${skip + WARMUP + 1}`);
      }
      await text(p, row(skip + 1, 1), `${skip + WARMUP + 1}`);
      await text(p, row(skip, 1), `${skip}`);
      await text(p, row(skip + 2, 1), `${skip + WARMUP + 2}`);
      await click(p, `${row(skip + 2, 3)}>a>span:nth-of-type(1)`);
      await text(p, row(skip + 2, 1), `${skip + WARMUP + 3}`);
    },
    run: async (p) => {
      await click(p, `${row(4, 3)}>a>span:nth-of-type(1)`);
      await text(p, row(4, 1), `${4 + WARMUP + 1}`);
    },
  },
  {
    id: "07_create10k",
    label: "create many rows",
    weight: 0.5644449600965534,
    init: (p) => runClear(p, WARMUP),
    run: async (p) => {
      await click(p, "#runlots");
      await exists(p, "tbody>tr:nth-of-type(10000)>td:nth-of-type(2)>a");
    },
  },
  {
    id: "08_create1k-after1k_x2",
    label: "append rows to large table",
    weight: 0.5508359820582848,
    init: async (p) => {
      await runClear(p, WARMUP);
      await click(p, "#run");
      await exists(p, row(1000, 1));
    },
    run: async (p) => {
      await click(p, "#add");
      await exists(p, row(2000, 1));
    },
  },
  {
    id: "09_clear1k_x8",
    label: "clear rows",
    throttle: 4,
    weight: 0.4225836631419211,
    init: async (p) => {
      await runClear(p, WARMUP);
      await click(p, "#run");
      await text(p, row(1000, 1), (WARMUP * 1000 + 1000).toFixed());
    },
    run: async (p) => {
      await click(p, "#clear");
      await gone(p, row(1000, 1));
    },
  },
];

// #endregion

// #region Browser and page setup

/** The trace categories the official runner records; trace.ts and kinds.ts read their events. */
const traceCategories = [
  "disabled-by-default-v8.cpu_profiler",
  "blink.user_timing",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
];
/** Resolves after `ms` milliseconds. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fresh headless Chrome for one run of samples. `--expose-gc` gives the page `window.gc` for
 * the forced GC before each measured click; `--disable-frame-rate-limit` lets frames commit as
 * soon as they are ready, so a click's commit is not held back to a display's refresh. The other
 * flags keep first-run prompts, sync and extensions out of the measured process.
 */
export async function startBrowser(): Promise<Browser> {
  const args = [
    "--window-size=1280,800",
    // JFB_JS_FLAGS adds V8 flags, for experiments only (the official runner sets none).
    `--js-flags=--expose-gc ${process.env["JFB_JS_FLAGS"] ?? ""}`.trim(),
    "--no-default-browser-check",
    "--disable-sync",
    "--no-first-run",
    "--disable-extensions",
    "--headless=new",
    "--disable-frame-rate-limit",
  ];
  // headless is false so Puppeteer adds no headless flag of its own; `--headless=new` above
  // picks the mode.
  return puppeteer.launch({
    headless: false,
    executablePath: findChrome(),
    args,
    defaultViewport: { width: 1280, height: 800 },
  });
}

/**
 * Serves the prepared js-framework-benchmark checkout on a free port, with the official layout:
 * entries load the shared stylesheet from /css and their own files from their folder. A
 * directory path serves its index.html.
 */
export function serveRoot(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = Bun.file(join(root, path.endsWith("/") ? path + "index.html" : path));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
}

/**
 * An entry's page: index.html, or under its package.json's js-framework-benchmark.customURL
 * (thane serves from /dist/). Our entries have no package.json and use the folder's index.html.
 */
async function pagePath(entry: string): Promise<string> {
  const pkg = Bun.file(join(root, "frameworks/keyed", entry, "package.json"));
  const custom = (await pkg.exists()) ? (await pkg.json())["js-framework-benchmark"]?.customURL : undefined;
  return (custom ?? "/").replace(/\/?$/, "/") + "index.html";
}

// #endregion

// #region Measuring

/** One sample's official duration, in milliseconds. */
export async function sample(browser: Browser, base: string, entry: string, b: Bench): Promise<number> {
  return (await measure(browser, base, entry, b)).duration;
}

/**
 * One sample: the click window's duration and its main-thread time by kind (kinds.ts), with
 * `script` always present.
 *
 * Each attempt opens a fresh page, so earlier samples leave no state in the DOM or the heap. A
 * trace without exactly one click is retried up to three attempts in all, as the official runner
 * repeats such a run; any other error, including a page error, fails the sample at once.
 */
export async function measure(
  browser: Browser,
  base: string,
  entry: string,
  b: Bench,
): Promise<Record<string, number> & { duration: number; script: number }> {
  for (let attempt = 1; ; attempt++) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      await page.goto(`${base}/frameworks/keyed/${entry}${await pagePath(entry)}`, { waitUntil: "load" });
      await exists(page, "#run");
      await b.init(page);
      if (b.throttle) await page.emulateCPUThrottling(b.throttle);
      await page.tracing.start({ screenshots: false, categories: traceCategories });
      // The official runner's pause after tracing starts, so the trace is recording before the
      // forced GC and the click.
      await wait(50);
      // A full, synchronous GC clears the garbage that setup and warmup left, so a collection of
      // that garbage does not land inside the measured window and charge it to the click.
      await page.evaluate("window.gc({type:'major',execution:'sync',flavor:'last-resort'})");
      await b.run(page);
      // The official runner's pause before tracing stops: the DOM check passes before the frame
      // commits, and the commit that ends the window must be in the trace.
      await wait(100);
      const buf = await page.tracing.stop();
      // Back to full speed: nothing after the trace is measured, so it need not run slowed.
      if (b.throttle) await page.emulateCPUThrottling(1);
      if (errors.length) throw new Error(`${entry}: page errors: ${errors.join("; ")}`);
      const trace = JSON.parse(new TextDecoder().decode(buf!)) as {
        traceEvents: Parameters<typeof computeDuration>[0];
      };
      const d = computeDuration(trace.traceEvents);
      const k = byKind(trace.traceEvents as unknown as Parameters<typeof byKind>[0], d.tsStart, d.tsEnd);
      return { ...k, duration: d.duration, script: k["script"]! };
    } catch (e) {
      if (!(e instanceof NotOneClick) || attempt >= 3) throw e;
    } finally {
      await page.close();
    }
  }
}

// #endregion

// #region Reporting

/** The median of `xs`: the middle value, or the mean of the two middle values. */
export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Samples by `${entry}|${test id}`. */
export type Samples = Map<string, number[]>;

/**
 * The standings as a Markdown table: each test's median per entry, its factor
 * to the best median, and the weighted geometric mean of the factors with the
 * official weights (1.000 = best on every test), best entry first.
 */
export function standings(entries: string[], tests: Bench[], times: Samples): string {
  const med = (e: string, b: Bench) => median(times.get(e + "|" + b.id)!);
  const best = tests.map((b) => Math.min(...entries.map((e) => med(e, b))));
  // A weighted geometric mean, computed in log space: exp(sum(w * ln f) / sum(w)).
  const score = (e: string) => {
    let g = 0,
      w = 0;
    tests.forEach((b, i) => {
      g += b.weight * Math.log(med(e, b) / best[i]!);
      w += b.weight;
    });
    return Math.exp(g / w);
  };
  const ranked = [...entries].sort((a, b) => score(a) - score(b));
  const head = ["test", ...ranked];
  const rows = tests.map((b, i) => [
    `${b.label}${b.throttle ? ` (${b.throttle}x)` : ""}`,
    ...ranked.map((e) => `${med(e, b).toFixed(1)} (${(med(e, b) / best[i]!).toFixed(2)})`),
  ]);
  rows.push(["**weighted score**", ...ranked.map((e) => `**${score(e).toFixed(3)}**`)]);
  return [head, head.map(() => "---"), ...rows].map((r) => "| " + r.join(" | ") + " |").join("\n");
}

// #endregion

// #region CLI

/** Parses the flags, runs every selected test for every entry, and prints the log and standings. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const entries = value("--entries")?.split(",") ?? [...TOP5, ...Object.keys(OURS)];
  const ids = value("--benchmarks")?.split(",");
  const iterations = Number(value("--iterations") ?? 15);
  // Each test rotates the entries' order by its index; --shift rotates it
  // further, so runs with different shifts put each entry in different
  // places in each test's order, and a pool of them evens out drift that
  // favors a place.
  const shift = Number(value("--shift") ?? 0);
  const batch = Number(value("--batch") ?? 0);
  const tests = ids ? benches.filter((b) => ids.includes(b.id)) : benches;
  const server = serveRoot();
  const base = `http://127.0.0.1:${server.port}`;
  const times: Samples = new Map();
  try {
    for (const [bi, b] of tests.entries()) {
      const order = entries.map((_, i) => entries[(i + bi + shift) % entries.length]!);
      const total = iterations + (b.extra ?? 0);
      // Without --batch, as the official runner: each entry's samples in one
      // browser, one entry after another. With it, the entries take turns,
      // `batch` samples each in a fresh browser, the order rotating each
      // round, so the machine's slow spells land on all of them alike.
      const per = batch > 0 ? batch : total;
      for (const e of order) times.set(e + "|" + b.id, []);
      for (let r = 0; r * per < total; r++) {
        for (let j = 0; j < order.length; j++) {
          const e = order[(j + r) % order.length]!;
          const ts = times.get(e + "|" + b.id)!;
          const browser = await startBrowser();
          try {
            for (let it = 0; it < per && ts.length < total; it++) ts.push(await sample(browser, base, e, b));
          } finally {
            await browser.close();
          }
        }
      }
      // One line per entry and test; pool.ts parses this format, so keep it stable.
      for (const e of order) {
        const ts = times.get(e + "|" + b.id)!;
        console.log(
          `${b.id.padEnd(22)} ${e.padEnd(16)} median ${median(ts).toFixed(1).padStart(7)}  ${ts.map((t) => t.toFixed(1)).join(" ")}`,
        );
      }
    }
  } finally {
    server.stop();
  }
  console.log(
    `\njs-framework-benchmark replica, ${iterations} iterations, median ms (factor to the best median)\n\n${standings(entries, tests, times)}`,
  );
}

// #endregion

// Run only as a script: pool.ts and the profiling tools import the definitions above.
if (import.meta.main) await main();
