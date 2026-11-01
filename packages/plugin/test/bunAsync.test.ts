// Which runtime of @reactre/core a Bun.build gets, through each of the two Bun plugins
// (@reactre/plugin/bun and @reactre/compiler's reactreCompiler). Bun resolves the core's sources
// for target "bun" and with the "reactre-source" condition, its async build for target "browser"
// outside production (the "development" condition), and its default build in production. A
// program that imports neither @reactre/core/features/async nor /actions (the benchmark app) gets
// none of the async runtime's code whichever it resolved; one that imports features/async gets it,
// and works. Where no program is read, the async runtime stays.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reactreCompiler } from "@reactre/compiler";
import { coreRuntime } from "@reactre/compiler/program";
import * as core from "@reactre/core";
import { FakeElement, installFakeDocument } from "@reactre/testdom";
import type { BunPlugin } from "bun";

import { withoutAsync } from "../../core/src/withoutAsync.ts";
import bunPlugin from "../src/bun.ts";
import type { ReactreOptions } from "../src/index.ts";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const JFB = new URL("../../../apps/jfb/app/reactre.tsx", import.meta.url).pathname;
const ASYNC_APP = new URL("../fixtures/async/main.tsx", import.meta.url).pathname;

/** Names only the core's `// #if ASYNC` blocks define. */
const MARKERS = ["drainAsync", "__installAsync", "class Computed", "entangled"];

let out: string;

beforeAll(() => {
  // Target "browser" resolves the packages' dist builds.
  for (const dir of ["dom", "core"]) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: PACKAGES + dir, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`building ${dir} failed:\n${r.stderr.toString()}`);
  }
  // Named as coverage expects the bundles plugin tests build (bunfig.toml).
  out = mkdtempSync(join(tmpdir(), "reactre-plugin-bun-async-"));
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

/** The two Bun plugins, each made with the same options. */
const plugins: Record<string, (options: ReactreOptions & { async?: boolean }) => BunPlugin> = {
  "@reactre/plugin/bun": (o) => bunPlugin(o),
  reactreCompiler: (o) => reactreCompiler(o),
};

/** How a Bun.build resolves @reactre/core: its options, and whether it loads the core's sources. */
const resolutions = {
  "target bun (the sources)": { target: "bun", conditions: [] as string[], sources: true },
  '"reactre-source" (the sources)': { target: "browser", conditions: ["reactre-source"], sources: true },
  'target browser, "development" (the async build)': { target: "browser", conditions: [] as string[], sources: false },
  'target browser, "production" (the default build)': { target: "browser", conditions: ["production"], sources: false },
} as const;

let n = 0;
/** Bun.build `entry` into one unminified module, returning its path and code. */
async function build(
  entry: string,
  plugins: BunPlugin | BunPlugin[],
  how: { target: "bun" | "browser"; conditions: readonly string[] },
): Promise<{ file: string; code: string }> {
  const dir = join(out, String(n++));
  const r = await Bun.build({
    entrypoints: [entry],
    outdir: dir,
    target: how.target,
    format: "esm",
    conditions: [...how.conditions],
    plugins: Array.isArray(plugins) ? plugins : [plugins],
  });
  if (!r.success) throw new AggregateError(r.logs, "Bun.build failed");
  return { file: r.outputs[0]!.path, code: await r.outputs[0]!.text() };
}

/** Every message in a Bun.build error: its own, and those of its logs. */
function messages(e: unknown): string {
  const logs = (e as { errors?: unknown[] }).errors ?? [];
  return [String((e as Error).message), ...logs.map((l) => String((l as Error).message ?? l))].join("\n");
}

describe.each(Object.keys(plugins))("%s", (name) => {
  const plugin = plugins[name]!;

  describe.each(Object.keys(resolutions))("%s", (how) => {
    const resolution = resolutions[how as keyof typeof resolutions];

    test("the benchmark app, which imports neither module, ships none of the async runtime", async () => {
      const { code } = await build(JFB, plugin({}), resolution);
      expect(code).toContain("selector");
      for (const m of MARKERS) expect(code).not.toContain(m);
      // From the sources, it is byte for byte the bundle of the core stripped as its default
      // build is made (Bun loads a file with the first plugin's onLoad that returns it).
      if (resolution.sources)
        expect(code).toBe((await build(JFB, [withoutAsync, plugin({ async: true })], resolution)).code);
      // With the async runtime asked for, what the app's batches call of it is there: the markers
      // do find it (what it does not call, as `__installAsync`, is tree-shaken).
      const on = await build(JFB, plugin({ async: true }), resolution);
      expect(on.code).toContain("drainAsync");
    }, 30_000);

    test("an app that imports features/async gets the async runtime, and works", async () => {
      const { file, code } = await build(ASYNC_APP, plugin({}), resolution);
      for (const m of ["drainAsync", "__installAsync", "NotReadyError"]) expect(code).toContain(m);
      installFakeDocument();
      const root = new FakeElement("DIV");
      const app = (await import(file)) as { mount(el: unknown): void; resolve(v: string): void };
      app.mount(root);
      expect(root.textContent).toBe("wait");
      app.resolve("ready");
      await new Promise((r) => setTimeout(r, 0));
      expect(root.textContent).toBe("ready");
    }, 30_000);
  });

  test("with no program read (`wholeProgram: false`), the async runtime, which is right either way", async () => {
    const { code } = await build(JFB, plugin({ wholeProgram: false }), resolutions["target bun (the sources)"]);
    expect(code).toContain("drainAsync");
  }, 30_000);

  test("`async: false` with an app that imports features/async fails the build, naming the option", async () => {
    const e = await build(ASYNC_APP, plugin({ async: false }), resolutions["target bun (the sources)"]).catch(
      (e: unknown) => e,
    );
    expect(messages(e)).toContain("needs @reactre/core's async runtime");
    expect(messages(e)).toContain("the plugin's `async` option is false");
  }, 30_000);

  test("a module the program did not read that imports features/async fails the build", async () => {
    // A virtual module, which another plugin serves and the program cannot see into, imports it.
    const late: BunPlugin = {
      name: "late",
      setup(b) {
        b.onResolve({ filter: /^virtual:late$/ }, () => ({ path: "late", namespace: "late" }));
        b.onLoad({ filter: /.*/, namespace: "late" }, () => ({
          contents: `export * from ${JSON.stringify(ASYNC_APP)};`,
          loader: "js",
        }));
      },
    };
    const entry = join(out, "late-entry.js");
    writeFileSync(entry, 'export * from "virtual:late";\n');
    const e = await Bun.build({ entrypoints: [entry], target: "bun", plugins: [late, plugin({})] }).catch(
      (e: unknown) => e,
    );
    expect(messages(e)).toContain("imports neither @reactre/core/features/async nor /actions");
  }, 30_000);
});

describe("coreRuntime", () => {
  test("a core whose sources ship no stripper has no async blocks: its index.ts is loaded as it is", async () => {
    const at = join(out, "old-core");
    mkdirSync(join(at, "src"), { recursive: true });
    writeFileSync(join(at, "package.json"), '{ "name": "@reactre/core" }');
    const index = join(at, "src/index.ts");
    expect(await coreRuntime(index, () => "export const a = 1;\n", false, false)).toBe("export const a = 1;\n");
    expect(await coreRuntime(index, () => "unread", true, false)).toBeNull();
  });
});

describe("bun run and bun test", () => {
  test("run the core's sources, whose async runtime is there, inert until a module turns it on", () => {
    // No Bun.build, so no program: the `bun` condition loads src/index.ts as it is.
    expect(typeof core.__installAsync).toBe("function");
    expect(core.memo(() => Promise.resolve(1))()).toBeInstanceOf(Promise);
  });
});
