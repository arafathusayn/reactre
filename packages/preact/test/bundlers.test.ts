// @reactre/preact/plugin with every bundler it has an entry for: a Preact app and a React app
// bundle with no alias, their JSX compiled to templates, and run on the fake DOM; with `off`, a
// switched-off import fails the build and class support leaves the bundle.
//
// The plugin resolves to @reactre/preact's dist build, so that is built first.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FakeEvent } from "@reactre/testdom";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rspack } from "@rspack/core";
import { build as esbuild } from "esbuild";
import { build as rolldown } from "rolldown";
import { rollup } from "rollup";
import { build as vite } from "vite";
import webpack from "webpack";

import type { CompilerOptions } from "../src/compiler.ts";
import { reactrePreact } from "../src/plugin.ts";
import { container, html, installDom } from "./dom.ts";

// The coverage settings skip folders named reactre-plugin-*: these bundles are not sources.
const out = mkdtempSync(join(tmpdir(), "reactre-plugin-preact-bundlers-"));

const FILES: Record<string, string> = {
  "preact.jsx": `
    import { render } from "preact";
    import { useState } from "preact/hooks";
    function Counter() {
      const [n, setN] = useState(0);
      return <button class="counter" onClick={() => setN(n + 1)}>Clicked {n} times</button>;
    }
    export const mount = (el) => render(<main><h1>hi</h1><Counter /></main>, el);
  `,
  "react.tsx": `
    import { useState } from "react";
    import { createRoot } from "react-dom/client";
    function Counter(): any {
      const [n, setN] = useState<number>(0);
      return <button className="counter" onClick={() => setN(n + 1)}>Clicked {n} times</button>;
    }
    export const mount = (el: any) => createRoot(el).render(<main><Counter /></main>);
  `,
  "effect.jsx": `import { useEffect } from "react"; export const a = useEffect;`,
  "dep.js": `import { x } from "dep"; export { x };`,
  "node_modules/dep/package.json": `{ "name": "dep", "type": "module", "main": "index.js" }`,
  "node_modules/dep/index.js": `import { Component } from "preact"; export const x = Component;`,
};

beforeAll(() => {
  const r = Bun.spawnSync(["bun", "run", "build"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`building @reactre/preact failed:\n${r.stderr.toString()}`);
  for (const [name, code] of Object.entries(FILES)) {
    mkdirSync(join(out, name, ".."), { recursive: true });
    writeFileSync(join(out, name), code);
  }
});

/** Bundles `entry` into one ES module at `file`, with the plugin and `options`. */
type Bundle = (entry: string, file: string, options: CompilerOptions) => Promise<void>;

const webpackLike =
  (make: typeof webpack | typeof rspack, plugin: unknown): Bundle =>
  async (entry, file) => {
    const compiler = (make as typeof webpack)({
      mode: "production",
      entry,
      output: { path: join(file, ".."), filename: file.split("/").pop()!, library: { type: "module" } },
      experiments: { outputModule: true },
      optimization: { minimize: false },
      devtool: false,
      plugins: [plugin as never],
    });
    const stats = await promisify(compiler.run.bind(compiler))();
    await promisify(compiler.close.bind(compiler))();
    if (stats?.hasErrors()) throw new Error(stats.toString("errors-only"));
  };

const bundlers: Record<string, Bundle> = {
  vite: async (entry, file, options) => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [reactrePreact.vite(options)],
      build: {
        outDir: join(file, ".."),
        emptyOutDir: false,
        minify: false,
        lib: { entry, formats: ["es"], fileName: () => file.split("/").pop()! },
      },
    });
  },
  rollup: async (entry, file, options) => {
    const bundle = await rollup({
      input: entry,
      plugins: [reactrePreact.rollup(options), nodeResolve({ browser: true })],
      onwarn: () => {},
    });
    await bundle.write({ file, format: "es" });
    await bundle.close();
  },
  rolldown: async (entry, file, options) => {
    await rolldown({ input: entry, plugins: [reactrePreact.rolldown(options)], platform: "browser", output: { file } });
  },
  esbuild: async (entry, file, options) => {
    await esbuild({
      entryPoints: [entry],
      outfile: file,
      bundle: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
      plugins: [reactrePreact.esbuild(options)],
    });
  },
  webpack: (entry, file, options) => webpackLike(webpack, reactrePreact.webpack(options))(entry, file, options),
  rspack: (entry, file, options) => webpackLike(rspack, reactrePreact.rspack(options))(entry, file, options),
};

/** Mounts a bundled app, clicks its button and returns the HTML before and after. */
async function clicks(file: string): Promise<[string, string]> {
  installDom();
  const app = (await import(file)) as { mount(el: unknown): void };
  const c = container();
  app.mount(c);
  await new Promise((r) => setTimeout(r, 0));
  const before = html(c);
  let button: any = c;
  while (button.localName != "button")
    button = button.firstChild.localName == "h1" ? button.firstChild.nextSibling : button.firstChild;
  button.dispatchEvent(new FakeEvent("click"));
  await new Promise((r) => setTimeout(r, 10));
  return [before, html(c)];
}

/** The build's error message, or "" when it builds. */
async function failure(bundle: Bundle, entry: string, file: string, options: CompilerOptions): Promise<string> {
  try {
    await bundle(entry, file, options);
    return "";
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

describe.each(Object.keys(bundlers))("%s", (name) => {
  const bundle = bundlers[name]!;

  test("a Preact app: no alias, JSX compiled to templates, renders and updates", async () => {
    const file = join(out, `${name}-preact.js`);
    await bundle(join(out, "preact.jsx"), file, {});
    const code = await Bun.file(file).text();
    expect(code).toMatch(/"?class"?:\s*"counter"/);
    expect(code).not.toContain("preact.module");
    expect(await clicks(file)).toEqual([
      '<main><h1>hi</h1><button class="counter">Clicked 0 times</button></main>',
      '<main><h1>hi</h1><button class="counter">Clicked 1 times</button></main>',
    ]);
  }, 60_000);

  test("a React app with classes and useEffect off: compat's names, no class code", async () => {
    const file = join(out, `${name}-react.js`);
    await bundle(join(out, "react.tsx"), file, { source: "react", off: ["@classes", "useEffect"] });
    const code = await Bun.file(file).text();
    // The constants are false: a bundler that folds them (Vite, Rolldown) drops the class code.
    expect(/CLASSES\w* = false/.test(code) || !code.includes("getSnapshotBeforeUpdate")).toBe(true);
    expect(code).not.toMatch(/CLASSES\w* = true/);
    expect(await clicks(file)).toEqual([
      '<main><button class="counter">Clicked 0 times</button></main>',
      '<main><button class="counter">Clicked 1 times</button></main>',
    ]);
  }, 60_000);

  test("a switched-off import fails the build, in the app and in a dependency", async () => {
    const options = { source: "react", off: ["@classes", "useEffect"] } as const;
    expect(await failure(bundle, join(out, "effect.jsx"), join(out, `${name}-effect.js`), options)).toContain(
      "effect.jsx: uses useEffect",
    );
    expect(await failure(bundle, join(out, "dep.js"), join(out, `${name}-dep.js`), options)).toContain(
      "index.js: uses Component",
    );
  }, 60_000);
});

test("Vite's dependency optimizer gets the resolve and the scan", () => {
  const plugin = reactrePreact.raw({ off: ["useEffect"] }, { framework: "vite" } as never) as any;
  const deps = plugin.vite.config().optimizeDeps.rolldownOptions.plugins[0];
  expect(deps.resolveId("preact")).toBe("\0reactre-preact-off:core");
  expect(deps.resolveId("@reactre/preact/compat")).toBe("\0reactre-preact-off:compat");
  expect(deps.load("\0reactre-preact-off:core")).toContain('off("useEffect")');
  expect(deps.load("/a.js")).toBeNull();
  expect(deps.transform("export const a = 1;", "/a.css")).toBeNull();
  expect(() => deps.transform(`import { useEffect } from "preact/hooks";`, "/a.js?v=1")).toThrow(
    "/a.js: uses useEffect",
  );
  const plain = reactrePreact.raw(undefined, { framework: "vite" } as never) as any;
  expect(plain.resolveId("react-dom")).toEndWith("dist/compat.js");
  expect(plain.resolveId("react/jsx-dev-runtime")).toEndWith("dist/jsx-runtime.js");
  expect(plain.resolveId("@reactre/preact/core")).toBeNull();
  expect(plain.transform("export const a = 1;", "/a.js")).toBeNull();
});
