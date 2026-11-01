// A caller the whole program misses can never leave a production build's UI stale. Label
// (fixtures/missed/label.tsx) reads `{props.text}`; the program read at the build's start may see
// only callers that pass it a literal, while ./hidden/caller.tsx passes `text={count()}`. Each
// production build here reaches that caller in a way the program cannot see, and must end in one
// of two ways: the bundle, run on the fake DOM, updates when count changes (Label's hole is
// bound), or the build fails, naming both modules. A build that succeeds with Label's hole
// written once would be the bug this guards against.
//
//   - Seen as unknowable, so each file is compiled alone (Label is exported, so every prop of it
//     is reactive): `import.meta.glob`, `import(expr)`, a virtual module, a file of a type that is
//     not a script.
//   - Seen: a plain JavaScript module that re-exports the caller is read like any script.
//   - Late: a chunk another plugin adds, which the program read from the entries does not hold,
//     joins at its transform. Transformed before Label, it is in the facts Label is compiled with;
//     after, the build fails. The order is forced by holding one module's load until the other
//     has been transformed.
//
// And the same app behaves the same on Vite's dev server, which compiles each file alone, as in
// `vite build`, which reads the whole program.
//
// The fixture runs from a copy in a temp folder, where the test writes its two JavaScript
// modules (the repository holds none): ./reexport.js and ./hidden/byhand.js, from the sources
// below. The copy's node_modules is the plugin's, so its imports resolve as the fixture's do.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { reactreCompiler } from "@reactre/compiler";
import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import type { BunPlugin } from "bun";
import { build as esbuild, type Plugin as EsbuildPlugin } from "esbuild";
import { type Plugin as RollupPlugin, rollup } from "rollup";
import { build as vite, createServer, type Plugin as VitePlugin } from "vite";
import webpack from "webpack";

import bunPlugin from "../src/bun.ts";
import esbuildPlugin from "../src/esbuild.ts";
import rollupPlugin from "../src/rollup.ts";
import vitePlugin from "../src/vite.ts";
import webpackPlugin from "../src/webpack.ts";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

/** ./reexport.js: a plain JavaScript module that re-exports the caller. */
const REEXPORT = `export { Caller, setCount } from "./hidden/caller.tsx";\n`;
/**
 * ./hidden/byhand.js: Label called by hand, with no JSX: `text` passed reactively as a getter,
 * from a JavaScript module the plugin does not compile.
 */
const BYHAND_SOURCE = `import { render, signal } from "@reactre/core";

import { Label } from "../label.tsx";

const [count, setCount] = signal(0);

export function mount(el) {
  render(
    () =>
      Label({
        get text() {
          return count();
        },
      }),
    el,
  );
  return setCount;
}
`;

// Named as coverage expects the bundles plugin tests build (bunfig.toml). The real path, as the
// bundlers name modules by it.
const out = realpathSync(mkdtempSync(join(tmpdir(), "reactre-plugin-missed-")));
const MISSED = join(out, "missed/");
cpSync(FIXTURES + "missed", MISSED, { recursive: true });
symlinkSync(realpathSync(new URL("../node_modules", import.meta.url).pathname), join(out, "node_modules"));
writeFileSync(MISSED + "reexport.js", REEXPORT);
writeFileSync(MISSED + "hidden/byhand.js", BYHAND_SOURCE);
const LABEL = MISSED + "label.tsx",
  CALLER = MISSED + "hidden/caller.tsx",
  BYHAND = MISSED + "hidden/byhand.js";

beforeAll(() => {
  for (const dir of ["dom", "core"]) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: PACKAGES + dir, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`building ${dir} failed:\n${r.stderr.toString()}`);
  }
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

// #region Plugins of the test's own

/** `virtual:callers`, a virtual module that re-exports the caller. */
const virtualRollup: RollupPlugin = {
  name: "virtual-callers",
  resolveId: (id) => (id === "virtual:callers" ? "\0virtual:callers" : null),
  load: (id) => (id === "\0virtual:callers" ? `export * from ${JSON.stringify(CALLER)};` : null),
};

/** A `.callers` file, a list of modules to re-export, loaded as a module that re-exports them. */
const listSource = (file: string): string =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => `export * from ${JSON.stringify(join(dirname(file), l.trim()))};`)
    .join("\n");
const listRollup: RollupPlugin = {
  name: "callers-list",
  load: (id) => (id.endsWith(".callers") ? listSource(id) : null),
};

/** Rollup leaves `import(expr)` to run time; this resolves the fixture's to the caller, as a plugin for dynamic imports would. */
const dynamicRollup: RollupPlugin = {
  name: "dynamic-callers",
  resolveDynamicImport: (spec) => (typeof spec === "string" ? null : { id: CALLER }),
};

const virtualEsbuild: EsbuildPlugin = {
  name: "virtual-callers",
  setup(build) {
    build.onResolve({ filter: /^virtual:callers$/ }, () => ({ path: "callers", namespace: "virtual" }));
    build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
      contents: `export * from ${JSON.stringify(CALLER)};`,
      resolveDir: MISSED,
    }));
  },
};

const listEsbuild: EsbuildPlugin = {
  name: "callers-list",
  setup(build) {
    build.onLoad({ filter: /\.callers$/ }, (a) => ({ contents: listSource(a.path), loader: "js", resolveDir: MISSED }));
  },
};

/** `virtual:byhand`, a virtual module with ./hidden/byhand.js's code; it has no directory to resolve from. */
const VIRTUAL_BYHAND = "\0virtual:byhand";
const byhandSource = BYHAND_SOURCE.replace('"../label.tsx"', JSON.stringify(LABEL)).replace(
  '"@reactre/core"',
  JSON.stringify(PACKAGES + "core/dist/index.js"),
);

/**
 * Adds caller `caller` as a chunk of its own at the build's start, and transforms it before Label
 * (`first: "caller"`) or after (`first: "label"`): the other one's load waits for that transform.
 * Returns the plugin that holds the load, which goes before reactre's, and the one that sees the
 * transform, after it.
 */
function lateCaller(first: "caller" | "label", caller: string): [RollupPlugin, RollupPlugin] {
  const [waits, done] = first === "caller" ? [LABEL, caller] : [caller, LABEL];
  let release!: () => void;
  const transformed = new Promise<void>((r) => (release = r));
  const hold: RollupPlugin = {
    name: "late-caller",
    buildStart() {
      this.emitFile({ type: "chunk", id: caller, fileName: "late-caller.js" });
    },
    resolveId: (id) => (id === VIRTUAL_BYHAND ? id : null),
    async load(id) {
      if (id === waits) await transformed;
      return id === VIRTUAL_BYHAND ? byhandSource : null;
    },
  };
  const seen: RollupPlugin = {
    name: "late-caller-seen",
    transform(_, id) {
      if (id === done) release();
      return null;
    },
  };
  // Vite orders them by `enforce`, Rollup by their place in the list.
  return [Object.assign(hold, { enforce: "pre" }), Object.assign(seen, { enforce: "post" })];
}

// #endregion

// #region Builds

/** Production builds of `entry` into one directory, each with the plugin and the test's own plugins. */
const builds = {
  vite: async (entry: string, dir: string, extra: VitePlugin[] = [], after: VitePlugin[] = []) => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [...extra, vitePlugin(), ...after],
      build: {
        outDir: dir,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: () => "main.js" },
      },
    });
  },
  rollup: async (entry: string, dir: string, extra: RollupPlugin[] = [], after: RollupPlugin[] = []) => {
    const bundle = await rollup({
      input: entry,
      plugins: [...extra, rollupPlugin(), ...after, nodeResolve({ browser: true })],
    });
    await bundle.write({ dir, format: "es", entryFileNames: "main.js" });
    await bundle.close();
  },
  esbuild: async (entry: string, dir: string, extra: EsbuildPlugin[] = []) => {
    await esbuild({
      entryPoints: [entry],
      outfile: join(dir, "main.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
      plugins: [...extra, esbuildPlugin()],
    });
  },
  webpack: async (entry: string, dir: string) => {
    const compiler = webpack({
      mode: "production",
      entry,
      output: { path: dir, filename: "main.js", library: { type: "module" } },
      experiments: { outputModule: true },
      optimization: { minimize: false },
      devtool: false,
      plugins: [webpackPlugin()],
    });
    const stats = await promisify(compiler.run.bind(compiler))();
    await promisify(compiler.close.bind(compiler))();
    if (stats?.hasErrors()) throw new Error(stats.toString("errors-only"));
  },
};
type Name = keyof typeof builds;

let n = 0;
/** A fresh output directory. */
const fresh = (name: string): string => join(out, `${name}-${n++}`);

/** Tags, classes and text, to compare what was rendered. */
function html(el: FakeElement): string {
  let s = "";
  for (let c = el.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase(),
        cls = c.getAttribute("class");
      s += `<${tag}${cls ? ` class="${cls}"` : ""}>${html(c)}</${tag}>`;
    } else s += c.textContent;
  }
  return s;
}

/** The code of every chunk built into `dir`. */
const chunks = (dir: string): string =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

/** Run the app built into `dir`: it must show count and follow it. Returns the build's code. */
async function updates(dir: string): Promise<string> {
  installFakeDocument();
  const root = new FakeElement("DIV");
  const app = (await import(join(dir, "main.js"))) as { mount(el: unknown): Promise<(n: number) => void> };
  const setCount = await app.mount(root);
  expect(html(root)).toBe('<main><b class="label">static</b><b class="label">0</b></main>');
  setCount(1);
  expect(html(root)).toBe('<main><b class="label">static</b><b class="label">1</b></main>');
  return chunks(dir);
}

/** Label's hole, as each bundler prints it: bound (an effect reads it), not a clone value. */
const BOUND = /\(\) => \(?props\.text\)?\)/;

// #endregion

describe("a caller the program cannot see: each file is compiled alone, and Label's hole is bound", () => {
  const cases: [string, string, Partial<Record<Name, () => unknown[]>>][] = [
    ["import.meta.glob", "glob.tsx", { vite: () => [] }],
    [
      "import(expr)",
      "dynamic.tsx",
      { vite: () => [], rollup: () => [dynamicRollup], esbuild: () => [], webpack: () => [] },
    ],
    [
      "a virtual module",
      "virtual.tsx",
      { vite: () => [virtualRollup], rollup: () => [virtualRollup], esbuild: () => [virtualEsbuild] },
    ],
    [
      "a file that is not a script",
      "list.tsx",
      { vite: () => [listRollup], rollup: () => [listRollup], esbuild: () => [listEsbuild] },
    ],
  ];
  for (const [what, entry, by] of cases)
    for (const [name, extra] of Object.entries(by) as [Name, () => unknown[]][])
      test(`${name}: ${what}`, async () => {
        const dir = fresh(name);
        await (builds[name] as (e: string, d: string, x: unknown[]) => Promise<void>)(MISSED + entry, dir, extra());
        expect(await updates(dir)).toMatch(BOUND);
      }, 60_000);
});

describe("a caller the program sees through a plain JavaScript module", () => {
  for (const name of Object.keys(builds) as Name[])
    test(
      name,
      async () => {
        const dir = fresh(name);
        await builds[name](MISSED + "plain.tsx", dir);
        expect(await updates(dir)).toMatch(BOUND);
      },
      60_000,
    );
});

describe("a caller that joins at its transform, as a chunk another plugin adds", () => {
  const late = { vite: builds.vite, rollup: builds.rollup } as const;
  const callers: [string, string, string][] = [
    ["a .tsx caller", CALLER, "text"],
    // Modules the plugin does not compile: what they do with Label is a use as a value.
    ["a JavaScript module that calls Label by hand", BYHAND, "(every prop)"],
    ["a virtual module that calls Label by hand", VIRTUAL_BYHAND, "(every prop)"],
  ];
  for (const [name, build] of Object.entries(late))
    for (const [what, caller, prop] of callers) {
      test(`${name}, ${what}: transformed before Label, it is in Label's facts, and the app updates`, async () => {
        const dir = fresh(name);
        const [hold, seen] = lateCaller("caller", caller);
        await build(MISSED + "late.tsx", dir, [hold as never], [seen as never]);
        installFakeDocument();
        const root = new FakeElement("DIV");
        const app = (await import(join(dir, "late-caller.js"))) as { mount(el: unknown): (n: number) => void };
        const setCount = app.mount(root);
        expect(root.textContent).toBe("0");
        setCount(2);
        expect(root.textContent).toBe("2");
      }, 60_000);

      test(`${name}, ${what}: transformed after Label, compiled already without it, the build fails naming both`, async () => {
        const [hold, seen] = lateCaller("label", caller);
        const failure = await build(MISSED + "late.tsx", fresh(name), [hold as never], [seen as never]).then(
          () => "(built)",
          (e: unknown) => String((e as Error).message ?? e),
        );
        expect(failure).toContain(`${caller} was not in the program read before the build`);
        expect(failure).toContain(`it passes ${prop} reactively to Label in ${LABEL}, compiled already`);
      }, 60_000);
    }

  // A file that is not a script, which another plugin makes code of: it joins once every plugin
  // has transformed it, as JavaScript. Its code calls Label by hand.
  const calls = MISSED + "hidden/byhand.calls";
  const callsRollup: RollupPlugin = {
    name: "calls",
    resolveId: (id) => (id === calls ? id : null),
    load: (id) => (id === calls ? byhandSource : null),
  };
  for (const [name, build] of Object.entries(late)) {
    test(`${name}, a file that is not a script, made code by another plugin: transformed after Label, the build fails`, async () => {
      const [hold, seen] = lateCaller("label", calls);
      const failure = await build(
        MISSED + "late.tsx",
        fresh(name),
        [hold as never, callsRollup as never],
        [seen as never],
      ).then(
        () => "(built)",
        (e: unknown) => String((e as Error).message ?? e),
      );
      expect(failure).toContain(`${calls} was not in the program read before the build`);
      expect(failure).toContain(`it passes (every prop) reactively to Label in ${LABEL}, compiled already`);
    }, 60_000);

    test(`${name}, the same file transformed before Label: the app updates, or the build fails naming both`, async () => {
      // It joins after its transform, when its code is parsed: Label may be compiled in between.
      const dir = fresh(name);
      const [hold, seen] = lateCaller("caller", calls);
      const failure = await build(
        MISSED + "late.tsx",
        dir,
        [hold as never, callsRollup as never],
        [seen as never],
      ).then(
        () => null,
        (e: unknown) => String((e as Error).message ?? e),
      );
      if (failure !== null) {
        expect(failure).toContain(`${calls} was not in the program read before the build`);
        expect(failure).toContain(`reactively to Label in ${LABEL}, compiled already`);
        return;
      }
      installFakeDocument();
      const root = new FakeElement("DIV");
      const app = (await import(join(dir, "late-caller.js"))) as { mount(el: unknown): (n: number) => void };
      const setCount = app.mount(root);
      setCount(3);
      expect(root.textContent).toBe("3");
    }, 60_000);
  }
});

describe("bun: a virtual module another plugin serves, which calls Label by hand", () => {
  /** `virtual:callers` as a Bun plugin serves it: Caller calls Label with a getter, no JSX. */
  const virtualBun: BunPlugin = {
    name: "virtual-callers",
    setup(build) {
      build.onResolve({ filter: /^virtual:callers$/ }, () => ({ path: "callers", namespace: "virtual" }));
      build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
        contents:
          `import { signal } from ${JSON.stringify(PACKAGES + "core/src/index.ts")};\n` +
          `import { Label } from ${JSON.stringify(LABEL)};\n` +
          "const [count, setCount] = signal(0);\n" +
          "export { setCount };\n" +
          "export const Caller = () => Label({ get text() { return count(); } });\n",
        loader: "js",
      }));
    },
  };
  const plugins: [string, () => BunPlugin][] = [
    ["@reactre/plugin", () => bunPlugin()],
    ["@reactre/compiler's own plugin", () => reactreCompiler()],
  ];
  for (const [name, plugin] of plugins)
    test(`${name}: Bun cannot resolve it, so the program gives up, and Label's hole is bound`, async () => {
      const dir = fresh("bun");
      const r = await Bun.build({
        entrypoints: [MISSED + "virtual.tsx"],
        conditions: ["reactre-source"],
        outdir: dir,
        naming: "main.js",
        target: "browser",
        format: "esm",
        plugins: [virtualBun, plugin()],
      });
      if (!r.success) throw new AggregateError(r.logs, "Bun.build failed");
      expect(await updates(dir)).toMatch(BOUND);
    }, 60_000);
});

describe("vite: the dev server and a production build of one app behave the same", () => {
  /** Render the props fixture, click its button, and say what showed each time. */
  async function drive(app: { mount(el: unknown): void }): Promise<string[]> {
    installFakeDocument();
    const root = new FakeElement("DIV");
    app.mount(root);
    const seen = [html(root)];
    const button = (root.firstChild as FakeElement).lastChild as FakeElement;
    button.dispatchEvent(new FakeEvent("click"));
    seen.push(html(root));
    button.dispatchEvent(new FakeEvent("click"));
    seen.push(html(root));
    return seen;
  }

  test("each file alone on the dev server, the whole program in the build", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: FIXTURES + "props",
      // ssrLoadModule runs the app here, on a fake DOM: `ssr: false` keeps it the browser's code.
      plugins: [vitePlugin({ ssr: false })],
      appType: "custom",
      server: { middlewareMode: true, ws: false },
    });
    let dev: string[], devLabel: string;
    try {
      dev = await drive((await server.ssrLoadModule("/main.tsx")) as { mount(el: unknown): void });
      devLabel = (await server.transformRequest("/label.tsx"))!.code;
    } finally {
      await server.close();
    }
    const dir = fresh("vite-props");
    await builds.vite(FIXTURES + "props/main.tsx", dir);
    const built = await drive((await import(join(dir, "main.js"))) as { mount(el: unknown): void });
    expect(built).toEqual(dev);
    expect(dev[1]).toContain('<span class="count">1</span>');
    // The dev server saw label.tsx alone, where Label is exported: its hole is bound. The build saw
    // every caller pass a literal: it is a clone value.
    expect(devLabel).toMatch(BOUND);
    expect(chunks(dir)).toMatch(/clone\(\[\(?props\.text\)?\]\)/);
  }, 60_000);
});
