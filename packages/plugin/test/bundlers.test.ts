// Builds the fixture apps with every bundler the plugin has an entry for, then
// runs each bundle on the fake DOM: the reactre app (core mode) and the React
// app (compat mode, class build) must render and update, and their JSX must
// have been compiled to templates. A React app's server render must resolve to
// @reactre/compat/server and write React's HTML, through the entry for the build's target: in
// Vite, a browser build's errors are React's minified codes and a Node SSR build's its full text.
//
// The bundlers resolve the workspace packages as an app resolves them once
// installed, to their dist builds, so those are built first.

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
import { type Plugin, rollup } from "rollup";
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
      // The packages' sources, as the repository's own builds resolve them: dist may not be built.
      conditions: ["reactre-source"],
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

  test("core: a program that imports features/async gets the core's async runtime; one that does not, its default build", async () => {
    const file = join(out, `${name}-async.js`);
    await bundle(FIXTURES + "async/main.tsx", file, {});
    expect(await Bun.file(file).text()).toContain("NotReadyError");
    // Vite and Rollup's node-resolve, under bun test (NODE_ENV=test), resolve the "development"
    // condition, the async build, which the plugin turns into the default one; Bun's build here
    // resolves the core's sources, whose index.ts the plugin strips as the default build is.
    expect(await Bun.file(join(out, `${name}-core.js`)).text()).not.toContain("NotReadyError");

    installFakeDocument();
    const root = new FakeElement("DIV");
    const app = (await import(file)) as { mount(el: unknown): void; resolve(v: string): void };
    app.mount(root);
    expect(root.textContent).toBe("wait");
    app.resolve("ready");
    await microtasks();
    expect(root.textContent).toBe("ready");
  }, 60_000);

  test("core: the whole program binds a prop's hole only where a call site passes it reactively", async () => {
    const file = join(out, `${name}-props.js`);
    await bundle(FIXTURES + "props/main.tsx", file, {});
    const code = await Bun.file(file).text();
    // Label's callers all pass literals: its hole is a clone value. Count's `n` is bound.
    // (Each bundler prints the code its own way: the parentheses may go.)
    expect(code).toMatch(/clone\(\[\(?props\.text\)?\]\)/);
    expect(code).toMatch(/__n\[0\], \(\) => \(?props\.n\)?\)/);
    expect(code).not.toMatch(/clone\(\[\(?props\.n\)?\]\)/);

    installFakeDocument();
    const root = new FakeElement("DIV");
    const app = (await import(file)) as { mount(el: unknown): void; log: string[] };
    app.mount(root);
    const span = find(root, "SPAN");
    expect(span.textContent).toBe("0");
    find(root, "BUTTON").dispatchEvent(new FakeEvent("click"));
    expect(span.textContent).toBe("1");
    expect(find(root, "SECTION").textContent).toBe("inside");
    expect(app.log).toEqual(["provider"]);
  }, 60_000);

  test("compat: resolves react to the class build and compiles host trees", async () => {
    const file = join(out, `${name}-compat.js`);
    await bundle(FIXTURES + "compat/main.tsx", file, { compat: { classes: true } });
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
    await bundle(FIXTURES + "compat/server.tsx", file, { compat: { classes: true } });
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

  test("compat: class support off keeps component stacks, and a class throws its clear error", async () => {
    const file = join(out, `${name}-no-classes.js`);
    await bundle(FIXTURES + "compat/no-classes.tsx", file, { compat: { classes: false } });
    installFakeDocument();
    const app = (await import(file)) as { reports(el: unknown): string[] };
    const [boom, stack, legacy] = app.reports(new FakeElement("DIV"));
    expect(boom).toBe("boom");
    // Boom's own frame, found as React finds it, in the bundle (the template's <section> follows).
    expect(stack).toMatch(/^\n {4}at Boom \(.*no-classes\.js:\d+:\d+\)\n/);
    expect(legacy).toContain("Legacy is a class component, and this build leaves class support out");
  }, 60_000);

  test("compat: switched-off APIs throw when called, and the rest runs", async () => {
    const file = join(out, `${name}-narrow.js`);
    await bundle(FIXTURES + "compat/narrow.tsx", file, { compat: { exclude: ["useEffect", "@suspense"] } });
    installFakeDocument();
    const root = new FakeElement("DIV");
    const app = (await import(file)) as { mount(el: unknown): void; offByName(name: string): () => void };
    app.mount(root);
    const button = find(root, "BUTTON");
    expect(button.textContent).toBe("Clicked 0");
    button.dispatchEvent(new FakeEvent("click"));
    await microtasks();
    expect(button.textContent).toBe("Clicked 1");
    for (const off of ["useEffect", "lazy"]) {
      expect(typeof app.offByName(off)).toBe("function");
      expect(app.offByName(off)).toThrow(`React's ${off} is switched off by @reactre/plugin's compat options`);
    }
  }, 60_000);

  test("compat: code that uses a switched-off API fails the build, naming it", async () => {
    const failure = await bundle(FIXTURES + "compat/uses-off.tsx", join(out, `${name}-uses-off.js`), {
      compat: { exclude: ["useEffect"] },
    }).then(
      () => "(built)",
      (e: unknown) => messages(e),
    );
    expect(failure).toContain("uses React's useEffect, which @reactre/plugin's compat options switch off");
  }, 60_000);
});

describe("vite: the server renderer's entry follows the build's target", () => {
  /** React's minified message for #62, the `style` prop given a string, as its browser build throws it. */
  const minified =
    "Minified React error #62; visit https://react.dev/errors/62 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  const full =
    "The `style` prop expects a mapping from style properties to values, not a string. For example, style={{marginRight: spacing + 'em'}} when using JSX.";
  type Errors = { message(): string; streamMessage(): Promise<string> };

  test("a browser build resolves react-dom/server to the browser entry: React's minified codes", async () => {
    const file = join(out, "vite-server-browser.js");
    await bundlers["vite"]!(FIXTURES + "compat/server-errors.tsx", file, { compat: true });
    const app = (await import(file)) as Errors;
    expect(app.message()).toBe(minified);
    expect(await app.streamMessage()).toBe(minified);
  }, 60_000);

  test("a Node SSR build resolves it to the Node entry: React's full messages", async () => {
    const name = "vite-server-ssr.js";
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin({ compat: true })],
      // Bundled whole, so the build resolves the server renderer itself, with Vite's SSR conditions.
      ssr: { noExternal: true },
      build: {
        ssr: FIXTURES + "compat/server-errors.tsx",
        outDir: out,
        emptyOutDir: false,
        minify: false,
        rolldownOptions: { output: { entryFileNames: name } },
      },
    });
    const app = (await import(join(out, name))) as Errors;
    expect(app.message()).toBe(full);
    expect(await app.streamMessage()).toBe(full);
  }, 60_000);
});

describe("rollup: which build of @reactre/core the app gets", () => {
  const build = async (entry: string, options: ReactreOptions, plugins: Plugin[] = []): Promise<string> => {
    // A production build's conditions, whatever NODE_ENV says.
    const resolve = nodeResolve({ browser: true, exportConditions: ["production"] });
    const b = await rollup({ input: entry, plugins: [...plugins, rollupPlugin(options), resolve] });
    const { output } = await b.generate({ format: "es" });
    await b.close();
    return output[0].code;
  };

  test("`async: true` gives an app that does not import the modules the async runtime", async () => {
    // What it does not use of the runtime is tree-shaken; the error class stays.
    expect(await build(FIXTURES + "core/main.tsx", { async: true })).toContain("NotReadyError");
    expect(await build(FIXTURES + "core/main.tsx", {})).not.toContain("NotReadyError");
  });

  test("with no program read (`wholeProgram: false`), the async runtime, which is right either way", async () => {
    expect(await build(FIXTURES + "core/main.tsx", { wholeProgram: false })).toContain("NotReadyError");
  });

  test("`async: false` with an app that imports features/async fails the build, naming the option", async () => {
    const e = await build(FIXTURES + "async/main.tsx", { async: false }).catch((e: unknown) => e);
    expect(messages(e)).toContain("needs @reactre/core's async runtime");
    expect(messages(e)).toContain("the plugin's `async` option is false");
  });

  test("a module the program did not read that imports features/async fails the build", async () => {
    // A virtual module, which the program cannot see into, leads to the app that imports it.
    const late: Plugin = {
      name: "late",
      resolveId: (id) => (id === "virtual:late" ? "\0late" : null),
      load: (id) => (id === "\0late" ? `export * from ${JSON.stringify(FIXTURES + "async/main.tsx")};` : null),
    };
    const entry = join(out, "late-entry.js");
    writeFileSync(entry, 'export * from "virtual:late";\n');
    const e = await build(entry, {}, [late]).catch((e: unknown) => e);
    expect(messages(e)).toContain("imports neither @reactre/core/features/async nor /actions");
  });

  test("a package that only looks like the core is left alone", async () => {
    for (const [dir, pkg] of [
      ["core", '{ "name": "not-core" }'],
      ["nopkg/core", null],
    ] as const) {
      const at = join(out, "lookalike", dir);
      mkdirSync(join(at, "dist"), { recursive: true });
      if (pkg !== null) writeFileSync(join(at, "package.json"), pkg);
      writeFileSync(join(at, "dist/index.js"), "export const own = 1;\n");
    }
    const entry = join(out, "lookalike/main.js");
    writeFileSync(
      entry,
      'export { own } from "./core/dist/index.js";\nexport { own as o2 } from "./nopkg/core/dist/index.js";\n',
    );
    expect(await build(entry, { async: true })).toContain("const own = 1");
  });
});

/** Every message in a bundler's error: its own, and those of the errors or logs it carries. */
function messages(e: unknown): string {
  const inner = (e as { errors?: unknown[]; logs?: unknown[] }).errors ?? [];
  return [String(e), ...inner.map((x) => (x as { message?: string }).message ?? String(x))].join("\n");
}
