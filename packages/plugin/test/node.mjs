// The plugin under Node, as most Vite users run it: its dist build (and the
// compilers' dist builds) loaded by Node, in a Vite build and in Vite's dev
// server. bun test runs the plugin's source under Bun (bundlers.test.ts);
// this file checks the published shape. Build the packages first, then:
//
//   node packages/plugin/test/node.mjs
//
// It exits non-zero on the first failed check.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import reactre from "@reactre/plugin/vite";
import { build, createServer } from "vite";

const fixtures = new URL("../fixtures/", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "reactre-plugin-node-"));

try {
  // A build in each mode: the JSX is compiled to templates and nothing is left for a JSX runtime.
  for (const [mode, entry, options, template] of [
    ["core", "core/main.tsx", {}, /__(rrT|template)\(\[/],
    ["compat", "compat/main.jsx", { compat: { classes: true } }, /"?className"?:\s*"count"/],
  ]) {
    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [reactre(options)],
      build: {
        outDir: out,
        emptyOutDir: false,
        minify: false,
        lib: { entry: fixtures + entry, formats: ["es"], fileName: () => `${mode}.js` },
      },
    });
    const code = readFileSync(join(out, `${mode}.js`), "utf8");
    assert.match(code, template, `${mode}: no template in the bundle`);
    assert.doesNotMatch(code, /\bjsxs?\(\s*"/, `${mode}: a host element was left to the JSX runtime`);
    console.log(`ok - vite build, ${mode}`);
  }

  // The dev server: the dependency scan finds the app's imports without errors, the transformed
  // module has the compiled templates, and imports of react (compat) go to @reactre/compat through
  // Vite's dependency optimizer.
  for (const [mode, root, entry, options] of [
    ["core", "core", "/main.tsx", {}],
    ["compat", "compat", "/main.jsx", { compat: { classes: true } }],
  ]) {
    const logged = [];
    const log = (msg) => logged.push(msg);
    const server = await createServer({
      configFile: false,
      customLogger: {
        info() {},
        warn: log,
        warnOnce: log,
        error: log,
        clearScreen() {},
        hasErrorLogged: () => false,
        hasWarned: false,
      },
      root: fixtures + root,
      cacheDir: join(out, `vite-${mode}`),
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { entries: [fixtures + root + entry] },
      plugins: [reactre(options)],
    });
    try {
      await server.environments.client.depsOptimizer?.scanProcessing;
      assert.deepEqual(logged, [], `${mode}: the dev server logged a problem`);
      const result = await server.transformRequest(entry);
      assert.ok(result, `${mode}: ${entry} was not transformed`);
      assert.doesNotMatch(result.code, /jsx-runtime|jsx-dev-runtime/, `${mode}: the module imports a JSX runtime`);
      if (mode === "compat") {
        assert.doesNotMatch(result.code, /from "react(-dom)?(\/[^"]*)?"/, "compat: an import of react was left");
        assert.match(result.code, /@reactre[/_]compat/, "compat: react was not resolved to @reactre/compat");
      } else {
        assert.match(result.code, /__rrT\(/, "core: no template in the module");
      }
      console.log(`ok - vite dev server, ${mode}`);
    } finally {
      await server.close();
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
