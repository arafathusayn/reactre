// A production build of an app whose store is in one module (fixtures/stores/state.ts) and is read
// in others: the whole program tells the compiler that the import is a store, so a hole that reads
// its member is bound, a prop passed one is a getter that the component's hole follows, and a
// <For> over its array follows pushes, removals and its items' in-place writes. The bundle runs
// on the fake DOM.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoreSetter } from "@reactre/core/features/store";
import { FakeElement, installFakeDocument } from "@reactre/testdom";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";

import type { Todo } from "../fixtures/stores/state.ts";
import esbuildPlugin from "../src/esbuild.ts";
import vitePlugin from "../src/vite.ts";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const APP = new URL("../fixtures/stores/app.tsx", import.meta.url).pathname;

let out: string;

beforeAll(() => {
  for (const dir of ["dom", "core"]) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: PACKAGES + dir, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`building ${dir} failed:\n${r.stderr.toString()}`);
  }
  // Named as coverage expects the bundles plugin tests build (bunfig.toml).
  out = mkdtempSync(join(tmpdir(), "reactre-plugin-stores-"));
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

type State = { count: number; title: string; todos: Todo[] };

const builds = {
  vite: async (dir: string) => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin()],
      build: {
        outDir: dir,
        emptyOutDir: true,
        minify: false,
        lib: { entry: APP, formats: ["es"], fileName: () => "main.js" },
      },
    });
  },
  esbuild: async (dir: string) => {
    await esbuild({
      entryPoints: [APP],
      outfile: join(dir, "main.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
      plugins: [esbuildPlugin()],
    });
  },
};

describe("a store in one module, read in others", () => {
  for (const [name, build] of Object.entries(builds))
    test(
      name,
      async () => {
        const dir = join(out, name);
        await build(dir);
        // Label's and Item's holes are bound: their one caller passes a store's member and item.
        const code = readFileSync(join(dir, "main.js"), "utf8");
        expect(code).toMatch(/\(\) => \(?props\.text\)?\)/);
        expect(code).toMatch(/\(\) => \(?props\.todo\.title\)?\)/);
        installFakeDocument();
        const root = new FakeElement("DIV");
        const app = (await import(join(dir, "main.js"))) as { mount(el: unknown): StoreSetter<State> };
        const set = app.mount(root);
        const lis = () => ((root.firstChild as FakeElement).lastChild as FakeElement).childNodes as FakeElement[];
        expect(root.textContent).toBe("0a");
        set((s) => {
          s.count = 1;
          s.title = "b";
          s.todos.push({ id: 1, title: "x", done: false }, { id: 2, title: "y", done: false });
        });
        expect(root.textContent).toBe("1bxy");
        const first = lis()[0]!;
        set((s) => {
          s.todos[0]!.title = "X";
          s.todos[0]!.done = true;
          s.todos.splice(1, 1);
        });
        expect(root.textContent).toBe("1bX");
        expect([lis()[0], first.getAttribute("class")]).toEqual([first, "done"]);
      },
      60_000,
    );
});
