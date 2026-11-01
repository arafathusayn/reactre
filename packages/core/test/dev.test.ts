// The development build: the diagnostics in index.ts's `// #if DEV` blocks, which the sources
// hold (so `bun test` runs them here, on the unbundled runtime), and which the production builds
// strip. Then which build each bundle gets: a production bundle has none of the DEV code, a
// development bundle warns; @reactre/compiler's `coreRuntime` picks the build for a dev server
// and a production one; the package's own build writes the three; and the stripper's rules.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileSource, reactreCompiler } from "@reactre/compiler";
import { coreRuntime } from "@reactre/compiler/program";
import { FakeElement, installFakeDocument } from "@reactre/testdom";
import type { BunPlugin } from "bun";

import * as runtime from "../src/index.ts";
import { ASYNC_PRODUCTION, PRODUCTION, strip, stripDev, without } from "../src/withoutAsync.ts";

let warns: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  installFakeDocument();
  warns = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warns.mockRestore());

/** The codes warned about so far. */
const codes = (): string[] => warns.mock.calls.map((c) => /^reactre (\w+):/.exec(String(c[0]))![1]!);

/**
 * Compile a TSX test source (a module body ending in `return { ... }`) and run it with the
 * unbundled runtime, `root` in scope.
 */
function run<T>(src: string, root: FakeElement = new FakeElement("DIV")): T {
  const js = compileSource(src).replace(/^import \{([^}]*)\} from "@reactre\/core";$/gm, (_, names: string) =>
    names
      .split(",")
      .map((n) => {
        const [a, b] = n.trim().split(" as ");
        return `const ${b ?? a} = rr.${a};`;
      })
      .join("\n"),
  );
  return new Function("rr", "root", js)(runtime, root) as T;
}

describe("diagnostics", () => {
  test("REACTIVE_WRITE_IN_OWNED_SCOPE: a write in a memo, a hole or a row's hole; once per signal", () => {
    const { signal, memo } = runtime;
    const [a] = signal(1);
    const [, setB] = signal(0);
    const m = memo(() => (setB(1), a()));
    expect(m()).toBe(1);
    expect(codes()).toEqual(["REACTIVE_WRITE_IN_OWNED_SCOPE"]);
    const api = run<{ setA: (n: number) => void }>(`
      import { For, render, signal } from "@reactre/core";
      const [a, setA] = signal(1);
      const [, setC] = signal(0);
      const [, setD] = signal(0);
      render(() => <div><p>{(setC(a()), a())}</p><ul><For each={[1]} key={(r) => r}>{(r) => <li>{(setD(a()), r + a())}</li>}</For></ul></div>, root);
      return { setA };
    `);
    expect(codes()).toEqual(Array(3).fill("REACTIVE_WRITE_IN_OWNED_SCOPE"));
    // Once per signal: the holes run again, and write the same signals again.
    api.setA(2);
    expect(warns).toHaveBeenCalledTimes(3);
    expect(String(warns.mock.calls[0]![0])).toContain("Fix: compute the value without writing");
  });

  test("no warning for a write in an effect or a handler, a <For>'s fallback, or a memo made in a hole", () => {
    const { effect, signal } = runtime;
    const [a, setA] = signal(1);
    const [, setB] = signal(0);
    effect(() => setB(a()));
    setA(2);
    run(`
      import { For, memo, render, signal } from "@reactre/core";
      const [xs, setXs] = signal([]);
      render(() => (
        <div>
          <ul><For each={xs()} key={(x) => x} fallback={<li>none</li>}>{(x) => <li>{x}</li>}</For></ul>
          <p>{memo(() => xs().length)()}</p>
        </div>
      ), root);
      setXs([1, 2]);
      return {};
    `);
    expect(warns).not.toHaveBeenCalled();
  });

  test("FOR_DUPLICATE_KEY and FOR_UNSTABLE_KEY: two items of one key; an item whose key changed", () => {
    const api = run<{ set: (v: { id: number }[]) => void; a: { id: number }; b: { id: number } }>(`
      import { For, render, signal } from "@reactre/core";
      const a = { id: 1 }, b = { id: 2 };
      const [rows, set] = signal([a, b]);
      let n = 0;
      render(() => (
        <div>
          <ul><For each={rows()} key={(r) => r.id}>{(r) => <li>{r.id}</li>}</For></ul>
          <ol><For each={rows()} key={(r) => r.id * 10 + n++}>{(r) => <li>{r.id}</li>}</For></ol>
        </div>
      ), root);
      return { set, a, b };
    `);
    expect(warns).not.toHaveBeenCalled();
    api.set([api.a, { id: 1 }]);
    expect(codes()).toEqual(["FOR_DUPLICATE_KEY", "FOR_UNSTABLE_KEY"]);
    expect(String(warns.mock.calls[0]![0])).toContain("the key 1");
  });

  test("ATTRIBUTE_HANDLER: a function in a lowercase on* spread prop, which becomes an attribute's text", () => {
    run(`
      import { render } from "@reactre/core";
      const h = () => {};
      const props = { onclick: h, title: "t" };
      render(() => <div><a {...props} /></div>, root);
      return {};
    `);
    expect(codes()).toEqual(["ATTRIBUTE_HANDLER"]);
    expect(String(warns.mock.calls[0]![0])).toContain("(onClick)");
    // A spread handler in camelCase, and an element's own onclick (set as its property, which
    // listens), are as they should be; beside a spread, an element's props go with it.
    warns.mockClear();
    run(`
      import { render } from "@reactre/core";
      const h = () => {};
      const props = { onClick: h, onmouseover: "x" };
      render(() => <div><button onclick={h}>a</button><a {...props} /><i onclick={h} {...props} /></div>, root);
      return {};
    `);
    expect(codes()).toEqual(["ATTRIBUTE_HANDLER"]);
  });

  test("FUNCTION_AS_TEXT: a function in a text hole, written once or bound, or in a slot", () => {
    const api = run<{ set: (f: unknown) => void }>(`
      import { render, signal } from "@reactre/core";
      const count = () => 1;
      const [f, set] = signal("text");
      render(() => <div><p>{count}</p></div>, root);
      render(() => <div><b>{f()}</b></div>, root);
      render(() => <div>{f() === 1 ? <i /> : count}</div>, root);
      return { set };
    `);
    expect(codes()).toEqual(["FUNCTION_AS_TEXT", "FUNCTION_AS_TEXT"]);
    api.set(() => () => 2);
    expect(codes()).toEqual(Array(3).fill("FUNCTION_AS_TEXT"));
    expect(String(warns.mock.calls[0]![0])).toContain("{count()}, not {count}");
  });

  test("FOR_ROW_LOOP: a row's hole that writes what it reads throws, as an effect that never settles does", () => {
    expect(() =>
      run(`
        import { For, render, signal } from "@reactre/core";
        const [n, setN] = signal(0);
        render(() => <ul><For each={[1]} key={(r) => r}>{(r) => <li>{(setN(n() + 1), n())}</li>}</For></ul>, root);
        return {};
      `),
    ).toThrow("reactre FOR_ROW_LOOP");
  });
});

// #region Bundles

const scratch = Bun.fileURLToPath(new URL("../.cache/dev", import.meta.url));

/** Loads @reactre/core's index.ts as it is: the development build. */
const asIs: BunPlugin = {
  name: "core-as-is",
  setup(b) {
    b.onLoad({ filter: /[\\/]core[\\/]src[\\/]index\.ts$/ }, async (a) => ({
      contents: await Bun.file(a.path).text(),
      loader: "ts",
    }));
  },
};

/** Bundle `src` unminified with the compiler's Bun plugin, which strips the core for production, or with the core as it is. */
async function bundle(name: string, src: string, dev: boolean): Promise<string> {
  const entry = `${scratch}/${name}.tsx`;
  await Bun.write(entry, src);
  const r = await Bun.build({
    entrypoints: [entry],
    format: "iife",
    target: "browser",
    conditions: ["reactre-source"],
    plugins: dev ? [asIs, reactreCompiler()] : [reactreCompiler()],
  });
  if (!r.success) throw new Error(r.logs.join("\n"));
  return r.outputs[0]!.text();
}

/** An app that makes three mistakes the diagnostics find. */
const mistakes = `
  import { For, render, signal } from "@reactre/core";
  const h = () => {};
  const props = { onclick: h };
  const [rows] = signal([1, 1]);
  render(() => <div><a {...props} /><ul><For each={rows()} key={(r) => r}>{(r) => <li>{r}</li>}</For></ul><p>{h}</p></div>, root);
`;

/** Names only the DEV blocks define or say. */
const DEV_CODE = ["REACTIVE_WRITE_IN_OWNED_SCOPE", "FOR_ROW_LOOP", "function checkKeys", "function checked", "warned"];

describe("bundles", () => {
  test("a production bundle has none of the development code, and says nothing", async () => {
    const code = await bundle("mistakes", mistakes, false);
    for (const s of DEV_CODE) expect(code).not.toContain(s);
    (globalThis as { root?: unknown }).root = new FakeElement("DIV");
    new Function(code)();
    expect(warns).not.toHaveBeenCalled();
  });

  test("a development bundle warns about each mistake", async () => {
    const code = await bundle("mistakes", mistakes, true);
    for (const s of DEV_CODE) expect(code).toContain(s);
    (globalThis as { root?: unknown }).root = new FakeElement("DIV");
    new Function(code)();
    expect(codes().sort()).toEqual(["ATTRIBUTE_HANDLER", "FOR_DUPLICATE_KEY", "FUNCTION_AS_TEXT"]);
  });
});

// #endregion

// #region Builds

describe("coreRuntime: the development build for a dev server, a production one elsewhere", () => {
  const core = new URL("../", import.meta.url).pathname;
  const dist = (p: string) => join(core, "dist", p);
  const src = join(core, "src/index.ts");
  const read = () => Bun.file(src).text();

  test("the dist builds: each becomes the one the build gets", async () => {
    // A production build (a Bun.build): the development build becomes the default or async one.
    expect(await coreRuntime(dist("dev/index.js"), read, false, false)).toBe('export * from "../index.js";\n');
    expect(await coreRuntime(dist("dev/index.js"), read, true, false, false)).toBe(
      'export * from "../async/index.js";\n',
    );
    // A dev server: every build becomes the development one.
    expect(await coreRuntime(dist("index.js"), read, false, false, true)).toBe('export * from "./dev/index.js";\n');
    expect(await coreRuntime(dist("async/index.js"), read, true, false, true)).toBe(
      'export * from "../dev/index.js";\n',
    );
    expect(await coreRuntime(dist("dev/index.js"), read, true, false, true)).toBeNull();
    // The others, as before.
    expect(await coreRuntime(dist("async/index.js"), read, false, false)).toBe('export * from "../index.js";\n');
    expect(await coreRuntime(dist("index.js"), read, true, false)).toBe('export * from "./async/index.js";\n');
  });

  test("the sources: as they are for a dev server; stripped of the development code elsewhere", async () => {
    expect(await coreRuntime(src, read, true, false, true)).toBeNull();
    for (const on of [true, false]) {
      const code = (await coreRuntime(src, read, on, false))!;
      expect(code).toBe(strip(await read(), on ? ASYNC_PRODUCTION : PRODUCTION));
      expect(code).not.toContain("FOR_ROW_LOOP");
      expect(code.includes("drainAsync")).toBe(on);
    }
  });

  test("features/memo: its source stripped of its types, as it is for a dev server", async () => {
    const memo = join(core, "src/features/memo.ts");
    const readMemo = () => Bun.file(memo).text();
    // A dev server: the source as it is.
    expect(await coreRuntime(memo, readMemo, true, false, true)).toBeNull();
    // A production build: as features/memo was before its types were added.
    const code = (await coreRuntime(memo, readMemo, false, false))!;
    expect(code).toBe(strip(await readMemo(), ["DEV", "TYPES"]));
    expect(code).not.toContain("readonly unobserved");
    expect(code).not.toContain("readonly lazy");
    expect(code).toContain("export function memo<T>(fn: (prev: T | undefined) => T, options?: SignalOptions<T>)");
  });

  test("a core whose stripper knows only async blocks: stripped of those, else as it is", async () => {
    const at = mkdtempSync(join(tmpdir(), "reactre-core-old-stripper-"));
    try {
      mkdirSync(join(at, "src"));
      writeFileSync(join(at, "package.json"), '{ "name": "@reactre/core" }');
      writeFileSync(join(at, "src/withoutAsync.ts"), "export const stripAsync = (s: string) => s.toUpperCase();\n");
      const index = join(at, "src/index.ts");
      expect(await coreRuntime(index, () => "a", false, false)).toBe("A");
      expect(await coreRuntime(index, () => "a", true, false)).toBeNull();
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("the package's build", () => {
  test("writes dist without the development code, dist/async without it, and dist/dev with it", () => {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL("../", import.meta.url).pathname, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    const text = (p: string) => require("node:fs").readFileSync(new URL(`../dist/${p}`, import.meta.url), "utf8");
    const [prod, async, dev] = ["index.js", "async/index.js", "dev/index.js"].map(text) as [string, string, string];
    for (const s of ["REACTIVE_WRITE_IN_OWNED_SCOPE", "FOR_ROW_LOOP", "function checkKeys"]) {
      expect(prod).not.toContain(s);
      expect(async).not.toContain(s);
      expect(dev).toContain(s);
    }
    expect(prod).not.toContain("drainAsync");
    expect(async).toContain("drainAsync");
    expect(dev).toContain("drainAsync");
  }, 30_000);
});

// #endregion

// #region The stripper

describe("strip", () => {
  const src = [
    "a();",
    "// #if ASYNC",
    "on();",
    "  // #if DEV",
    "  check();",
    "  // #else",
    "  // plain();",
    "  // #endif",
    "// #else",
    "// off();",
    "// #endif",
    "// #if DEV",
    "dev();",
    "// #endif",
    "b();",
  ].join("\n");

  test("drops the blocks it is given, keeping their #else parts; a block inside another goes with it", () => {
    expect(strip(src, PRODUCTION)).toBe(["a();", "off();", "b();"].join("\n"));
    expect(strip(src, ["DEV"])).toBe(
      ["a();", "// #if ASYNC", "on();", "  plain();", "// #else", "// off();", "// #endif", "b();"].join("\n"),
    );
    expect(stripDev(src)).toBe(strip(src, ["DEV"]));
    expect(strip(src, [])).toBe(src);
    expect(strip(src, ["ASYNC"])).toBe(["a();", "off();", "// #if DEV", "dev();", "// #endif", "b();"].join("\n"));
  });

  test("a block in an #else part, or inside one of its own name, is stray", () => {
    expect(() => strip("// #if ASYNC\n// #else\n// #if DEV\n// #endif\n// #endif", [])).toThrow('a stray "// #if DEV"');
    expect(() => strip("// #if DEV\n// #if DEV", [])).toThrow('a stray "// #if DEV"');
    expect(() => strip("// #if DEV\n// #else\n// #else", ["DEV"])).toThrow('a stray "// #else"');
    expect(() => strip("// #if DEV\n// #if ASYNC\n", ["DEV"])).toThrow('a "// #if DEV" without');
  });

  test("without(...) is a Bun plugin that loads index.ts stripped", async () => {
    const r = await Bun.build({
      entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
      target: "browser",
      packages: "external",
      plugins: [without(...PRODUCTION)],
    });
    expect(await r.outputs[0]!.text()).not.toContain("FOR_ROW_LOOP");
  });
});

// #endregion
