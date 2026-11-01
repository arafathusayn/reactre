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

  // @reactre/core's build: the default one for an app that does not import its async feature
  // modules (the core fixture, above), the async runtime for one that does. The production
  // conditions apply here, as NODE_ENV is not "test".
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [reactre()],
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry: fixtures + "async/main.tsx", formats: ["es"], fileName: () => "async.js" },
    },
  });
  assert.doesNotMatch(
    readFileSync(join(out, "core.js"), "utf8"),
    /NotReadyError/,
    "core: the async runtime was bundled",
  );
  assert.match(readFileSync(join(out, "async.js"), "utf8"), /NotReadyError/, "async: the async runtime is missing");
  console.log("ok - vite build, the core's default build or its async runtime, by what the program imports");

  // APIs switched off: an app that keeps to the rest builds; one that uses a switched-off API
  // fails, naming it. Under Node the scan runs on oxc's native parser.
  const narrow = (entry, fileName) =>
    build({
      configFile: false,
      logLevel: "silent",
      plugins: [reactre({ compat: { exclude: ["useEffect"] } })],
      build: {
        outDir: out,
        emptyOutDir: false,
        minify: false,
        lib: { entry, formats: ["es"], fileName: () => fileName },
      },
    });
  await narrow(fixtures + "compat/narrow.jsx", "narrow.js");
  assert.match(readFileSync(join(out, "narrow.js"), "utf8"), /switched off by @reactre\/plugin's compat options/);
  await assert.rejects(narrow(fixtures + "compat/uses-off.jsx", "uses-off.js"), /uses React's useEffect/);
  console.log("ok - vite build, compat with APIs switched off");

  // The server renderer's entry follows the build's target: a browser build resolves
  // react-dom/server to compat's browser entry, whose errors are React's minified codes, and a
  // Node SSR build (bundled whole) to its Node entry, with React's full messages.
  const errorsEntry = fixtures + "compat/server-errors.jsx";
  for (const [target, ssr, expected] of [
    ["browser", false, /^Minified React error #62; visit https:\/\/react\.dev\/errors\/62 for /],
    ["ssr", true, /^The `style` prop expects a mapping from style properties to values/],
  ]) {
    const fileName = `server-errors-${target}.js`;
    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [reactre({ compat: true })],
      ssr: { noExternal: true },
      build: ssr
        ? {
            ssr: errorsEntry,
            outDir: out,
            emptyOutDir: false,
            minify: false,
            rolldownOptions: { output: { entryFileNames: fileName } },
          }
        : {
            outDir: out,
            emptyOutDir: false,
            minify: false,
            lib: { entry: errorsEntry, formats: ["es"], fileName: () => fileName },
          },
    });
    const app = await import(join(out, fileName));
    assert.match(app.message(), expected, `${target}: renderToString's error`);
    assert.match(await app.streamMessage(), expected, `${target}: renderToReadableStream's error`);
    console.log(`ok - vite build, react-dom/server for the ${target === "ssr" ? "Node SSR" : "browser"} target`);
  }

  // A Vite SSR build of a core app: the plugin compiles it for the server, as the environment is
  // the server's, and @reactre/core/server renders it under Node, its <Loading> streamed after the
  // shell.
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [reactre()],
    build: {
      ssr: fixtures + "ssr/entry.tsx",
      outDir: out,
      emptyOutDir: false,
      minify: false,
      rolldownOptions: { output: { entryFileNames: "ssr.js" } },
    },
  });
  {
    const app = await import(join(out, "ssr.js"));
    assert.equal(app.isServer, true, "ssr: isServer");
    assert.match(app.html(), /^<main><h1>Hello<\/h1>.*<i>loading<\/i><\/main>$/, "ssr: renderToString");
    const reader = app.stream().getReader(),
      dec = new TextDecoder();
    assert.match(dec.decode((await reader.read()).value), /<!--rr:b0--><i>loading<\/i><!--\/rr:b0--><\/main>$/);
    app.resolve("world");
    assert.match(
      dec.decode((await reader.read()).value),
      /<template id="rr:t0"><p class="word">world<\/p><\/template>/,
    );
    assert.equal((await reader.read()).done, true, "ssr: the stream did not end");
    assert.deepEqual(app.ran, [], "ssr: an effect ran on the server");
    console.log("ok - vite build, SSR with @reactre/core/server");
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
