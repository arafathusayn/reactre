// The plugin as its users install it: its dist build (and the compilers' and runtimes' dist
// builds) in a Vite build and in Vite's dev server. bun test runs the plugin's source
// (bundlers.test.ts); this file checks the published shape. Build the packages first, then:
//
//   bun packages/plugin/test/dist.ts
//
// Bun resolves the packages' `bun` export condition to their sources, so the packages are first
// installed into a temp folder as they would be for a runtime without that condition: each one's
// dist/ copied, under a package.json whose `exports` leave out the `bun` and `reactre-source`
// conditions, beside links to the third-party packages they import. Everything this process
// imports from @reactre/* resolves there, and a package's source loaded anywhere fails the run.
// It exits non-zero on the first failed check.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReactreOptions as Options } from "@reactre/plugin";
import type { InlineConfig, Logger } from "vite";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const root = realpathSync(mkdtempSync(join(tmpdir(), "reactre-plugin-dist-")));
const modules = join(root, "node_modules");
const out = join(root, "out");

// A package's source loaded here would mean a check ran against the sources.
Bun.plugin({
  name: "no-sources",
  setup(build) {
    build.onLoad({ filter: /\/packages\/[^/]+\/src\// }, (args) => {
      throw new Error(`${args.path}: a package's source was loaded, where its dist build should be`);
    });
  },
});

/** An `exports` value: a path, or conditions mapped to more of them. */
type Target = string | { readonly [condition: string]: Target } | null;

/** `target` without the conditions that name a package's sources. */
function withoutSources(target: Target): Target {
  if (target === null || typeof target === "string") return target;
  const kept: Record<string, Target> = {};
  for (const [key, value] of Object.entries(target))
    if (key !== "bun" && key !== "reactre-source") kept[key] = withoutSources(value);
  return kept;
}

/** Link `name` into the temp node_modules, to the copy `from` holds, unless it is linked already. */
function link(from: string, name: string): void {
  const to = join(modules, name);
  if (existsSync(to)) return;
  mkdirSync(join(to, ".."), { recursive: true });
  symlinkSync(realpathSync(join(from, name)), to);
}

for (const dir of readdirSync(PACKAGES)) {
  const pkg = join(PACKAGES, dir);
  if (!existsSync(join(pkg, "package.json"))) continue;
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    name: string;
    private?: boolean;
    exports?: Target;
  };
  if (manifest.private === true || manifest.exports === undefined) continue;
  if (!existsSync(join(pkg, "dist"))) throw new Error(`${manifest.name} has no dist/; build the packages first`);
  const to = join(modules, manifest.name);
  cpSync(join(pkg, "dist"), join(to, "dist"), { recursive: true });
  writeFileSync(join(to, "package.json"), JSON.stringify({ ...manifest, exports: withoutSources(manifest.exports) }));
  // The third-party packages it was installed with.
  const deps = join(pkg, "node_modules");
  if (existsSync(deps))
    for (const name of readdirSync(deps)) {
      if (name === ".bin" || name === "@reactre") continue;
      if (name.startsWith("@")) for (const sub of readdirSync(join(deps, name))) link(deps, `${name}/${sub}`);
      else link(deps, name);
    }
}

const resolve = (specifier: string): string => Bun.resolveSync(specifier, root);
const { default: reactre } = (await import(resolve("@reactre/plugin/vite"))) as typeof import("@reactre/plugin/vite");
const { build, createServer } = (await import(resolve("vite"))) as typeof import("vite");

const fixtures = new URL("../fixtures/", import.meta.url).pathname;

/** A Vite library build of `entry` into `out`, as `fileName`. */
const lib = (entry: string, fileName: string, options: Options, extra: InlineConfig = {}) =>
  build({
    configFile: false,
    logLevel: "silent",
    plugins: [reactre(options)],
    ...extra,
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: () => fileName },
    },
  });

/** A Vite SSR build of `entry` into `out`, as `fileName`. */
const ssr = (entry: string, fileName: string, options: Options, extra: InlineConfig = {}) =>
  build({
    configFile: false,
    logLevel: "silent",
    plugins: [reactre(options)],
    ...extra,
    build: {
      ssr: entry,
      outDir: out,
      emptyOutDir: false,
      minify: false,
      rolldownOptions: { output: { entryFileNames: fileName } },
    },
  });

const read = (fileName: string): string => readFileSync(join(out, fileName), "utf8");

try {
  // The plugin's dist build is the one loaded, and its imports of the compilers and the runtimes
  // resolve to their dist builds.
  const plugin = join(modules, "@reactre/plugin/dist");
  const loaded: [string, string][] = [
    ["@reactre/plugin/vite", "plugin/dist/vite.js"],
    ["@reactre/compiler", "compiler/dist/index.js"],
    ["@reactre/compat/compiler", "compat/dist/compiler.js"],
    ["@reactre/core", "core/dist/index.js"],
    ["@reactre/core/server", "core/dist/server.js"],
  ];
  for (const [specifier, path] of loaded)
    assert.equal(
      Bun.resolveSync(specifier, plugin),
      join(modules, "@reactre", path),
      `${specifier}: not its dist build`,
    );
  console.log("ok - the plugin, the compilers and the runtimes load from dist/");

  // A build in each mode: the JSX is compiled to templates and nothing is left for a JSX runtime.
  const modes: [string, string, Options, RegExp][] = [
    ["core", "core/main.tsx", {}, /__(rrT|template)\(\[/],
    ["compat", "compat/main.tsx", { compat: { classes: true } }, /"?className"?:\s*"count"/],
  ];
  for (const [mode, entry, options, template] of modes) {
    await lib(fixtures + entry, `${mode}.js`, options);
    const code = read(`${mode}.js`);
    assert.match(code, template, `${mode}: no template in the bundle`);
    assert.doesNotMatch(code, /\bjsxs?\(\s*"/, `${mode}: a host element was left to the JSX runtime`);
    console.log(`ok - vite build, ${mode}`);
  }

  // @reactre/core's build: the default one for an app that does not import its async feature
  // modules (the core fixture, above), the async runtime for one that does. The production
  // conditions apply here, as NODE_ENV is not "test".
  await lib(fixtures + "async/main.tsx", "async.js", {});
  assert.doesNotMatch(read("core.js"), /NotReadyError/, "core: the async runtime was bundled");
  assert.match(read("async.js"), /NotReadyError/, "async: the async runtime is missing");
  console.log("ok - vite build, the core's default build or its async runtime, by what the program imports");

  // APIs switched off: an app that keeps to the rest builds; one that uses a switched-off API
  // fails, naming it.
  const narrow = { compat: { exclude: ["useEffect"] } } satisfies Options;
  await lib(fixtures + "compat/narrow.tsx", "narrow.js", narrow);
  assert.match(read("narrow.js"), /switched off by @reactre\/plugin's compat options/);
  await assert.rejects(lib(fixtures + "compat/uses-off.tsx", "uses-off.js", narrow), /uses React's useEffect/);
  console.log("ok - vite build, compat with APIs switched off");

  // The server renderer's entry follows the build's target: a browser build resolves
  // react-dom/server to compat's browser entry, whose errors are React's minified codes, and an
  // SSR build (bundled whole) to its server entry, with React's full messages.
  const errorsEntry = fixtures + "compat/server-errors.tsx";
  const targets: [string, RegExp][] = [
    ["browser", /^Minified React error #62; visit https:\/\/react\.dev\/errors\/62 for /],
    ["ssr", /^The `style` prop expects a mapping from style properties to values/],
  ];
  for (const [target, expected] of targets) {
    const fileName = `server-errors-${target}.js`;
    const extra = { ssr: { noExternal: true } } satisfies InlineConfig;
    await (target === "ssr" ? ssr : lib)(errorsEntry, fileName, { compat: true }, extra);
    const app = (await import(join(out, fileName))) as { message(): string; streamMessage(): Promise<string> };
    assert.match(app.message(), expected, `${target}: renderToString's error`);
    assert.match(await app.streamMessage(), expected, `${target}: renderToReadableStream's error`);
    console.log(`ok - vite build, react-dom/server for the ${target === "ssr" ? "SSR" : "browser"} target`);
  }

  // A Vite SSR build of a core app, with `ssr: true`: the plugin compiles it for the server, as the
  // environment is the server's, and @reactre/core/server's dist build renders it, its <Loading>
  // streamed after the shell.
  await ssr(fixtures + "ssr/entry.tsx", "ssr.js", { ssr: true });
  {
    const app = (await import(join(out, "ssr.js"))) as {
      isServer: boolean;
      html(): string;
      stream(): ReadableStream<Uint8Array>;
      resolve(word: string): void;
      ran: unknown[];
    };
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
  const servers: [string, Options][] = [
    ["core", {}],
    ["compat", { compat: { classes: true } }],
  ];
  const entry = "/main.tsx";
  for (const [mode, options] of servers) {
    const logged: string[] = [];
    const log = (msg: string) => void logged.push(msg);
    const customLogger: Logger = {
      info() {},
      warn: log,
      warnOnce: log,
      error: log,
      clearScreen() {},
      hasErrorLogged: () => false,
      hasWarned: false,
    };
    const server = await createServer({
      configFile: false,
      customLogger,
      root: fixtures + mode,
      cacheDir: join(out, `vite-${mode}`),
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { entries: [fixtures + mode + entry] },
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
  rmSync(root, { recursive: true, force: true });
}
