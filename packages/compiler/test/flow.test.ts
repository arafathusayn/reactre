// Tests of how @reactre/compiler compiles control flow and the element features: which elements
// it recognizes (by their import from "@reactre/core"), the compile errors for what it cannot
// support, and that a file using none of them compiles to the same code as before they existed
// (the golden snapshots, written by the compiler at 0.0.3). What the compiled code does at runtime
// is tested in packages/core/test/flow.test.ts.

import { describe, expect, test } from "bun:test";

import { compileJs, compileSource, ReactreCompileError } from "../src/index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

const fails = (src: string, message: RegExp) => {
  expect(() => compileSource(src)).toThrow(ReactreCompileError);
  expect(() => compileSource(src)).toThrow(message);
};

/** A source with `import { names } from "@reactre/core"` before `body`. */
const withImport = (names: string, body: string) => `import { ${names} } from "@reactre/core";\n${body}`;

// #region Recognition

describe("recognition", () => {
  test("control flow is compiled only when imported from @reactre/core; else it is a component", () => {
    const own = compileSource(`const Show = (p) => p.children; export const x = <div><Show when={a()}>x</Show></div>;`);
    expect(own).toContain("Show({");
    expect(own).not.toContain("__rrMemo");
    const core = compileSource(withImport("Show", `export const x = <div><Show when={a()}>x</Show></div>;`));
    expect(core).not.toContain("Show({");
    expect(core).toContain("memo as __rrMemo");
  });

  test("by any local name, through a namespace import, and as oxc prints imports", () => {
    const aliased = compileSource(
      withImport(
        "Show as When, For as Each",
        `export const x = <ul><When when={a()}>x</When><Each each={[]} key={(r) => r}>{(r) => <li />}</Each></ul>;`,
      ),
    );
    expect(aliased).toContain("__rrMemo");
    expect(aliased).toContain("__rrFor(");
    const ns = compileSource(
      `import * as R from "@reactre/core"; export const x = <div><R.Show when={a()}>x</R.Show></div>;`,
    );
    expect(ns).toContain("__rrMemo");
    // oxc's output, with the helpers renamed as the plugin renames them.
    const oxc = compileJs(
      `import { Show } from '@reactre/core';\nexport const x = jsx_reactre0("div", { children: jsx_reactre0(Show, { when: a(), children: "x" }) });`,
    );
    expect(oxc).toContain("__rrMemo");
  });

  test("a file without the new features imports none of their helpers", () => {
    const out = compileSource(
      `export const x = <div class={c()}><For each={rows()} key={(r) => r}>{(r) => <p ref={r.ref} />}</For></div>;`,
    );
    for (const helper of ["memo", "signal", "onCleanup", "__class"]) expect(out).not.toContain(`${helper} as`);
  });
});

// #endregion

// #region Compile errors

describe("compile errors", () => {
  test("<Show> and <Match> need when, take only their own props, and a keyed written as a boolean", () => {
    fails(withImport("Show", `export const x = <div><Show>x</Show></div>;`), /<Show> needs when/);
    fails(
      withImport("Show", `export const x = <div><Show when={1} each={[]}>x</Show></div>;`),
      /<Show> takes when, fallback, keyed, children, not each/,
    );
    fails(
      withImport("Show", `export const x = <div><Show when={1} keyed={k}>x</Show></div>;`),
      /<Show>'s keyed must be written as true or false, not k/,
    );
    fails(
      withImport("Show", `const p = {}; export const x = <div><Show {...p}>x</Show></div>;`),
      /spread props are not supported here/,
    );
    fails(withImport("Show", `export const x = <div><Show when={1} key={k()}>x</Show></div>;`), /<Show> takes no key/);
    fails(
      withImport("Switch, Match", `export const x = <div><Switch><Match>x</Match></Switch></div>;`),
      /<Match> needs when/,
    );
  });

  test("a <Switch> takes only <Match> children, and a <Match> stands only in a <Switch>", () => {
    fails(
      withImport("Switch", `export const x = <div><Switch><p /></Switch></div>;`),
      /<Switch> takes only <Match> children/,
    );
    fails(
      withImport("Switch", `export const x = <div><Switch>{a}</Switch></div>;`),
      /<Switch> takes only <Match> children: a/,
    );
    fails(
      withImport("Match", `export const x = <div><Match when={1}>x</Match></div>;`),
      /<Match> must be a child of <Switch>/,
    );
    fails(withImport("Match", `export const x = <Match when={1}>x</Match>;`), /<Match> must be a child of <Switch>/);
  });

  test("a <Repeat> takes a count and a row written in place, wherever it stands", () => {
    fails(
      withImport("Repeat", `export const x = <Repeat>{(i) => <li />}</Repeat>;`),
      /<Repeat> takes count, from, fallback and a row function as its child$/,
    );
    fails(
      withImport("Repeat", `export const x = <ul><Repeat>{(i) => <li />}</Repeat></ul>;`),
      /<Repeat> takes count, from, fallback and a row function as its child$/,
    );
    fails(
      withImport("Repeat", `export const x = <ul><Repeat count={1} each={[]}>{(i) => <li />}</Repeat></ul>;`),
      /, not each/,
    );
    fails(
      withImport("Repeat", `export const x = <ul><Repeat count={1} key={1}>{(i) => <li />}</Repeat></ul>;`),
      /, not key/,
    );
    fails(withImport("Repeat", `export const x = <Repeat count={1} key={1}>{(i) => <li />}</Repeat>;`), /, not key/);
    fails(withImport("Repeat", `export const x = <Repeat count={1} each={[]}>{(i) => <li />}</Repeat>;`), /, not each/);
    fails(
      withImport("Repeat", `export const x = <ul><Repeat count={1}>{row}</Repeat></ul>;`),
      /a <Repeat> row must be \(i\) => its content, written in place, or the content: row$/,
    );
    fails(
      withImport("Repeat", `export const x = <Repeat count={1}>{(i, j) => <li />}</Repeat>;`),
      /a <Repeat> row must be \(i\) => its content/,
    );
    fails(`export const x = <For each={[]} key={(r) => r}>{(a, b, c) => <li />}</For>;`, /\(item, i\) => its content/);
    fails(`export const x = <For each={[]}>{(r) => r}</For>;`, /<For> needs each, key and a row function/);
    fails(`export const x = <For key={(r) => r}>{(r) => r}</For>;`, /<For> needs each, key and a row function/);
  });

  test("a <Portal>'s children are content, and a <Dynamic> needs a component and takes no key", () => {
    fails(
      withImport("Portal", `export const x = <div><Portal>{(v) => <p />}</Portal></div>;`),
      /<Portal>'s children are content, not a function/,
    );
    fails(
      withImport("Portal", `export const x = <div><Portal target={t}>x</Portal></div>;`),
      /<Portal> takes mount, children, not target/,
    );
    fails(withImport("Dynamic", `export const x = <div><Dynamic id="a" /></div>;`), /<Dynamic> needs component/);
    fails(
      withImport("Dynamic", `export const x = <div><Dynamic component="p" key={k()} /></div>;`),
      /<Dynamic> takes no key/,
    );
  });
});

// #endregion

// #region What it compiles to

describe("output", () => {
  test("a <Show> whose when calls nothing has no memo; one standing alone is a fragment's slot", () => {
    // X is not exported, and no call site passes it `on` reactively: `p.on` is written once.
    const out = compileSource(withImport("Show", `const X = (p) => <Show when={p.on}>x</Show>;`));
    expect(out).toContain('__rrFrag([((__rrX0) => () => (__rrX0 ? "x" : null))(p.on)])');
    expect(out).not.toContain("__rrMemo");
  });

  test("a list of element rows in an element is the core's; any other is features/for's, imported only then", () => {
    const plain = compileSource(
      `export const x = <ul><For each={rows()} key={(r) => r}>{(r) => <li>{r}</li>}</For><Repeat count={2}>{(i) => <li />}</Repeat></ul>;`,
    );
    expect(plain).not.toContain("features/for");
    expect(plain).not.toContain("__rrEach");
    const views = [
      `export const x = <For each={rows()} key={(r) => r}>{(r) => <li>{r}</li>}</For>;`,
      `export const x = <><For each={rows()} key={(r) => r}>{(r) => <li>{r}</li>}</For>z</>;`,
      `export const x = <ul><For each={rows()} key={(r) => r}>{(r) => r}</For></ul>;`,
      `export const x = <ul><For each={rows()} key={(r) => r}>{(r, i) => <li>{i()}</li>}</For></ul>;`,
      withImport("Repeat", `export const x = <Repeat count={n()}>{(i) => <li />}</Repeat>;`),
      withImport(
        "Show",
        `export const x = <Show when={a()}><For each={rows()} key={(r) => r}>{(r) => r}</For></Show>;`,
      ),
    ];
    for (const v of views) {
      const out = compileSource(v);
      expect(out).toContain('import { __each as __rrEach } from "@reactre/core/features/for";');
      expect(out).toContain("__rrEach({ each: () => (");
      // In hydrate mode, the list that claims; on the server, its markup in one pair.
      expect(compileSource(v, "tsx", { hydrate: true })).toContain(
        'import { __each as __rrEach } from "@reactre/core/hydrate/for";',
      );
      const ssr = compileSource(v, "tsx", { server: true });
      expect(ssr).toContain("__rrsS(");
      expect(ssr).not.toContain("__rrEach");
    }
    // An element child whose row is a fragment is content in its element's hole.
    expect(compileSource(views[2]!)).toContain("__rrInsert(__n[0], __rrEach(");
    // The row of a store's array reads a copy, and its item is a store root.
    const store = compileSource(
      `import { createStore } from "@reactre/core/features/store"; const [s] = createStore({ l: [] });` +
        `export const x = <For each={s.l} key={(t) => t}>{(t) => <>{t.title}</>}</For>;`,
    );
    expect(store).toContain("each: () => ([...(s.l)])");
    expect(store).toContain("() => (t.title)");
    // A row the compiler cannot read as a function written in place, or of too many parameters.
    fails(`export const x = <For each={[]} key={(r) => r}>{rowOf}</For>;`, /row must be \(item, i\) => its content/);
  });

  test("a <For> with a fallback keeps its anchor, as the only child of its element", () => {
    const out = compileSource(
      `export const x = <ul><For each={rows()} key={(r) => r} fallback="none">{(r) => <li />}</For></ul>;`,
    );
    expect(out).not.toContain("__p.removeChild");
    expect(out).toContain("__rrSignal(true)");
  });

  test("a class object whose keys are literals, and a <Dynamic> of a tag written as a string, add no code", () => {
    const out = compileSource(
      withImport(
        "Dynamic",
        `export const x = <div><Dynamic component="h1" class={{ a: true, b: false }}>t</Dynamic></div>;`,
      ),
    );
    expect(out).toContain('<div><h1 class=\\"a\\">t</h1></div>');
    expect(out).not.toContain("locate");
  });

  test("the source map marks the new features' code too, and the code is the same without one", async () => {
    const { compileJsWithMap } = await import("../src/index.ts");
    const t = new Bun.Transpiler({
      loader: "tsx",
      tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "@reactre/core" } },
    } as ConstructorParameters<typeof Bun.Transpiler>[0]);
    const js = t.transformSync(
      withImport(
        "Show, Switch, Match, Repeat, Portal, Dynamic, For",
        `export const x = (
          <div class={["a", b()]} ref={[r1, ...rs]}>
            <Show when={a()} fallback={<i />}>{(v) => <b>{v()}</b>}</Show>
            <Switch><Match when={m()} keyed>{(v) => v}</Match></Switch>
            <Portal mount={el}>p</Portal>
            <Dynamic component={tag()} title={t()}>d</Dynamic>
            <ul><Repeat count={n()} from={f}>{(i) => <li class={{ on: on(i) }} />}</Repeat></ul>
            <ol><For each={rows()} key={(r) => r} fallback={<li />}>{(r) => <li />}</For></ol>
          </div>
        );`,
      ),
    );
    const { code, map } = compileJsWithMap(js);
    expect(code).toBe(compileJs(js));
    expect(map!.mappings.length).toBeGreaterThan(0);
  });
});

// #endregion

// #region Golden: no new features, no new code

describe("golden", () => {
  // Compiled by the compiler at 0.0.3 (before control flow); a change to them is a change to what
  // every existing app ships. `bun test --update-snapshots` writes them anew.
  test("the benchmark app compiles to the same code", async () => {
    expect(compileSource(await Bun.file(ROOT + "apps/jfb/app/reactre.tsx").text())).toMatchSnapshot();
  });

  test("a file of every older construct compiles to the same code", () => {
    const src = `
      import { For, render, selector, signal } from "@reactre/core";
      const [rows, setRows] = signal([]);
      const [sel, setSel] = signal(0);
      const isSel = selector(sel);
      const Row = (p) => <b>{p.label}</b>;
      export const App = ({ extra, title }) => (
        <main class={sel() ? "on" : ""} className="m" style={{ color: "red" }} title={title} {...extra}>
          <section class="s" style={sel() ? "a" : "b"} ref={(el) => el} onClick={() => setSel(1)}>
            <input value={sel()} checked={true} selected={sel() > 1} />
            {sel() ? <Row label="x" /> : <i>no</i>}
            <p key={sel()}>keyed</p>
            <>
              <em>frag</em>
            </>
          </section>
          <svg class={sel() ? "a" : "b"}><circle r={sel()} /></svg>
          <table>
            <tbody>
              <For each={rows()} key={(r) => r.id}>
                {(r) => (
                  <tr class={isSel(r.id) ? "danger" : ""} onClick={() => setSel(r.id)} onFocus={() => r}>
                    <td>{r.label}</td>
                    <td><Row label={r.label} /></td>
                    <td><input value={r.v} /></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </main>
      );
      render(App, document.body);
    `;
    expect(compileSource(src)).toMatchSnapshot();
    expect(compileSource(src, "jsx")).toMatchSnapshot();
  });
});

// #endregion
