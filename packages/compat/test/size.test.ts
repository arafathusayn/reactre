// Size budgets for @reactre/compat's profiles, built as an app ships them: minified ESM for the
// browser, @reactre/dom bundled in, gzip -9. A profile that grows past its budget in sizes.json
// fails, so every byte added is a choice. When a change is worth its bytes, record the new sizes:
//
//   UPDATE_SIZES=1 bun test packages/compat/test/size.test.ts
//
// Profiles:
//   full  the default entry, React's whole client API with class components
//   core  @reactre/compat/core, the same without the feature modules: class components,
//         component stacks, React's handling of repeated keys and its render retry
//   jfb   the js-framework-benchmark React app (apps/jfb/app/main.jsx) on core, compiled to
//         templates: the benchmark's explicit choice to leave out class components, component
//         stacks, React's handling of repeated keys and its render retry (apps/jfb/prepare.ts
//         resolves the same)
//   full-compat  @reactre/full-compat's entry: full with time slicing compiled in and on

import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { reactreCompatCompiler } from "../src/compiler.ts";
import { withoutSlicing } from "../src/withoutSlicing.ts";

const src = (f: string): string => Bun.fileURLToPath(new URL(`../src/${f}`, import.meta.url));
const budgets = Bun.fileURLToPath(new URL("../sizes.json", import.meta.url));

/** Resolves react, react-dom and their subpaths to compat's core alone, with no feature module. */
const toCompat: Bun.BunPlugin = {
  name: "react-to-compat",
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, () => ({ path: src("core.ts") }));
  },
};

/** Resolves @reactre/compat's client entries to its sources, as @reactre/full-compat's build does. */
const toSources: Bun.BunPlugin = {
  name: "compat-sources",
  setup(build) {
    build.onResolve({ filter: /^@reactre\/compat(?:\/core|\/features\/[a-zA-Z]+)?$/ }, (args) => ({
      path: src(args.path === "@reactre/compat" ? "index.ts" : args.path.slice("@reactre/compat/".length) + ".ts"),
    }));
  },
};

const profiles: Record<string, () => Promise<Bun.BuildOutput>> = {
  // As @reactre/compat's builds compile its sources: core.ts without time slicing (src/withoutSlicing.ts).
  full: () =>
    Bun.build({
      entrypoints: [src("index.ts")],
      minify: true,
      target: "browser",
      format: "esm",
      plugins: [withoutSlicing],
    }),
  core: () =>
    Bun.build({
      entrypoints: [src("core.ts")],
      minify: true,
      target: "browser",
      format: "esm",
      plugins: [withoutSlicing],
    }),
  jfb: () =>
    Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL("../../../apps/jfb/app/main.jsx", import.meta.url))],
      minify: true,
      target: "browser",
      format: "esm",
      plugins: [reactreCompatCompiler(), toCompat, withoutSlicing],
      define: { "process.env.NODE_ENV": '"production"' },
    }),
  "full-compat": () =>
    Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL("../../full-compat/src/index.ts", import.meta.url))],
      minify: true,
      target: "browser",
      format: "esm",
      plugins: [toSources],
      define: { "globalThis.__REACTRE_SLICING__": "true" },
    }),
};

type Sizes = Record<string, { min: number; gzip: number }>;

test("every profile stays within its size budget", async () => {
  const measured: Sizes = {};
  for (const [name, build] of Object.entries(profiles)) {
    const r = await build();
    expect(r.success).toBe(true);
    const code = await r.outputs[0]!.text();
    measured[name] = { min: code.length, gzip: gzipSync(code, { level: 9 }).length };
  }
  if (process.env["UPDATE_SIZES"] === "1") await Bun.write(budgets, JSON.stringify(measured, null, 2) + "\n");
  const budget = (await Bun.file(budgets).json()) as Sizes;
  for (const name of Object.keys(profiles)) {
    expect({ name, ...measured[name]! }).toEqual({
      name,
      min: Math.min(measured[name]!.min, budget[name]!.min),
      gzip: Math.min(measured[name]!.gzip, budget[name]!.gzip),
    });
  }
});
