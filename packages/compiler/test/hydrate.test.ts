// Tests of @reactre/compiler's hydrate mode (`{ hydrate: true }`): what it writes for each construct
// (templates that claim, slots, lists, fragments, <Portal>, <Dynamic>), its imports, the compile
// error for a file that hydrates without it, the Bun plugin's `hydrate` option and the core's
// runtime it loads. What the code does over a page is tested in packages/core/test/hydrate.test.ts,
// and through real builds there and in packages/plugin/test/ssr.test.ts. Without the option, the
// output is the client's as before: the golden snapshots (compiler.test.ts) hold it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileJs,
  compileJsWithMap,
  compileSource,
  hydrateImports,
  ReactreCompileError,
  reactreCompiler,
  transpileSource,
} from "../src/index.ts";
import { coreRuntime } from "../src/program.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** `src` compiled for hydration. */
const hyd = (src: string): string => compileSource(src, "tsx", { hydrate: true });

describe("imports", () => {
  test("the app's imports of @reactre/core stay; features/async and /errors point at the hydrate builds", () => {
    const out = hydrateImports(
      [
        `import { signal } from "@reactre/core";`,
        `import { Loading } from "@reactre/core/features/async";`,
        `import { Errored } from '@reactre/core/features/errors';`,
        `import { createContext } from "@reactre/core/features/context";`,
      ].join("\n"),
    );
    expect(out).toContain(`from "@reactre/core";`);
    expect(out).toContain(`from "@reactre/core/hydrate/async";`);
    expect(out).toContain(`from '@reactre/core/hydrate/errors';`);
    expect(out).toContain(`from "@reactre/core/features/context";`);
  });

  test("the core's own feature modules import the core from features/hydrate", () => {
    const out = hydrateImports(
      `import { __frag } from "@reactre/core";\nimport { __scope } from "@reactre/core/features/context";`,
      false,
    );
    expect(out).toContain(`from "@reactre/core/features/hydrate";`);
    expect(out).toContain(`from "@reactre/core/features/context";`);
  });

  test("compiled code imports the core's helpers and the claim helpers from features/hydrate; a file with no JSX only has its imports pointed", () => {
    const out = hyd(
      `import { signal } from "@reactre/core"; const [n] = signal(1); export const A = () => <p>{n()}</p>;`,
    );
    expect(out).toMatch(/^import \{ [^}]*__hclone as __rrhC[^}]* \} from "@reactre\/core\/features\/hydrate";/);
    // The app's own import is the same core: features/hydrate re-exports it.
    expect(out).toContain(`import { signal } from "@reactre/core";`);
    const plain = compileJs(`import { Loading } from "@reactre/core/features/async";\nexport { Loading };`, {
      hydrate: true,
    });
    expect(plain).toContain(`from "@reactre/core/hydrate/async"`);
    // A server build ignores the option.
    expect(compileSource(`export const A = () => <p />;`, "tsx", { server: true, hydrate: true })).toContain("__rrsH");
  });
});

describe("constructs", () => {
  test("a template claims, its reactive holes start undefined so the page's value stays until the bind writes", () => {
    const out = hyd(`export const A = (p) => <p title={p.t} class="c">{"x"}{p.n}</p>;`);
    expect(out).toContain("__rrhC(__rrT0, [");
    expect(out).toContain("void 0");
    expect(out).not.toContain(".clone(");
    // One with nothing after it is the call alone.
    expect(hyd(`export const B = () => <p>x</p>;`)).toContain(`__rrhC(__rrT0, [])`);
  });

  test("slots, inserted components, rows' slots and lists claim through the hydrate helpers", () => {
    const out = hyd(`
      import { For, Show } from "@reactre/core";
      const C = () => <i />;
      export const A = (p) => (
        <div>
          <C />
          {p.on ? <b /> : null}
          <Show when={p.on}>{(v) => <u>{v()}</u>}</Show>
          <ul><For each={p.rows} key={(r) => r}>{(r) => <li>{r}{p.on ? <b /> : null}</li>}</For></ul>
          <ol><For each={p.rows} key={(r) => r} fallback={<li>none</li>}>{(r) => <li>{r}</li>}</For></ol>
          <p><For each={p.rows} key={(r) => r}>{(r) => <a>{r}</a>}</For><b /></p>
        </div>
      );
    `);
    expect(out).toContain("__rrhI(__n[");
    expect(out).toContain("__rrhS(__n[");
    expect(out).toContain("__rrhS(__m, ");
    expect(out).toMatch(/__rrhF\(__rrForM, __n\[\d\], \{[^]*?\}, 1\);/);
    expect(out).toMatch(/__rrhF\(__rrFor, __n\[\d\], \{[^]*?\}, 0\);/);
    expect(out).toMatch(/__rrhF\(__rrForM?, __n\[\d\], \{[^]*?\}, 2\);/);
    // The template with the fallback list says which hole is two pairs of markers.
    expect(out).toMatch(/__rrhT\(__rrT\(.*\), \[\d\]\)/);
  });

  test("fragments pass what they build at once as functions, in order; <Portal> and <Dynamic> use their helpers", () => {
    const out = hyd(`
      import { Dynamic, Portal } from "@reactre/core";
      export const F = (p) => <>a<b />{p.x}{"s"}<Portal><i /></Portal></>;
      export const D = (p) => <Dynamic component={p.tag} class="t"><b /></Dynamic>;
      export const S = (p) => <Dynamic component={p.tag} svg />;
    `);
    expect(out).toMatch(/__rrFrag\(\[.*\], \[[\d, ]+\]\)/);
    expect(out).toContain("__rrhP(() => __rrUntrack(");
    expect(out).toContain("__rrhK(__rrE, () => (");
    expect(out).toContain("__rrhE(__rrD)");
    // Without the mode, the same file's fragments have no indexes.
    expect(compileSource(`export const F = () => <>a<b /></>;`)).not.toMatch(/__rrFrag\(\[.*\], \[/);
  });

  test("with a source map, the hydrate output maps back to the module", () => {
    const js = transpileSource(
      `import { Errored } from "@reactre/core/features/errors";\nexport const A = () => <p>x</p>;`,
      "tsx",
    );
    const { code, map } = compileJsWithMap(js, { hydrate: true });
    expect(code).toContain(`from "@reactre/core/hydrate/errors"`);
    expect(code).toContain("__rrhC(");
    expect(map).not.toBeNull();
  });
});

describe("the server's output hydration reads", () => {
  test("an element with a key that may change, outside an element, is a slot on the server too, as on the client", () => {
    const out = compileSource(`export const A = (p) => <p key={p.k}>x</p>;`, "tsx", { server: true });
    expect(out).toContain("__rrsS(");
    expect(compileSource(`export const A = () => <p key="k">x</p>;`, "tsx", { server: true })).not.toContain("__rrsS(");
  });
});

describe("the hydrate compile error", () => {
  test("a file that imports hydrate needs the mode, aliased or not; isHydrating alone does not", () => {
    const src = (names: string) =>
      `import { ${names} } from "@reactre/core/features/hydrate"; export const A = () => <p />;`;
    for (const names of ["hydrate", "isHydrating, hydrate as h"]) {
      expect(() => compileSource(src(names))).toThrow(ReactreCompileError);
      expect(() => compileSource(src(names))).toThrow("@reactre/plugin's `hydrate: true` option");
      expect(() => compileSource(src(names), "tsx", { hydrate: true })).not.toThrow();
    }
    expect(() => compileSource(src("isHydrating"))).not.toThrow();
  });
});

describe("reactreCompiler({ hydrate: true })", () => {
  const files: string[] = [],
    dirs: string[] = [];
  afterAll(() => {
    files.forEach((f) => unlinkSync(f));
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  /** The plugin's load hooks, from a stand-in for Bun's build object. */
  function hooks(options: Parameters<typeof reactreCompiler>[0]) {
    const loads: { filter: RegExp; cb: (args: { path: string }) => Promise<unknown> }[] = [];
    reactreCompiler(options).setup({
      config: {},
      onLoad: (opts: { filter: RegExp }, cb: (args: { path: string }) => Promise<unknown>) =>
        void loads.push({ filter: opts.filter, cb }),
    } as never);
    return loads;
  }

  test("compiles for hydration, and loads the core's feature modules with features/hydrate for the core", async () => {
    const loads = hooks({ hydrate: true });
    expect(loads.length).toBe(3);
    const [, feature, compile] = loads as [unknown, (typeof loads)[number], (typeof loads)[number]];
    const context = join(ROOT, "packages/core/src/features/context.ts");
    expect(feature.filter.test(context)).toBe(true);
    const out = (await feature.cb({ path: context })) as { contents: string; loader: string };
    expect(out.loader).toBe("ts");
    expect(out.contents).toContain(`from "@reactre/core/features/hydrate"`);
    expect(out.contents).not.toMatch(/from "@reactre\/core";/);
    // features/hydrate itself imports the core as it is, and a file of another package is left alone.
    expect(await feature.cb({ path: join(ROOT, "packages/core/src/features/hydrate.ts") })).toBeUndefined();
    expect(await feature.cb({ path: "/elsewhere/core/src/features/context.ts" })).toBeUndefined();
    const path = join(tmpdir(), `reactre-compiler-hydrate-${process.pid}.tsx`);
    await Bun.write(path, `export const A = () => <p>{n()}</p>;`);
    files.push(path);
    expect(((await compile.cb({ path })) as { contents: string }).contents).toContain("__rrhC(");
    // With `server`, a server build.
    expect(hooks({ hydrate: true, server: true }).length).toBe(3);
  });

  test("the core's runtime: the server without its development block in a production build, so an <Errored>'s marker names no error", async () => {
    const src = join(ROOT, "packages/core/src/server.ts");
    const code = await Bun.file(src).text();
    expect(code).toContain("encodeURIComponent(e.message)");
    const prod = (await coreRuntime(src, () => code, false, false))!;
    expect(prod).not.toContain("encodeURIComponent(e.message)");
    expect(prod).toContain(`return new Html(["<!--rr:e-->"]);`);
    expect(await coreRuntime(src, () => code, false, false, true)).toBeNull();
    const at = mkdtempSync(join(tmpdir(), "reactre-compiler-hydrate-server-"));
    dirs.push(at);
    const dist = join(at, "core/dist/server.js"),
      dev = join(at, "core/dist/dev/server.js");
    // A core with one build of it: as it is.
    await Bun.write(dist, "");
    expect(await coreRuntime(dist, () => "", false, false, true)).toBeNull();
    await Bun.write(dev, "");
    expect(await coreRuntime(dist, () => "", false, false)).toBeNull();
    expect(await coreRuntime(dist, () => "", false, false, true)).toBe(`export * from "./dev/server.js";\n`);
    expect(await coreRuntime(dev, () => "", false, false, true)).toBeNull();
    expect(await coreRuntime(dev, () => "", true, false)).toBe(`export * from "../server.js";\n`);
  });

  test("the core's runtime: features/hydrate without its development blocks in a production build, the development build's in a dev server's", async () => {
    const src = join(ROOT, "packages/core/src/features/hydrate.ts");
    const code = await Bun.file(src).text();
    expect(code).toContain("// #if DEV");
    const prod = (await coreRuntime(src, () => code, false, false))!;
    expect(prod).not.toContain("HYDRATION_MISMATCH");
    expect(prod).toContain("export function hydrate(");
    expect(await coreRuntime(src, () => code, false, false, true)).toBeNull();
    // A core's two builds of it, in a folder of their own (this test does not build the package).
    const at = mkdtempSync(join(tmpdir(), "reactre-compiler-hydrate-core-"));
    const dist = join(at, "core/dist/features/hydrate.js"),
      dev = join(at, "core/dist/dev/features/hydrate.js");
    await Bun.write(dist, "");
    await Bun.write(dev, "");
    dirs.push(at);
    expect(await coreRuntime(dist, () => "", false, false)).toBeNull();
    expect(await coreRuntime(dist, () => "", false, false, true)).toBe(`export * from "../dev/features/hydrate.js";\n`);
    expect(await coreRuntime(dev, () => "", false, false, true)).toBeNull();
    expect(await coreRuntime(dev, () => "", true, false)).toBe(`export * from "../../features/hydrate.js";\n`);
  });
});
