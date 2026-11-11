// What each library ships: the same apps, bundled for production (minified, one ES module,
// NODE_ENV=production), by esbuild and Rolldown. Each bundle is run, so a size is of a working app.
// An app is built only for the libraries that can write it (see each port's header): the job needs
// a task and a timer, the pure door a transition function with no actor.
//
// Run: bun packages/state/compare/size.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { build as esbuild } from "esbuild";
import { build as rolldown } from "rolldown";

import esbuildPlugin from "../plugin/esbuild.ts";
import rolldownPlugin from "../plugin/rolldown.ts";
import { type LibKey, LIBS } from "./drivers.ts";

const HERE = import.meta.dir;
const out = mkdtempSync(join(tmpdir(), "reactre-state-size-"));

/** Each app, and its entry per library that has it. */
const APPS: readonly { readonly title: string; readonly entries: { readonly [K in LibKey]?: string } }[] = [
  {
    title: "door: an actor, plain transitions",
    entries: {
      ours: "../test/fixtures/door-app.ts",
      xstate: "./xstate/door-app.ts",
      xstate5: "./xstate5/door-app.ts",
      robot3: "./robot3/door-app.ts",
      store: "./store/door-app.ts",
      tsfsm: "./tsfsm/door-app.ts",
      yay: "./yay/door-app.ts",
      doeixd: "./doeixd/door-app.ts",
      hsm: "./hsm/door-app.ts",
      escapace: "./escapace/door-app.ts",
      jssm: "./jssm/door-app.ts",
    },
  },
  {
    title: "job: an actor, a task and a timer",
    entries: {
      ours: "../test/fixtures/job-app.ts",
      xstate: "./xstate/job-app.ts",
      xstate5: "./xstate5/job-app.ts",
      yay: "./yay/job-app.ts",
      hsm: "./hsm/job-app.ts",
    },
  },
  {
    title: "door: pure transitions, no actor",
    entries: {
      ours: "./ours/door-pure-app.ts",
      xstate: "./xstate/door-pure-app.ts",
      xstate5: "./xstate5/door-pure-app.ts",
      store: "./store/door-pure-app.ts",
      doeixd: "./doeixd/door-pure-app.ts",
    },
  },
];
const NOTES: { readonly [K in LibKey]?: string } = { xstate: "xstate/fsm", xstate5: "`transition()`" };

type Bundler = (entry: string, file: string, ours: boolean) => Promise<void>;
const BUNDLERS: { readonly [name: string]: Bundler } = {
  esbuild: async (entry, file, ours) => {
    await esbuild({
      entryPoints: [entry],
      outfile: file,
      bundle: true,
      format: "esm",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      // @reactre/state's sources (its dist may not be built); "module" is esbuild's default, kept.
      conditions: ["reactre-source", "module"],
      plugins: ours ? [esbuildPlugin({ dev: false })] : [],
      logLevel: "silent",
    });
  },
  rolldown: async (entry, file, ours) => {
    await rolldown({
      input: entry,
      // @reactre/state's sources; the rivals resolve with Rolldown's defaults.
      ...(ours ? { resolve: { conditionNames: ["reactre-source", "import", "browser", "default"] } } : {}),
      plugins: ours ? [rolldownPlugin({ dev: false })] : [],
      transform: { define: { "process.env.NODE_ENV": '"production"' } },
      output: { file, format: "es", minify: true },
      logLevel: "silent",
    });
  },
};

export interface Size {
  readonly min: number;
  readonly gzip: number;
  readonly brotli: number;
}

async function measure(bundler: Bundler, entry: string, name: string, ours: boolean): Promise<Size> {
  const file = join(out, `${name}.mjs`);
  await bundler(join(HERE, entry), file, ours);
  const code = await Bun.file(file).bytes();
  const app: Partial<{ run(): unknown }> = await import(file);
  if (!("run" in app)) throw new Error(`${name}'s run is missing from its bundle`);
  await app.run!();
  return { min: code.length, gzip: gzipSync(code).length, brotli: brotliCompressSync(code).length };
}

const results: { app: string; lib: LibKey; sizes: { [bundler: string]: Size } }[] = [];
for (const [i, { title, entries }] of APPS.entries())
  for (const [lib, entry] of Object.entries(entries) as [LibKey, string][]) {
    const sizes: { [bundler: string]: Size } = {};
    for (const [bundlerName, bundler] of Object.entries(BUNDLERS))
      sizes[bundlerName] = await measure(bundler, entry, `${bundlerName}-${i}-${lib}`, lib === "ours");
    results.push({ app: title, lib, sizes });
  }
rmSync(out, { recursive: true, force: true });

const cell = (s: Size) => `${s.min} / ${s.gzip} / ${s.brotli}`;
for (const { title } of APPS) {
  const rows = results.filter((r) => r.app === title).sort((a, b) => a.sizes.esbuild!.gzip - b.sizes.esbuild!.gzip);
  const ours = rows.find((r) => r.lib === "ours")!;
  console.log(`\n### ${title}\n`);
  console.log("| Library | esbuild (min / gzip / br) | Rolldown (min / gzip / br) | esbuild gzip vs @reactre/state |");
  console.log("| ------- | ------------------------- | -------------------------- | ------------------------------ |");
  for (const r of rows) {
    const note = NOTES[r.lib];
    const name = note && title.includes("pure") ? `${LIBS[r.lib].name} (${note})` : LIBS[r.lib].name;
    const g = r.sizes.esbuild!.gzip / ours.sizes.esbuild!.gzip;
    const vs = r.lib === "ours" ? "—" : g >= 1 ? `${g.toFixed(1)}× larger` : `${(1 / g).toFixed(1)}× smaller`;
    console.log(`| ${name} | ${cell(r.sizes.esbuild!)} | ${cell(r.sizes.rolldown!)} | ${vs} |`);
  }
}
await Bun.write(join(HERE, "results", "sizes.json"), `${JSON.stringify(results, null, 2)}\n`);
