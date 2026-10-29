// Size budgets for @reactre/compat's profiles, built as an app ships them: minified ESM for the
// browser, @reactre/dom bundled in, gzip -9. A profile that grows past its budget in sizes.json
// fails, so every byte added is a choice. When a change is worth its bytes, record the new sizes:
//
//   UPDATE_SIZES=1 bun test packages/compat/test/size.test.ts
//
// Profiles:
//   full  the default entry, React's whole client API with class components
//   core  @reactre/compat/core, the same without the feature modules: class components,
//         component stacks and React's handling of repeated keys
//   jfb   the js-framework-benchmark React app (apps/jfb/app/main.jsx) on core, compiled to
//         templates: the benchmark's explicit choice to leave out class components, component
//         stacks and React's handling of repeated keys (apps/jfb/prepare.ts resolves the same)

import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { reactreCompatCompiler } from "../src/compiler.ts";

const src = (f: string): string => Bun.fileURLToPath(new URL(`../src/${f}`, import.meta.url));
const budgets = Bun.fileURLToPath(new URL("../sizes.json", import.meta.url));

/** Resolves react, react-dom and their subpaths to compat's core alone, with no feature module. */
const toCompat: Bun.BunPlugin = {
  name: "react-to-compat",
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, () => ({ path: src("core.ts") }));
  },
};

const profiles: Record<string, () => Promise<Bun.BuildOutput>> = {
  full: () => Bun.build({ entrypoints: [src("index.ts")], minify: true, target: "browser", format: "esm" }),
  core: () => Bun.build({ entrypoints: [src("core.ts")], minify: true, target: "browser", format: "esm" }),
  jfb: () =>
    Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL("../../../apps/jfb/app/main.jsx", import.meta.url))],
      minify: true,
      target: "browser",
      format: "esm",
      plugins: [reactreCompatCompiler(), toCompat],
      define: { "process.env.NODE_ENV": '"production"' },
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
