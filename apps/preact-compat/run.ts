// Preact compatibility check: runs the React compatibility scenarios (../react-compat: cases.tsx
// and the libraries-*.tsx files) in headless Chrome against preact/compat 11.1.0 and against
// @reactre/preact/compat, and compares every transcript (logged values and the HTML after each
// step) with Preact's, line for line.
//
// Preact is the oracle here, not React: @reactre/preact promises Preact's behavior, so a
// scenario where Preact differs from React must differ the same way. The React APIs preact/compat
// lacks are stubs that throw on both sides (stubs.ts).
//
//   bun run.ts [--runtimes reactre-preact,reactre-preact+compiler] [--only <text>] [--verbose]
//              [--dump <file>]
//
// `+compiler` compiles the scenarios' JSX with @reactre/preact/compiler. Exits non-zero when a
// scenario differs from Preact.

import { join } from "node:path";

import { reactrePreactCompiler } from "@reactre/preact/compiler";
import puppeteer from "puppeteer-core";

import { reactAlias as reactOnly } from "../react-compat/alias.ts";
import { findChrome } from "../react-compat/chrome.ts";
import { reactAlias, type Runtime } from "./alias.ts";

const scenarios = join(import.meta.dir, "../react-compat");

/** Bundles a page of ../react-compat for one runtime spec into one minified IIFE. */
async function bundle(entry: string, spec: string): Promise<string> {
  const [runtime, ...extras] = spec.split("+") as [Runtime | "react", ...string[]];
  const r = await Bun.build({
    entrypoints: [join(scenarios, entry)],
    format: "iife",
    minify: true,
    plugins: [
      ...(extras.includes("compiler") ? [reactrePreactCompiler({ source: "react" })] : []),
      runtime === "react" ? reactOnly("react") : reactAlias(runtime),
    ],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env": "undefined",
      "import.meta.url": JSON.stringify("about:blank"),
    },
  });
  if (!r.success) throw new Error(r.logs.join("\n"));
  return await r.outputs[0]!.text();
}

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runtimes = (opt("--runtimes") ?? "reactre-preact,reactre-preact+compiler").split(",");
const verbose = args.includes("--verbose");
const only = opt("--only");
/** A file for Preact's transcripts, to read what each scenario records. */
const dump = opt("--dump");

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });

/** Runs one bundled page in a fresh tab; its transcripts by scenario name. */
async function run(code: string, ssr: Record<string, string>): Promise<Record<string, string[]>> {
  const page = await browser.newPage();
  if (verbose) page.on("pageerror", (e) => console.log("  page error:", e instanceof Error ? e.message : String(e)));
  try {
    await page.setContent("<!doctype html><html><head></head><body></body></html>");
    await page.evaluate((s, o) => Object.assign(window, { __ssr: s, __only: o ?? undefined }), ssr, only ?? null);
    await page.addScriptTag({ content: code });
    await page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, { timeout: 120000 });
    return await page.evaluate(() => (window as unknown as { __results: Record<string, string[]> }).__results);
  } finally {
    await page.close();
  }
}

let failed = false;
try {
  // The hydration scenario's server HTML comes from React's renderer, as in ../react-compat.
  const ssrPage = await browser.newPage();
  await ssrPage.setContent("<!doctype html><html><body></body></html>");
  await ssrPage.addScriptTag({ content: await bundle("ssr.tsx", "react") });
  const ssr = await ssrPage.evaluate(() => (window as unknown as { __ssr: Record<string, string> }).__ssr);
  await ssrPage.close();

  const want = await run(await bundle("page.tsx", "preact"), ssr);
  if (dump !== undefined) await Bun.write(dump, JSON.stringify(want, null, 2));
  const names = Object.keys(want);
  const summary: string[] = [];
  for (const rt of runtimes) {
    let got: Record<string, string[]>;
    try {
      got = await run(await bundle("page.tsx", rt), ssr);
    } catch (e) {
      summary.push(`${rt}: did not run: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      failed = true;
      continue;
    }
    let pass = 0;
    const bad: string[] = [];
    for (const name of names) {
      const a = want[name]!,
        b = got[name] ?? ["(missing)"];
      const n = Math.max(a.length, b.length);
      let diff = -1;
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) ((diff = i), (i = n));
      if (diff < 0) {
        pass++;
        continue;
      }
      bad.push(name);
      console.log(`\n${rt} ✗ ${name}\n  preact: ${a[diff] ?? "(nothing)"}\n  ${rt}: ${b[diff] ?? "(nothing)"}`);
      if (verbose) {
        console.log("  --- preact ---\n  " + a.join("\n  "));
        console.log(`  --- ${rt} ---\n  ` + b.join("\n  "));
      }
    }
    summary.push(
      `${rt}: ${pass}/${names.length} scenarios match Preact` + (bad.length ? `; differ: ${bad.join("; ")}` : ""),
    );
    if (bad.length) failed = true;
  }
  console.log("\n" + summary.join("\n"));
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
