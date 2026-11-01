// An app whose store is in one module (fixtures/stores/state.ts) and is read in others. A
// production build reads the whole program, which tells the compiler that the import is a store;
// Vite's dev server compiles each file alone, where an import from outside @reactre may be a store
// and is taken for one. Either way a hole that reads its member is bound, a prop passed one is a
// getter that the component's hole follows, and a <For> over its array follows pushes, removals
// and its items' in-place writes: the dev server and the builds render the same updates. Each
// runs on the fake DOM.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoreSetter } from "@reactre/core/features/store";
import { FakeElement, installFakeDocument } from "@reactre/testdom";
import { build as esbuild } from "esbuild";
import { build as vite, createServer } from "vite";

import type { Todo } from "../fixtures/stores/state.ts";
import esbuildPlugin from "../src/esbuild.ts";
import vitePlugin from "../src/vite.ts";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const FIXTURE = new URL("../fixtures/stores/", import.meta.url).pathname;
const APP = FIXTURE + "app.tsx";

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
type App = { mount(el: unknown): StoreSetter<State> };

const builds = {
  vite: async (dir: string, entry = APP) => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin()],
      build: {
        outDir: dir,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: () => "main.js" },
      },
    });
  },
  esbuild: async (dir: string, entry = APP) => {
    await esbuild({
      entryPoints: [entry],
      outfile: join(dir, "main.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
      plugins: [esbuildPlugin()],
    });
  },
};

/** Mount the app, write to its store, and say what showed each time: the text, then each row's class. */
function drive(app: App): string[] {
  installFakeDocument();
  const root = new FakeElement("DIV");
  const set = app.mount(root);
  const lis = () => ((root.firstChild as FakeElement).lastChild as FakeElement).childNodes as FakeElement[];
  const seen = () => [root.textContent ?? "", ...lis().map((li) => li.getAttribute("class") ?? "")].join(" ");
  const shown = [seen()];
  set((s) => {
    s.count = 1;
    s.title = "b";
    s.todos.push({ id: 1, title: "x", done: false }, { id: 2, title: "y", done: false });
  });
  shown.push(seen());
  const first = lis()[0]!;
  set((s) => {
    s.todos[0]!.title = "X";
    s.todos[0]!.done = true;
    s.todos.splice(1, 1);
  });
  shown.push(seen());
  // The row was kept, and changed in place.
  expect(lis()[0]).toBe(first);
  return shown;
}

/** What each step shows when every read follows the store. */
const UPDATES = ["0a", "1bxy open open", "1bX done"];

describe("a store in one module, read in others", () => {
  for (const [name, build] of Object.entries(builds))
    test(`${name} build`, async () => {
      const dir = join(out, name);
      await build(dir);
      // Label's and Item's holes are bound: their one caller passes a store's member and item.
      const code = readFileSync(join(dir, "main.js"), "utf8");
      expect(code).toMatch(/\(\) => \(?props\.text\)?\)/);
      expect(code).toMatch(/\(\) => \(?props\.todo\.title\)?\)/);
      expect(drive((await import(join(dir, "main.js"))) as App)).toEqual(UPDATES);
    }, 60_000);

  test("vite's dev server, each file alone, renders the same updates as vite build", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: FIXTURE,
      plugins: [vitePlugin()],
      appType: "custom",
      server: { middlewareMode: true, ws: false },
    });
    let dev: string[], app: string;
    try {
      dev = drive((await server.ssrLoadModule("/app.tsx")) as App);
      app = (await server.transformRequest("/app.tsx"))!.code;
    } finally {
      await server.close();
    }
    // Seen alone, the import of ./state.ts may be a store: its reads are bound, its array copied.
    expect(app).toMatch(/\(\) => \(?store\.count\)?\)/);
    expect(app).toContain("[...store.todos]");
    const dir = join(out, "vite-dev-pair");
    await builds.vite(dir);
    expect(dev).toEqual(drive((await import(join(dir, "main.js"))) as App));
    expect(dev).toEqual(UPDATES);
  }, 60_000);
});

// fixtures/stores/aliases.tsx reads the same store through what is made of it: locals, exports of
// ./state.ts, a box, a function's result, a keyed <Show>'s value, a tuple kept whole, a prop.

const ALIASES = FIXTURE + "aliases.tsx";

type Aliases = {
  mount(el: unknown): { setStore: StoreSetter<State>; setTuple: StoreSetter<{ n: number }> };
};

/** Mount aliases.tsx, write to its stores, and say what each of its parts showed each time. */
function driveAliases(app: Aliases): string[][] {
  installFakeDocument();
  const root = new FakeElement("DIV");
  const { setStore, setTuple } = app.mount(root);
  const seen = () =>
    ((root.firstChild as FakeElement).childNodes as FakeElement[])
      .filter((n) => n.tagName)
      .map((n) => n.textContent ?? "");
  const shown = [seen()];
  setStore((s) => {
    s.count = 1;
    s.todos.push({ id: 1, title: "x", done: false }, { id: 2, title: "y", done: false });
  });
  setTuple((t) => {
    t.n = 1;
  });
  shown.push(seen());
  setStore((s) => {
    s.todos[0]!.title = "X";
    s.todos[0]!.done = true;
    s.todos.splice(1, 1);
  });
  shown.push(seen());
  return shown;
}

/** What each part of aliases.tsx shows at each step when every read follows the store. */
const ALIAS_UPDATES = [
  ["0", "0", "", "", "", "0", "0"],
  ["2", "1", "xy", "--", "x", "1", "2xy"],
  ["1", "1", "X", "+", "X", "1", "1X"],
];

describe("a store read through what is made of it, in one module and in others", () => {
  for (const [name, build] of Object.entries(builds))
    test(`${name} build`, async () => {
      const dir = join(out, "aliases-" + name);
      await build(dir, ALIASES);
      expect(driveAliases((await import(join(dir, "main.js"))) as Aliases)).toEqual(ALIAS_UPDATES);
    }, 60_000);

  test("vite's dev server, each file alone, renders the same updates as vite build", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: FIXTURE,
      plugins: [vitePlugin()],
      appType: "custom",
      server: { middlewareMode: true, ws: false },
    });
    let dev: string[][];
    try {
      dev = driveAliases((await server.ssrLoadModule("/aliases.tsx")) as Aliases);
    } finally {
      await server.close();
    }
    expect(dev).toEqual(ALIAS_UPDATES);
  }, 60_000);
});
