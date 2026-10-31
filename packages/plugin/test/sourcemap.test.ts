// Source maps, from the compilers' own to a bundle's.
//
//   - The compilers print the same code with a map as without, for every JSX source in the
//     repository, and each name their maps place maps to the same name in their input.
//   - The plugin's map (oxc's, then the rename's, then the compiler's) takes each name it places
//     back to the same name in the source, and the plugin builds none when the bundler asks for
//     none.
//   - Each bundler builds the fixture apps with source maps on. The bundle runs on the fake DOM and
//     throws three errors: from a component as it renders, from a <For> row's handler, and from a
//     handler of a compat list's row, whose element compiles to a template. Each error's stack
//     names a line and column of the bundle, and the bundle's map takes it to the `Error` of the
//     `throw new Error(...)` in the fixture: the same line and column.
//   - Vite's dev server serves a compiled module with its map inline.
//
// The bundlers resolve the workspace packages to their dist builds, so those are built first.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  eachMapping,
  type EncodedSourceMap,
  originalPositionFor,
  type SourceMapInput,
  TraceMap,
} from "@jridgewell/trace-mapping";
import { compileJs as compatJs, compileJsWithMap as compatJsWithMap } from "@reactre/compat/compiler";
import { compileJs as coreJs, compileJsWithMap as coreJsWithMap } from "@reactre/compiler";
import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rspack } from "@rspack/core";
import { build as esbuild } from "esbuild";
import { build as rolldown } from "rolldown";
import { rollup } from "rollup";
import { build as vite, createServer } from "vite";
import webpack from "webpack";

import bunPlugin from "../src/bun.ts";
import esbuildPlugin from "../src/esbuild.ts";
import { reactre, type ReactreOptions } from "../src/index.ts";
import rolldownPlugin from "../src/rolldown.ts";
import rollupPlugin from "../src/rollup.ts";
import rspackPlugin from "../src/rspack.ts";
import { transpile } from "../src/transpile.ts";
import vitePlugin from "../src/vite.ts";
import webpackPlugin from "../src/webpack.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const PACKAGES = ROOT + "packages/";
const FIXTURES = new URL("../fixtures/sourcemap/", import.meta.url).pathname;

// #region Helpers

/** The app's JSX sources: every .jsx and .tsx file of the apps and the packages. */
function corpus(): { id: string; source: string }[] {
  const out = [];
  for (const id of new Bun.Glob("{apps,packages}/**/*.{jsx,tsx}").scanSync(ROOT)) {
    if (!id.includes("node_modules")) out.push({ id: ROOT + id, source: readFileSync(ROOT + id, "utf8") });
  }
  return out;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
/** The name that starts at `column` of `line` (both from 0), if one does. */
function nameAt(lines: readonly string[], line: number, column: number): string | undefined {
  IDENT.lastIndex = column;
  return IDENT.exec(lines[line] ?? "")?.[0];
}

/**
 * The names `map` places in `code` whose place in `input` starts with another name, as
 * "generated -> original" lines; names the compilers make (`__rr...`, `__hr...`, `__n`, the
 * renamed jsx helpers) are skipped.
 */
function misplaced(code: string, map: SourceMapInput, input: string): string[] {
  const gen = code.split("\n"),
    src = input.split("\n"),
    out: string[] = [];
  eachMapping(new TraceMap(map), (m) => {
    if (m.originalLine === null) return;
    const g = nameAt(gen, m.generatedLine - 1, m.generatedColumn);
    if (g === undefined || /^(__|(jsxs?|jsxDEV|Fragment)_reactre0$)/.test(g)) return;
    const o = nameAt(src, m.originalLine - 1, m.originalColumn);
    if (o !== g)
      out.push(`${g} at ${m.generatedLine}:${m.generatedColumn} -> ${o} at ${m.originalLine}:${m.originalColumn}`);
  });
  return out;
}

/** The plugin's transform hook, for `options`, as unplugin gives it to Rollup. */
function transformOf(
  options: ReactreOptions,
): (this: unknown, code: string, id: string) => { code: string; map: unknown } {
  const raw = reactre.raw(options, { framework: "rollup", versions: {} });
  const plugin = Array.isArray(raw) ? raw[0]! : raw;
  const hook = plugin.transform as {
    handler: (this: unknown, code: string, id: string) => { code: string; map: unknown };
  };
  return hook.handler;
}

/** Where in `file` (from 1) the `Error` of `throw new Error("<message>` is. */
function throwSite(file: string, message: string): { line: number; column: number } {
  const lines = readFileSync(file, "utf8").split("\n");
  const line = lines.findIndex((l) => l.includes(`throw new Error("${message}`));
  if (line < 0) throw new Error(`no throw of "${message}" in ${file}`);
  return { line: line + 1, column: lines[line]!.indexOf("Error(") };
}

/** The first place in `stack` in `file`, with its column from 0, as source maps count. */
function frameIn(stack: string, file: string): { line: number; column: number } {
  for (const m of stack.matchAll(/\(?([^\s()]+):(\d+):(\d+)\)?$/gm)) {
    if (m[1] === file) return { line: Number(m[2]), column: Number(m[3]) - 1 };
  }
  throw new Error(`no frame in ${file}:\n${stack}`);
}

/** The error `fn` throws. */
function thrown(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("did not throw");
}

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

// #endregion

// #region The compilers' maps

describe("the compilers' maps", () => {
  const sources = corpus();
  /** Each source as the compilers read it from the plugin: transpiled by oxc for each runtime. */
  const inputs = (importSource: string) =>
    sources.flatMap(({ id, source }) => {
      try {
        return [{ id, js: transpile(id, source, importSource).code }];
      } catch {
        return [];
      }
    });

  test("print the same code with a map as without", () => {
    let mapped = 0;
    for (const { js } of inputs("@reactre/core")) {
      let plain: string;
      try {
        plain = coreJs(js);
      } catch (e) {
        expect(() => coreJsWithMap(js)).toThrow((e as Error).message);
        continue;
      }
      const { code, map } = coreJsWithMap(js);
      expect(code).toBe(plain);
      if (map !== null) mapped++;
    }
    for (const { js } of inputs("react")) {
      const { code, map } = compatJsWithMap(js);
      expect(code).toBe(compatJs(js));
      if (map !== null) mapped++;
    }
    expect(mapped).toBeGreaterThan(20);
  });

  test("place each name they copy at the same name in their input", () => {
    for (const { id, js } of inputs("@reactre/core")) {
      let out;
      try {
        out = coreJsWithMap(js);
      } catch {
        continue;
      }
      if (out.map !== null) expect([id, misplaced(out.code, out.map as EncodedSourceMap, js)]).toEqual([id, []]);
    }
    for (const { id, js } of inputs("react")) {
      const out = compatJsWithMap(js);
      if (out.map !== null) expect([id, misplaced(out.code, out.map as EncodedSourceMap, js)]).toEqual([id, []]);
    }
  });

  test("the plugin's map takes each name back to the same name in the source", () => {
    // oxc's own map places a few names of TypeScript it strips (`override`, a cast's parentheses)
    // before them; the fixtures have none.
    for (const options of [{}, { compat: true }] as const) {
      const transform = transformOf(options);
      for (const name of ["core.tsx", "compat.jsx"]) {
        const source = readFileSync(FIXTURES + name, "utf8");
        if (options.compat === undefined && name.endsWith(".jsx")) continue;
        const out = transform.call({}, source, FIXTURES + name);
        expect(misplaced(out.code, out.map as EncodedSourceMap, source)).toEqual([]);
        const map = new TraceMap(out.map as EncodedSourceMap);
        expect(map.sources).toEqual([FIXTURES + name]);
        expect(map.sourcesContent).toEqual([source]);
      }
    }
  });

  test("the plugin builds no map when the bundler asks for none, or cannot take one (Bun)", () => {
    const transform = transformOf({});
    const source = readFileSync(FIXTURES + "core.tsx", "utf8");
    const native = (framework: string, rest: object) => ({ getNativeBuildContext: () => ({ framework, ...rest }) });
    const off = [
      native("webpack", { loaderContext: { sourceMap: false } }),
      native("rspack", { loaderContext: { sourceMap: false } }),
      native("esbuild", { build: { initialOptions: {} } }),
      native("bun", { build: { config: { sourcemap: "external" } } }),
      { environment: { mode: "build", config: { build: { sourcemap: false } } } },
    ];
    const on = [
      native("webpack", { loaderContext: { sourceMap: true } }),
      native("esbuild", { build: { initialOptions: { sourcemap: "linked" } } }),
      { environment: { mode: "build", config: { build: { sourcemap: "hidden" } } } },
      { environment: { mode: "dev", config: { build: { sourcemap: false } } } },
      {},
    ];
    const plain = transform.call({}, source, FIXTURES + "core.tsx").code;
    for (const ctx of off)
      expect(transform.call(ctx, source, FIXTURES + "core.tsx")).toEqual({ code: plain, map: null });
    for (const ctx of on) expect(transform.call(ctx, source, FIXTURES + "core.tsx").map).not.toBeNull();
  });
});

// #endregion

// #region Bundles

let out: string;

beforeAll(() => {
  for (const dir of ["dom", "core", "compiler", "compat"]) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: PACKAGES + dir, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`building ${dir} failed:\n${r.stderr.toString()}`);
  }
  // The real path, as stacks name the bundle (on macOS the temp folder is a link).
  out = realpathSync(mkdtempSync(join(tmpdir(), "reactre-plugin-maps-")));
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Bundles `entry` into one ES module at `file`, with its source map at `file`.map. */
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
        sourcemap: true,
        lib: { entry, formats: ["es"], fileName: () => file.split("/").pop()! },
      },
    });
  },
  rollup: async (entry, file, options) => {
    const bundle = await rollup({ input: entry, plugins: [rollupPlugin(options), nodeResolve({ browser: true })] });
    await bundle.write({ file, format: "es", sourcemap: true });
    await bundle.close();
  },
  rolldown: async (entry, file, options) => {
    await rolldown({
      input: entry,
      plugins: [rolldownPlugin(options)],
      platform: "browser",
      output: { file, sourcemap: true },
    });
  },
  esbuild: async (entry, file, options) => {
    await esbuild({
      entryPoints: [entry],
      outfile: file,
      bundle: true,
      format: "esm",
      platform: "browser",
      sourcemap: true,
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
      devtool: "source-map",
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
      devtool: "source-map",
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
      sourcemap: "external",
      plugins: [bunPlugin(options)],
    });
    if (!r.success) throw new AggregateError(r.logs, "Bun.build failed");
  },
};

/** An error the bundle threw, the bundle, and the fixture and message of the throw. */
interface Thrown {
  readonly error: Error;
  readonly file: string;
  readonly fixture: string;
  readonly message: string;
}

/**
 * Bundles both fixtures with bundler `name`, runs them on the fake DOM, and returns the three
 * errors they throw: the component's as it renders, the <For> row's handler's and the compat
 * row's handler's.
 */
async function throwsOf(name: string): Promise<Thrown[]> {
  const core = join(out, `${name}-core.js`),
    compat = join(out, `${name}-compat.js`);
  await bundlers[name]!(FIXTURES + "core.tsx", core, {});
  await bundlers[name]!(FIXTURES + "compat.jsx", compat, { compat: true });
  installFakeDocument();

  const app = (await import(core)) as { mount(el: unknown, boom: boolean): void };
  const component = thrown(() => app.mount(new FakeElement("DIV"), true));
  expect(component.message).toBe("boom: component");
  const root = new FakeElement("DIV");
  app.mount(root, false);
  const row = thrown(() => find(root, "TD").dispatchEvent(new FakeEvent("click")));
  expect(row.message).toBe("boom: row 1");

  const react = (await import(compat)) as { mount(el: unknown): unknown };
  const compatRoot = new FakeElement("DIV");
  react.mount(compatRoot);
  const compatRow = thrown(() => find(compatRoot, "LI").dispatchEvent(new FakeEvent("click")));
  expect(compatRow.message).toBe("boom: compat row 1");
  return [
    { error: component, file: core, fixture: "core.tsx", message: "boom: component" },
    { error: row, file: core, fixture: "core.tsx", message: "boom: row" },
    { error: compatRow, file: compat, fixture: "compat.jsx", message: "boom: compat row" },
  ];
}

/** Where the top frame of `t`'s error in its bundle is in the source, by the bundle's map. */
function original(t: Thrown) {
  const map = new TraceMap(readFileSync(t.file + ".map", "utf8"));
  const p = originalPositionFor(map, frameIn(t.error.stack!, t.file));
  const content = map.sourcesContent?.[map.sources.indexOf(p.source)] ?? null;
  return { source: p.source?.replace(/^webpack:\/\/[^/]*\//, ""), line: p.line, column: p.column, content };
}

// Bun's plugins return code without a map, so its bundles map to the compiled code (below).
describe.each(Object.keys(bundlers).filter((name) => name !== "bun"))("%s", (name) => {
  test("maps a component's, a <For> row's and a compat row's errors to their throw", async () => {
    for (const t of await throwsOf(name)) {
      const { source, line, column } = original(t);
      expect({ source, line, column }).toEqual({
        source: expect.stringMatching(new RegExp(`(^|/)fixtures/sourcemap/${t.fixture.replace(".", "\\.")}$`)),
        ...throwSite(FIXTURES + t.fixture, t.message),
      });
    }
  }, 60_000);
});

describe("bun", () => {
  test("maps the errors to the compiled code, as its plugins return no map", async () => {
    for (const t of await throwsOf("bun")) {
      const { source, line, column, content } = original(t);
      expect(source).toEndWith(`fixtures/sourcemap/${t.fixture}`);
      // The source Bun names holds the plugin's output, and the frame lands on its throw.
      expect(content).toMatch(/\b__(rr|hr)T0\b/);
      const at = content!.split("\n")[line! - 1]!;
      expect(at.slice(column!)).toStartWith(`Error("${t.message}`);
    }
  }, 60_000);
});

describe("vite's dev server", () => {
  test("serves a compiled module with its map inline", async () => {
    const server = await createServer({
      configFile: false,
      root: FIXTURES,
      logLevel: "silent",
      plugins: [vitePlugin()],
      server: { port: 0, fs: { allow: [FIXTURES, PACKAGES] } },
    });
    try {
      await server.listen();
      const code = await (await fetch(new URL("core.tsx", server.resolvedUrls!.local[0]!))).text();
      expect(code).toContain("__rrT0");
      const inline = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,(\S+)\s*$/.exec(code);
      expect(inline).not.toBeNull();
      const map = new TraceMap(Buffer.from(inline![1]!, "base64").toString("utf8"));
      // The `Error` of the component's throw, in the served code, maps to its place in core.tsx.
      const lines = code.split("\n");
      const line = lines.findIndex((l) => l.includes('throw new Error("boom: component")'));
      const p = originalPositionFor(map, { line: line + 1, column: lines[line]!.indexOf("Error(") });
      expect({ line: p.line, column: p.column }).toEqual(throwSite(FIXTURES + "core.tsx", "boom: component"));
      expect(p.source).toEndWith("core.tsx");
    } finally {
      await server.close();
    }
  }, 60_000);
});

// #endregion
