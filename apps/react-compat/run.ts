// React compatibility check: runs the scenarios in cases.tsx and libraries-*.tsx in headless Chrome
// against React 19 and against each runtime that stands in for it, and compares every transcript
// (logged values and the HTML after each step) with React's, line for line.
//
// React itself is the oracle: no expected output is written by hand, so a scenario checks
// whatever React 19 does, including details no one thought to spell out. A real browser runs
// both sides, so DOM behavior (events, focus, form controls) is the browser's, not a mock's.
//
//   bun run.ts [--runtimes reactre-compat,reactre-compat+compiler,reactre-compat+core]
//              [--only <text>] [--verbose] [--dump <file>]
//
// Runtimes: `reactre-compat` is the default build, @reactre/compat, React's whole client API;
// `+compiler` compiles the scenarios' JSX to templates with @reactre/compat/compiler; `+core` is
// @reactre/compat/core, which an app chooses to leave class components out. The build aliases
// `react`, `react-dom` and their subpaths to the runtime, as a bundler plugin for a real app would.
//
// Exits non-zero when a scenario differs from React, except a `+core` scenario that differs only
// because it renders a class (those are listed as needing classes), or that needs a feature module
// core leaves out (NEEDS_FEATURES).
// --only runs just the scenarios whose names contain one of its comma-separated texts.
// --verbose prints the pages' console output and both full transcripts of each differing
// scenario. --dump writes React's transcripts to a file as JSON, to read what each scenario
// records.

import { join } from "node:path";

import { reactreCompatCompiler } from "@reactre/compat/compiler";
import puppeteer from "puppeteer-core";

import { withoutSlicing } from "../../packages/compat/src/withoutSlicing.ts";
import { reactAlias, type Runtime } from "./alias.ts";
import { findChrome } from "./chrome.ts";

// #region Building

const dir = import.meta.dir;

/**
 * Bundles a page entry for one runtime spec into a single IIFE script.
 *
 * "reactre-compat" is @reactre/compat, "+core" is @reactre/compat/core, and "+compiler" adds
 * @reactre/compat/compiler (the scenarios' JSX compiled to templates). Every side is a minified
 * production build, since production builds are what apps ship.
 */
async function bundle(entry: string, spec: string): Promise<string> {
  const [runtime, ...extras] = spec.split("+") as [Runtime, ...string[]];
  const r = await Bun.build({
    entrypoints: [join(dir, entry)],
    format: "iife",
    minify: true,
    plugins: [
      ...(extras.includes("compiler") ? [reactreCompatCompiler()] : []),
      reactAlias(runtime, { core: extras.includes("core") }),
      // @reactre/compat's core as its own builds compile it, without time slicing.
      withoutSlicing,
    ],
    // A classic script cannot hold `import.meta`, which some libraries read: for Vite's mode, or
    // pdf.js for paths it uses only under Node.
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env": "undefined",
      "import.meta.url": JSON.stringify("about:blank"),
    },
  });
  if (!r.success) throw new Error(r.logs.join("\n"));
  return await r.outputs[0]!.text();
}

// #endregion

// #region Options

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runtimes = (opt("--runtimes") ?? "reactre-compat,reactre-compat+compiler,reactre-compat+core").split(",");
/** Whether a runtime is ours, so its differences fail the check. */
const ours = (rt: string) => rt.startsWith("reactre-compat");
// What @reactre/compat/core throws when a class component renders.
const NO_CLASSES = "this build leaves class support out";
// Scenarios that need a feature module @reactre/compat/core leaves out on purpose, React's
// transition lanes (@reactre/compat/features/concurrent): without it a transition renders at once.
const NEEDS_FEATURES = new Set([
  "a transition undone keeps a select's selection",
  "view transitions: names, types and events",
]);
const verbose = args.includes("--verbose");
/** Only the scenarios whose names contain one of these comma-separated texts. */
const only = opt("--only");
/** A file for React's transcripts. */
const dump = opt("--dump");

// #endregion

// #region Running pages

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });

/**
 * Runs one bundled page.tsx in a fresh page and returns its transcripts by scenario name.
 *
 * Each runtime gets its own page, so no state leaks from one runtime's run into another's. `ssr`
 * is set on the window before the script runs, since the hydration scenario reads it at once.
 */
async function run(code: string, ssr: Record<string, string>): Promise<Record<string, string[]>> {
  const page = await browser.newPage();
  if (verbose) {
    page.on("console", (m) => console.log("  page:", m.text()));
    page.on("pageerror", (e) => console.log("  page error:", e instanceof Error ? e.message : String(e)));
  }
  try {
    await page.setContent("<!doctype html><html><head></head><body></body></html>");
    await page.evaluate((s, o) => Object.assign(window, { __ssr: s, __only: o ?? undefined }), ssr, only ?? null);
    await page.addScriptTag({ content: code });
    await page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, { timeout: 60000 });
    return await page.evaluate(() => (window as unknown as { __results: Record<string, string[]> }).__results);
  } finally {
    await page.close();
  }
}

// #endregion

// #region Comparing

let failed = false;
try {
  // The server HTML for hydration comes from React's own server renderer, once, and every
  // runtime hydrates the same markup.
  const ssrPage = await browser.newPage();
  await ssrPage.setContent("<!doctype html><html><body></body></html>");
  await ssrPage.addScriptTag({ content: await bundle("ssr.tsx", "react") });
  const ssr = await ssrPage.evaluate(() => (window as unknown as { __ssr: Record<string, string> }).__ssr);
  await ssrPage.close();

  // React's transcripts are the expected ones.
  const want = await run(await bundle("page.tsx", "react"), ssr);
  if (dump !== undefined) await Bun.write(dump, JSON.stringify(want, null, 2));
  const names = Object.keys(want);
  const summary: string[] = [];
  for (const rt of runtimes) {
    let got: Record<string, string[]>;
    try {
      got = await run(await bundle("page.tsx", rt), ssr);
    } catch (e) {
      summary.push(`${rt}: did not run: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      if (ours(rt)) failed = true;
      continue;
    }
    let pass = 0;
    const bad: string[] = [],
      classes: string[] = [],
      features: string[] = [];
    for (const name of names) {
      const a = want[name]!,
        b = got[name] ?? ["(missing)"];
      const n = Math.max(a.length, b.length);
      // The first differing line; one line is enough to point at the problem.
      let diff = -1;
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) ((diff = i), (i = n));
      if (diff < 0) {
        pass++;
        continue;
      }
      // @reactre/compat/core leaves classes out on purpose; a scenario it fails only for that is
      // reported apart and does not fail the check.
      if (ours(rt) && rt.includes("+core") && b.some((line) => line.includes(NO_CLASSES))) {
        classes.push(name);
        continue;
      }
      if (ours(rt) && rt.includes("+core") && NEEDS_FEATURES.has(name)) {
        features.push(name);
        continue;
      }
      bad.push(name);
      console.log(
        `\n${rt} ✗ ${name}\n  react: ${a[diff] ?? "(nothing)"}\n  ${rt.padStart(5)}: ${b[diff] ?? "(nothing)"}`,
      );
      if (verbose) {
        console.log("  --- react ---\n  " + a.join("\n  "));
        console.log(`  --- ${rt} ---\n  ` + b.join("\n  "));
      }
    }
    summary.push(
      `${rt}: ${pass}/${names.length} scenarios match React` +
        (classes.length ? `; need classes: ${classes.join("; ")}` : "") +
        (features.length ? `; need feature modules: ${features.join("; ")}` : "") +
        (bad.length ? `; differ: ${bad.join("; ")}` : ""),
    );
    if (ours(rt) && bad.length) failed = true;
  }
  console.log("\n" + summary.join("\n"));
} finally {
  await browser.close();
}
// #endregion

process.exit(failed ? 1 : 0);
