// Builds the fixture apps with every bundler the plugin has an entry for, then
// runs each bundle on the fake DOM: the reactre app (core mode) and the React
// app (compat mode, class build) must render and update, and their JSX must
// have been compiled to templates. A React app's server render must resolve to
// @reactre/compat/server and write React's HTML.
//
// The bundlers resolve the workspace packages as an app resolves them from
// npm, to their dist builds, so those are built first.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rspack } from "@rspack/core";
import { build as esbuild } from "esbuild";
import { build as rolldown } from "rolldown";
import { rollup } from "rollup";
import { build as vite } from "vite";
import webpack from "webpack";

import bunPlugin from "../src/bun.ts";
import esbuildPlugin from "../src/esbuild.ts";
import type { ReactreOptions } from "../src/index.ts";
import rolldownPlugin from "../src/rolldown.ts";
import rollupPlugin from "../src/rollup.ts";
import rspackPlugin from "../src/rspack.ts";
import vitePlugin from "../src/vite.ts";
import webpackPlugin from "../src/webpack.ts";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

let out: string;

beforeAll(() => {
  for (const dir of ["dom", "core", "compiler", "compat"]) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: PACKAGES + dir, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`building ${dir} failed:\n${r.stderr.toString()}`);
  }
  out = mkdtempSync(join(tmpdir(), "reactre-plugin-"));
  // An app outside the workspace whose dependency imports react. Neither can see @reactre/compat
  // through node_modules, as with Bun's and pnpm's isolated installs, where a dependency sees only
  // its own dependencies.
  const lib = join(out, "isolated/node_modules/isolated-lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "package.json"), '{ "name": "isolated-lib", "type": "module", "main": "index.js" }');
  writeFileSync(join(lib, "index.js"), 'export { useState } from "react";\n');
  writeFileSync(
    join(out, "isolated/main.js"),
    'import { useState as fromLib } from "isolated-lib";\nimport { useState, version } from "react";\n' +
      "export const same = fromLib === useState;\nexport { version };\n",
  );
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Bundles `entry` into one ES module at `file`, with the plugin and `options`. */
type Bundle = (entry: string, file: string, options: ReactreOptions) => Promise<void>;

const bundlers: Record<string, Bundle> = {
  vite: async (entry, file, options) => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin(options)],
      build: {
        outDir: join(file, ".."),
        emptyOutDir: false,
        minify: false,
        lib: { entry, formats: ["es"], fileName: () => file.split("/").pop()! },
      },
    });
  },
  rollup: async (entry, file, options) => {
    const bundle = await rollup({ input: entry, plugins: [rollupPlugin(options), nodeResolve({ browser: true })] });
    await bundle.write({ file, format: "es" });
    await bundle.close();
  },
  rolldown: async (entry, file, options) => {
    await rolldown({ input: entry, plugins: [rolldownPlugin(options)], platform: "browser", output: { file } });
  },
  esbuild: async (entry, file, options) => {
    await esbuild({
      entryPoints: [entry],
      outfile: file,
      bundle: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
      plugins: [esbuildPlugin(options)],
    });
  },
  webpack: async (entry, file, options) => {
    const compiler = webpack({
      mode: "production",
      entry,
      output: { path: join(file, ".."), filename: file.split("/").pop()!, library: { type: "module" } },
      experiments: { outputModule: true },
      optimization: { minimize: false },
      devtool: false,
      plugins: [webpackPlugin(options)],
    });
    const stats = await promisify(compiler.run.bind(compiler))();
    await promisify(compiler.close.bind(compiler))();
    if (stats?.hasErrors()) throw new Error(stats.toString("errors-only"));
  },
  rspack: async (entry, file, options) => {
    const compiler = rspack({
      mode: "production",
      entry,
      output: { path: join(file, ".."), filename: file.split("/").pop()!, library: { type: "module" } },
      optimization: { minimize: false },
      devtool: false,
      plugins: [rspackPlugin(options)],
    });
    const stats = await promisify(compiler.run.bind(compiler))();
    await promisify(compiler.close.bind(compiler))();
    if (stats?.hasErrors()) throw new Error(stats.toString("errors-only"));
  },
  bun: async (entry, file, options) => {
    const r = await Bun.build({
      entrypoints: [entry],
      outdir: join(file, ".."),
      naming: file.split("/").pop()!,
      target: "browser",
      format: "esm",
      plugins: [bunPlugin(options)],
    });
    if (!r.success) throw new AggregateError(r.logs, "Bun.build failed");
  },
};

/** The first element under `el` with tag `tag`, depth first. */
function find(el: FakeElement, tag: string): FakeElement {
  for (let c = el.firstChild; c !== null; c = c.nextSibling) {
    if (!(c instanceof FakeElement)) continue;
    if (c.tagName === tag) return c;
    try {
      return find(c, tag);
    } catch {}
  }
  throw new Error(`no <${tag.toLowerCase()}> under <${el.tagName.toLowerCase()}>`);
}

const microtasks = () => new Promise((r) => setTimeout(r, 0));

describe.each(Object.keys(bundlers))("%s", (name) => {
  const bundle = bundlers[name]!;

  test("core: compiles reactre TSX to templates that update", async () => {
    const file = join(out, `${name}-core.js`);
    await bundle(FIXTURES + "core/main.tsx", file, {});
    const code = await Bun.file(file).text();
    expect(code).toContain("Clicked ");
    expect(code).not.toMatch(/\bjsxs?\(/);

    installFakeDocument();
    const root = new FakeElement("DIV");
    const app = (await import(file)) as { mount(el: unknown): void };
    app.mount(root);
    const button = find(root, "BUTTON");
    expect(button.textContent).toBe("Clicked 0 times");
    button.dispatchEvent(new FakeEvent("click"));
    expect(button.textContent).toBe("Clicked 1 times");
  }, 60_000);

  test("compat: resolves react to the class build and compiles host trees", async () => {
    const file = join(out, `${name}-compat.js`);
    await bundle(FIXTURES + "compat/main.jsx", file, { compat: { classes: true } });
    const code = await Bun.file(file).text();
    // A template made by @reactre/compat/compiler, and no copy of React.
    expect(code).toMatch(/"?className"?:\s*"count"/);
    expect(code).not.toContain("react.production");

    installFakeDocument();
    const root = new FakeElement("DIV");
    const app = (await import(file)) as { mount(el: unknown): unknown };
    app.mount(root);
    expect(find(root, "H1").textContent).toBe("reactre");
    expect(find(root, "P").textContent).toBe("Count: 0");
    find(root, "BUTTON").dispatchEvent(new FakeEvent("click"));
    await microtasks();
    expect(find(root, "P").textContent).toBe("Count: 1");
  }, 60_000);

  test("compat: a dependency that cannot see @reactre/compat gets the app's copy", async () => {
    const file = join(out, `${name}-isolated.js`);
    await bundle(join(out, "isolated/main.js"), file, { compat: true });
    const code = await Bun.file(file).text();
    expect(code).not.toContain("react.production");
    installFakeDocument();
    const app = (await import(file)) as { same: boolean; version: string };
    expect(app.same).toBe(true);
  }, 60_000);

  test("compat: resolves react-dom/server to @reactre/compat/server, which renders React's HTML", async () => {
    const file = join(out, `${name}-server.js`);
    await bundle(FIXTURES + "compat/server.jsx", file, { compat: { classes: true } });
    const code = await Bun.file(file).text();
    expect(code).not.toContain("react-dom-server");
    // React's own renderToString writes exactly this for the same app.
    const expected =
      '<main id="_R_0_"><h1 class="title">reactre</h1><!--$--><p class="count">Count: <!-- -->2</p><!--/$-->' +
      '<label for="_R_0_">2<!-- --> items, <!-- -->&lt;escaped&gt;</label></main>';
    const app = (await import(file)) as { html(): string; stream(): Promise<string> };
    expect(app.html()).toBe(expected);
    expect(await app.stream()).toBe(expected);
  }, 60_000);
});
