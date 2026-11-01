// Tests of @reactre/compiler's server mode (`{ server: true }`): what it writes for each construct,
// its imports, its compile errors (the client's), and the Bun plugin's `server` option. What the
// code renders is tested with @reactre/core/server in packages/core/test/server.test.ts, against
// the client's DOM, and through real builds in packages/plugin/test/ssr.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileJs,
  compileJsWithMap,
  compileSource,
  ReactreCompileError,
  reactreCompiler,
  serverImports,
  transpileSource,
} from "../src/index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** `src` compiled for the server. */
const server = (src: string): string => compileSource(src, "tsx", { server: true });
/** A source with `import { names } from "@reactre/core"` before `body`. */
const withImport = (names: string, body: string) => `import { ${names} } from "@reactre/core";\n${body}`;

const fails = (src: string, message: RegExp) => {
  expect(() => server(src)).toThrow(ReactreCompileError);
  expect(() => server(src)).toThrow(message);
};

// #region Imports

describe("imports", () => {
  test("the app's imports of @reactre/core, features/async and features/dynamic point at the server", () => {
    const out = serverImports(
      [
        `import { signal } from "@reactre/core";`,
        `import * as R from '@reactre/core';`,
        `import { Loading } from "@reactre/core/features/async";`,
        `import { dynamic } from "@reactre/core/features/dynamic";`,
        `import { createStore } from "@reactre/core/features/store";`,
        `export { batch } from "@reactre/core";`,
        `import "@reactre/core";`,
        `const lazy = import("@reactre/core/features/async");`,
        `import { x } from "@reactre/coreish";`,
      ].join("\n"),
    );
    expect(out).toBe(
      [
        `import { signal } from "@reactre/core/server";`,
        `import * as R from '@reactre/core/server';`,
        `import { Loading } from "@reactre/core/server/async";`,
        `import { dynamic } from "@reactre/core/server/dynamic";`,
        `import { createStore } from "@reactre/core/features/store";`,
        `export { batch } from "@reactre/core/server";`,
        `import "@reactre/core/server";`,
        `const lazy = import("@reactre/core/server/async");`,
        `import { x } from "@reactre/coreish";`,
      ].join("\n"),
    );
  });

  test("the app's effect does not run there, and its memo is the server's", () => {
    expect(serverImports(`import { effect, memo as m, signal } from "@reactre/core";`)).toBe(
      `import { signal } from "@reactre/core/server";import { __ssrEffect as effect, __ssrMemo as m } from "@reactre/core/server";`,
    );
    expect(serverImports(`import { effect as e } from "@reactre/core/features/errors";`)).toBe(
      `import "@reactre/core/server/errors";import { __ssrEffect as e } from "@reactre/core/server";`,
    );
    expect(serverImports(`import { Errored, effect, memo } from "@reactre/core/features/errors";`)).toBe(
      `import { Errored, memo } from "@reactre/core/server/errors";import { __ssrEffect as effect } from "@reactre/core/server";`,
    );
    // Nothing to rename: the module pointed at the server's, whose effect does not run either.
    expect(serverImports(`import { Errored } from "@reactre/core/features/errors";`)).toBe(
      `import { Errored } from "@reactre/core/server/errors";`,
    );
    // The feature modules whose effects do not run on the server, and a namespace or a re-export
    // of the core, whose `effect` is the server's.
    expect(serverImports(`import { reaction } from "@reactre/core/features/reaction";`)).toBe(
      `import { reaction } from "@reactre/core/server/reaction";`,
    );
    expect(serverImports(`import { flush, onSettled } from "@reactre/core/features/timing";`)).toBe(
      `import { flush, onSettled } from "@reactre/core/server/timing";`,
    );
    expect(
      serverImports(`import * as E from "@reactre/core/features/errors";export { effect } from "@reactre/core";`),
    ).toBe(`import * as E from "@reactre/core/server/errors";export { effect } from "@reactre/core/server";`);
    expect(serverImports(`import { a, } from "@reactre/core";`)).toBe(`import { a, } from "@reactre/core/server";`);
  });

  test("a feature module of the core's: only the core points at the server, but for its effect, the core's own", () => {
    expect(
      serverImports(
        `import { __frag, effect } from "@reactre/core";\nimport { __scope } from "@reactre/core/features/context";\nimport * as core from "@reactre/core";`,
        false,
      ),
    ).toBe(
      `import { __frag } from "@reactre/core/server";import { effect } from "@reactre/core";\nimport { __scope } from "@reactre/core/features/context";\nimport * as core from "@reactre/core/server";`,
    );
    expect(serverImports(`import { effect as e, signal, } from '@reactre/core';`, false)).toBe(
      `import { signal } from "@reactre/core/server";import { effect as e } from "@reactre/core";`,
    );
    expect(serverImports(`import { effect } from "@reactre/core";`, false)).toBe(
      `import { effect } from "@reactre/core";`,
    );
    expect(serverImports(`import { signal } from "@reactre/core";`, false)).toBe(
      `import { signal } from "@reactre/core/server";`,
    );
  });

  test("a file without JSX gets its imports pointed at the server and nothing else", () => {
    expect(compileJs(`import { effect } from "@reactre/core";\neffect(() => {});`, { server: true })).toBe(
      `import "@reactre/core/server";import { __ssrEffect as effect } from "@reactre/core/server";\neffect(() => {});`,
    );
  });

  test("the compiled file imports the server's helpers it uses", () => {
    const out = server(`export const A = () => <p class={c()}>{t()}</p>;`);
    expect(out.split("\n")[0]).toBe(
      `import { __ssr as __rrsH, __ssrText as __rrsT, __ssrClass as __rrsC, __ssrLazy as __rrsL } from "@reactre/core/server";`,
    );
  });
});

// #endregion

// #region What it writes

describe("what it writes", () => {
  test("an element tree without holes is one hoisted value; one with holes, its strings and holes", () => {
    const out = server(`export const A = () => <p class="a" title="x&y">Hi &amp; <b>there</b></p>;`);
    expect(out).toContain(
      `const __rrsM0 = __rrsH(["<p class=\\"a\\" title=\\"x&amp;y\\">Hi &amp; <b>there</b></p>"]);`,
    );
    expect(out).toContain("export const A = () => __rrsM0;");
    const holes = server(`export const A = () => <p id={x} data-n={n()}>{t}</p>;`);
    expect(holes).toContain(`const __rrsM0 = ["<p","",">","</p>"];`);
    expect(holes).toContain(
      `__rrsH(__rrsM0, __rrsA((x), "id"), __rrsL(() => __rrsA((n()), "data-n")), __rrsT((t), 0))`,
    );
  });

  test("handlers and refs are left out; literal attributes are written, null and false ones not", () => {
    const out = server(
      `export const A = () => <a href="/" onClick={go} ref={r} hidden download={false} rel={null} />;`,
    );
    expect(out).toContain(`__rrsH(["<a href=\\"/\\" hidden></a>"])`);
  });

  test("a text hole knows the text beside it, for the hydration markers", () => {
    const out = server(`export const A = () => <p>a {x} b{y}{z}<i /></p>;`);
    expect(out).toContain("__rrsT((x), 3), __rrsT((y), 1), __rrsT((z), 1)");
  });

  test("a fragment's children join the element; a keyed element whose key may change is a slot", () => {
    const out = server(`export const A = () => <p><>a<b /></><i key={k()} /><i key="k" /></p>;`);
    expect(out).toContain(`const __rrsM0 = __rrsH(["<i></i>"]);`);
    expect(out).toContain(`["<p>a<b></b>","<i></i></p>"]`);
    expect(out).toContain("__rrsS(__rrsM0)");
  });

  test("class lists: taken apart, toggled at runtime, or written whole through __class", () => {
    expect(server(`export const A = () => <p class={{ a: true, b: false }} />;`)).toContain(
      `["<p class=\\"a\\"></p>"]`,
    );
    expect(server(`export const A = () => <p class={{ b: false }} />;`)).toContain(`["<p></p>"]`);
    expect(server(`export const A = () => <p class={{ a: true, b: on }} />;`)).toContain(`__rrsK("a", [["b", (on)]])`);
    expect(server(`export const A = () => <p class={{ b: on() }} />;`)).toContain(
      `__rrsL(() => __rrsK("", [["b", (on())]]))`,
    );
    expect(server(`export const A = () => <p class={[x, "y"]} />;`)).toContain('__rrsC(__rrClass([x, "y"]))');
    expect(server(`export const A = () => <p class={[x()]} className="z" />;`)).toContain(
      `__rrsL(() => __rrsC(__rrClass([[x()], "z"])))`,
    );
  });

  test("lists, by key, by index, and over a range", () => {
    expect(
      server(`export const A = () => <ul><For each={rows()} key={(r) => r.id}>{(r) => <li>{r.t}</li>}</For></ul>;`),
    ).toContain("__rrsL(() => __rrsF(rows(), (r) => __rrsH(__rrsM0, __rrsT((r.t), 0)), undefined, false))");
    expect(
      server(
        `export const A = () => <ul><For each={rows} keyed={false} fallback="none">{(r) => <li>{r()}</li>}</For></ul>;`,
      ),
    ).toContain(`__rrsF(rows, (r) => __rrsH(__rrsM0, __rrsL(() => __rrsT((r()), 0))), () => ("none"), true)`);
    expect(
      server(`export const A = () => <ul><For each={rows} keyed={(r) => r}>{(r) => <li />}</For></ul>;`),
    ).toContain(", undefined, false)");
    expect(
      server(`export const A = () => <ul><For each={rows} keyed={false}>{(r, i) => <li>{i}</li>}</For></ul>;`),
    ).toContain("__rrsF(rows, (r, i) => __rrsH(__rrsM0, __rrsT((i), 0)), undefined, true)");
    expect(
      server(withImport("Repeat", `export const A = () => <ol><Repeat count={3}>{(i) => <li>{i}</li>}</Repeat></ol>;`)),
    ).toContain("__rrsR(3, undefined, (i) =>");
    expect(
      server(
        withImport(
          "Repeat",
          `export const A = () => <ol><Repeat count={3} from={start()}>{(i) => <li />}</Repeat></ol>;`,
        ),
      ),
    ).toContain("__rrsL(() => __rrsR(3, start(),");
  });

  test("control flow is evaluated once, as slots; <Portal> writes nothing", () => {
    const show = server(withImport("Show", `export const A = () => <div><Show when={a}>x</Show></div>;`));
    expect(show).toContain(`__rrsS(((__rrX0) => (__rrX0 ? "x" : null))(a))`);
    const portal = server(
      withImport("Portal", `export const A = () => <div><Portal mount={el}><p>x</p></Portal></div>;`),
    );
    expect(portal).toContain("__rrsS(null)");
    expect(portal).not.toContain("<p>x</p>");
    const tag = server(
      withImport("Dynamic", `export const A = () => <div><Dynamic component="h1" id="t">x</Dynamic></div>;`),
    );
    expect(tag).toContain(`<h1 id=\\"t\\">x</h1>`);
    const dyn = server(withImport("Dynamic", `export const A = () => <Dynamic component={C} {...p} n={1} />;`));
    expect(dyn).toContain(
      `__rrsS(((__rrD) => __rrUntrack(() => typeof __rrD === "function" ? __rrD(__rrProps(p, { n: 1 }))`,
    );
    const plain = server(withImport("Dynamic", `export const A = () => <Dynamic component={C} n={1} />;`));
    expect(plain).toContain(`__rrD({ "n": 1 })`);
  });

  test("a source map maps the code back to the module with its imports pointed at the server", () => {
    const js = transpileSource(`import { signal } from "@reactre/core";\nexport const A = () => <p>{n()}</p>;`);
    const { code, map } = compileJsWithMap(js, { server: true });
    expect(code).toBe(compileJs(js, { server: true }));
    expect(map).not.toBeNull();
    expect(compileJsWithMap(`const a = 1;`, { server: true })).toEqual({ code: `const a = 1;`, map: null });
    // The characters the map's marks use: no map.
    expect(compileJsWithMap(`const a = "";`, { server: true }).map).toBeNull();
  });
});

// #endregion

// #region Compile errors

describe("compile errors, as the client's", () => {
  test("lists", () => {
    fails(
      `export const A = () => <For each={[]} key={(r) => r}>{(r) => <li />}</For>;`,
      /<For> must be the child of an element/,
    );
    fails(
      `export const A = () => <ul><For each={[]}>{(r) => <li />}</For></ul>;`,
      /<For> needs each, key and a row function/,
    );
    fails(`export const A = () => <ul><For key={(r) => r}>{(r) => <li />}</For></ul>;`, /<For> needs each/);
    fails(`export const A = () => <ul><For each={[]} keyed={false} /></ul>;`, /<For> needs each/);
    fails(
      `export const A = () => <ul><For each={[]} key={(r) => r} keyed={false}>{(r) => <li />}</For></ul>;`,
      /<For> takes key or keyed, not both/,
    );
    fails(
      `export const A = () => <ul><For each={[]} keyed>{(r) => <li />}</For></ul>;`,
      /<For>'s keyed must be written as false/,
    );
    const repeat = (body: string) => withImport("Repeat", `export const A = () => <ul>${body}</ul>;`);
    fails(repeat(`<Repeat>{(i) => <li />}</Repeat>`), /<Repeat> takes count, from, fallback/);
    fails(repeat(`<Repeat count={1} each={[]}>{(i) => <li />}</Repeat>`), /, not each/);
    fails(repeat(`<Repeat count={1} key={k}>{(i) => <li />}</Repeat>`), /, not key/);
  });

  test("control flow and elements", () => {
    fails(
      withImport("Match", `export const A = () => <div><Match when={1}>x</Match></div>;`),
      /<Match> must be a child of <Switch>/,
    );
    fails(
      withImport("Switch", `export const A = () => <div><Switch><p /></Switch></div>;`),
      /<Switch> takes only <Match> children/,
    );
    fails(withImport("Dynamic", `export const A = () => <Dynamic component={C} key={k} />;`), /<Dynamic> takes no key/);
    fails(withImport("Dynamic", `export const A = () => <Dynamic n={1} />;`), /<Dynamic> needs component/);
    fails(
      withImport("Portal", `export const A = () => <div><Portal to={el} /></div>;`),
      /<Portal> takes mount, children, not to/,
    );
    fails(`export const A = () => <br>x</br>;`, /<br> takes no children/);
  });
});

describe("names the server writes", () => {
  /** A jsx call of `<div data-x="1" />` (or `<Dynamic>`'s), with `name` in place of data-x, compiled for the server. */
  const attr = (name: string): string =>
    compileJs(transpileSource(`export const A = () => <div data-x="1" />;`).replace(`"data-x"`, JSON.stringify(name)), {
      server: true,
    });
  /** The same, with `tag` in place of the div. */
  const tag = (tag: string): string =>
    compileJs(transpileSource(`export const A = () => <div />;`).replace(`"div"`, JSON.stringify(tag)), {
      server: true,
    });

  test("an attribute name that is not one HTML attribute name fails to compile", () => {
    for (const name of [
      `x><script>alert(1)</script`,
      "a b",
      `a"b`,
      "a'b",
      "a=b",
      "a/b",
      "a\tb",
      "a\u0000b",
      "a\u007fb",
      "",
    ])
      expect(() => attr(name)).toThrow(`is not a valid attribute name`);
    expect(() => attr("a b")).toThrow(ReactreCompileError);
    // Names an element takes: data, aria, namespaced, custom.
    for (const name of ["data-x", "aria-label", "xlink:href", "x.y", "_a", "é"])
      expect(attr(name)).toContain(` ${name}=\\"1\\"`);
  });

  test("a tag that is not one HTML element name fails to compile, written as one or as <Dynamic>'s", () => {
    for (const name of [`div x><script>alert(1)</script`, "div x", "1a", "-a", "a/b", "a>b", ""])
      expect(() => tag(name)).toThrow(`is not a valid tag name`);
    expect(() => server(withImport("Dynamic", `export const A = () => <Dynamic component="div x" />;`))).toThrow(
      `"div x" is not a valid tag name`,
    );
    expect(tag("my-widget")).toContain("<my-widget></my-widget>");
    expect(tag("foreignObject")).toContain("<foreignObject></foreignObject>");
  });
});

// #endregion

// #region The Bun plugin

describe("reactreCompiler({ server: true })", () => {
  const files: string[] = [];
  afterAll(() => files.forEach((f) => unlinkSync(f)));

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

  test("compiles for the server, and loads the core's feature modules with the server's core", async () => {
    const loads = hooks({ server: true });
    expect(loads.length).toBe(3);
    const [, feature, compile] = loads as [unknown, (typeof loads)[number], (typeof loads)[number]];
    const context = join(ROOT, "packages/core/src/features/context.ts");
    expect(feature.filter.test(context)).toBe(true);
    const out = (await feature.cb({ path: context })) as { contents: string; loader: string };
    expect(out.loader).toBe("ts");
    expect(out.contents).toContain(`from "@reactre/core/server"`);
    expect(out.contents).not.toMatch(/from "@reactre\/core";/);
    expect(await feature.cb({ path: "/elsewhere/core/src/features/context.ts" })).toBeUndefined();
    const path = join(tmpdir(), `reactre-compiler-server-${process.pid}.tsx`);
    await Bun.write(path, `export const A = () => <p>{n()}</p>;`);
    files.push(path);
    expect(((await compile.cb({ path })) as { contents: string }).contents).toContain("__rrsH(");
    expect(hooks({}).length).toBe(2);
  });
});

// #endregion
