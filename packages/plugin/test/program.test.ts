// Tests of how the plugin reads a core-mode build's program (src/program.ts), with stand-ins for
// each bundler's hook context: which builds read it (one-shot ones), which do not (a dev server,
// watch mode, entries it cannot know), and how each bundler's resolver answers. The real
// bundlers build a program of several modules in bundlers.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reactre } from "../src/index.ts";
import { readBuild } from "../src/program.ts";

// Its real path, as Bun's resolver gives it (macOS's temp folder is behind a symlink).
const dir = realpathSync(mkdtempSync(join(tmpdir(), "reactre-plugin-program-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const entry = join(dir, "main.tsx");
writeFileSync(entry, `import { L } from "./l.tsx"; export const A = () => <L t="x" />;`);
writeFileSync(join(dir, "l.tsx"), `export function L(props) { return <b>{props.t}</b>; }`);

/** A Rollup-style context whose resolver places relative specifiers in the directory. */
const rollupLike = (watchMode = false) => ({
  meta: { watchMode },
  resolve: async (spec: string, importer?: string, options?: { isEntry?: boolean }) =>
    spec === "ext"
      ? { id: "ext", external: true }
      : spec === "gone"
        ? null
        : { id: options?.isEntry === true || importer === undefined ? spec : join(dir, spec) },
});

describe("readBuild", () => {
  test("Rollup, Rolldown and Vite: a one-shot build, resolved by the plugin context", async () => {
    const b = (await readBuild(rollupLike(), { input: [entry] }, false))!;
    expect(b.entries).toEqual([entry]);
    expect(await b.host.resolve("./l.tsx", entry)).toBe(join(dir, "l.tsx"));
    expect(await b.host.resolve("ext", entry)).toBe(false);
    expect(await b.host.resolve("gone", entry)).toBe(false);
    expect(b.host.transpile("a.tsx", "export const a = <b />;")).toContain("jsx_reactre0(");
    expect((await readBuild(rollupLike(), { input: entry }, false))!.entries).toEqual([entry]);
    expect((await readBuild(rollupLike(), { input: { main: entry } }, false))!.entries).toEqual([entry]);
    expect((await readBuild(rollupLike(), undefined, false))!.entries).toEqual([]);
  });

  test("not a dev server, watch mode, or entries the resolver cannot place", async () => {
    expect(await readBuild(rollupLike(), { input: [entry] }, true)).toBeNull();
    expect(await readBuild(rollupLike(true), { input: [entry] }, false)).toBeNull();
    expect(await readBuild(rollupLike(), { input: ["gone"] }, false)).toBeNull();
  });

  test("esbuild: the entry points, resolved by build.resolve", async () => {
    const build = {
      initialOptions: { entryPoints: ["main.tsx", { in: "l.tsx" }], absWorkingDir: dir },
      resolve: async (path: string) => ({
        errors: path === "bad" ? [{}] : [],
        external: path === "ext",
        namespace: path === "virtual" ? "virtual" : "file",
        path: join(dir, path),
      }),
    };
    const ctx = (b: unknown) => ({ getNativeBuildContext: () => ({ framework: "esbuild", build: b }) });
    const b = (await readBuild(ctx(build), undefined, false))!;
    expect(b.entries).toEqual([entry, join(dir, "l.tsx")]);
    expect(await b.host.resolve("l.tsx", entry)).toBe(join(dir, "l.tsx"));
    expect(await b.host.resolve("bad", entry)).toBe(false);
    expect(await b.host.resolve("ext", entry)).toBe(false);
    expect(await b.host.resolve("virtual", entry)).toBeNull();
    const named = { ...build, initialOptions: { entryPoints: { main: "main.tsx" } } };
    expect((await readBuild(ctx(named), undefined, false))!.entries).toEqual([join(process.cwd(), "main.tsx")]);
    expect((await readBuild(ctx({ ...build, initialOptions: {} }), undefined, false))!.entries).toEqual([]);
  });

  test("webpack and Rspack: the static entries, resolved by the compilation's resolver", async () => {
    const compiler = (entry: unknown, watchMode = false) => ({
      watchMode,
      options: { entry, context: dir } as { entry: unknown; context?: string },
      resolverFactory: {
        get: () => ({
          resolve: (_: object, from: string, req: string, __: object, cb: (e: unknown, r?: string | false) => void) =>
            req === "bad" ? cb(new Error("no")) : req === "none" ? cb(null, false) : cb(null, join(from, req)),
        }),
      },
    });
    const ctx = (c: unknown, framework = "webpack") => ({ getNativeBuildContext: () => ({ framework, compiler: c }) });
    const b = (await readBuild(ctx(compiler({ main: { import: ["./main.tsx"] }, other: {} })), undefined, false))!;
    expect(b.entries).toEqual([entry]);
    expect(await b.host.resolve("bad", entry)).toBeNull();
    expect(await b.host.resolve("none", entry)).toBeNull();
    const noContext = { ...compiler(null), options: { entry: { main: { import: ["./main.tsx"] } } } };
    const rspack = await readBuild(ctx(noContext, "rspack"), 0, false);
    expect(rspack!.entries).toEqual([join(process.cwd(), "main.tsx")]);
    expect(await readBuild(ctx(compiler({ main: { import: ["./main.tsx"] } }, true)), undefined, false)).toBeNull();
    expect(await readBuild(ctx(compiler(() => ({}))), undefined, false)).toBeNull();
    expect(await readBuild(ctx(compiler(null)), undefined, false)).toBeNull();
    expect(await readBuild(ctx(compiler({ main: { import: ["bad"] } })), undefined, false)).toBeNull();
  });

  test("Bun: Bun.build's entrypoints, resolved by Bun", async () => {
    const ctx = (config: unknown) => ({ getNativeBuildContext: () => ({ framework: "bun", build: { config } }) });
    const b = (await readBuild(ctx({ entrypoints: [entry] }), undefined, false))!;
    expect(b.entries).toEqual([entry]);
    expect(await b.host.resolve("./l.tsx", entry)).toBe(join(dir, "l.tsx"));
    expect(await b.host.resolve("no-such-package", entry)).toBe(false);
    expect(await readBuild(ctx({}), undefined, false)).toBeNull();
  });

  test("anything else is seen file by file", async () => {
    expect(await readBuild(undefined, undefined, false)).toBeNull();
    expect(await readBuild({ getNativeBuildContext: () => ({ framework: "farm" }) }, undefined, false)).toBeNull();
  });
});

describe("the plugin's hooks", () => {
  type Raw = {
    buildStart?: (this: unknown, input: unknown) => Promise<void>;
    // Synchronous without a program, a promise with one.
    transform: { handler: (this: unknown, code: string, id: string) => { code: string } | Promise<{ code: string }> };
    vite: { configResolved(c: { command: string }): void };
  };
  /**
   * The plugin's raw options for Vite (its hooks as unplugin gives them); with the whole program,
   * `joiner` is the plugin that joins the modules it does not compile.
   */
  const raw = (options = {}): Raw & { joiner?: { transform: Raw["transform"] } } => {
    const r = reactre.raw(options, { framework: "vite" } as never) as unknown as Raw | [Raw, Raw];
    return Array.isArray(r) ? { ...r[0], joiner: r[1] } : r;
  };

  test("a one-shot build compiles each module with the program's facts; with wholeProgram off, each alone", async () => {
    const source = await Bun.file(join(dir, "l.tsx")).text();
    const p = raw();
    p.vite.configResolved({ command: "build" });
    await p.buildStart!.call(rollupLike(), { input: [entry] });
    expect((await p.transform.handler.call({}, source, join(dir, "l.tsx"))).code).toContain("clone([(props.t)])");
    const alone = raw({ wholeProgram: false });
    expect(alone.buildStart).toBeUndefined();
    expect((await alone.transform.handler.call({}, source, join(dir, "l.tsx"))).code).toContain("() => (props.t)");
  });

  test("a module that breaks the facts compiled already fails the build, naming it once", async () => {
    const p = raw();
    p.vite.configResolved({ command: "build" });
    await p.buildStart!.call(rollupLike(), { input: [entry] });
    await p.transform.handler.call({}, await Bun.file(join(dir, "l.tsx")).text(), join(dir, "l.tsx"));
    const late = join(dir, "late.tsx");
    const err = await Promise.resolve(
      p.transform.handler.call({}, `import { L } from "./l.tsx"; export const B = () => <L t={n()} />;`, late),
    ).catch((e: unknown) => e as Error);
    expect((err as Error).message.split(late).length).toBe(2);
    // A module the plugin does not compile joins too: one that calls L by hand uses it as a value.
    const byHand = join(dir, "hand.js");
    const joined = await Promise.resolve(
      p.joiner!.transform.handler.call({}, `import { L } from "./l.tsx"; L({ get t() { return n(); } });`, byHand),
    ).catch((e: unknown) => e as Error);
    expect((joined as Error).message).toContain(`${byHand} was not in the program read before the build`);
    expect((joined as Error).message).toContain("passes (every prop) reactively to L");
    // Styles, and what the plugin compiles, are not its to join; nor is anything without a program.
    expect(await p.joiner!.transform.handler.call({}, "a {}", join(dir, "a.css"))).toBeNull();
    expect(await p.joiner!.transform.handler.call({}, "", join(dir, "l.tsx"))).toBeNull();
    const dev = raw();
    dev.vite.configResolved({ command: "serve" });
    await dev.buildStart!.call(rollupLike(), { input: [entry] });
    expect(await dev.joiner!.transform.handler.call({}, "export {};", byHand)).toBeNull();
    expect(raw({ wholeProgram: false }).joiner).toBeUndefined();
    // A compile error of its own gets the path in front.
    const bad = raw({ wholeProgram: false }).transform.handler;
    expect(() => bad.call({}, `export const x = <input>x</input>;`, join(dir, "bad.tsx"))).toThrow(
      `${join(dir, "bad.tsx")}: reactre: <input> takes no children`,
    );
  });
});
