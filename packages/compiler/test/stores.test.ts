// Tests of store reads in @reactre/compiler: which names hold stores (`findStores`), what an
// expression mentions of them (`rootsIn`), how the compiler binds what reads a store, copies a
// store's array for a <For> and follows a store row's item, what stays as before, and how a whole
// program carries stores across modules: imports, re-exports, namespace imports, props passed a
// store's member, and the Bun plugin's build.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileJs, compileSource, reactreCompiler, transpileSource } from "../src/index.ts";
import { findStores, Program, propUse, type Resolved, rootsIn, scanModule } from "../src/program.ts";

/** A TSX source as the compiler reads it. */
const js = (src: string): string => transpileSource(src);

const STORE = `import { createStore, createProjection } from "@reactre/core/features/store";`;

/** A program of in-memory modules, resolved by their specifiers' names (`./a` is module `a`). */
function program(files: Record<string, string>, entries: string[] = ["main"]): Program {
  const p = new Program(entries);
  for (const [file, src] of Object.entries(files)) {
    const code = js(src);
    const resolved = new Map<string, Resolved>(
      scanModule(code).specs.map((s) => [s, s.startsWith("./") ? s.slice(2) : false]),
    );
    p.add(file, code, resolved);
  }
  return p;
}

/** A module's prop facts as plain data, and its store roots, sorted. */
function facts(p: Program, file: string) {
  const f = p.factsOf(file);
  return {
    props: Object.fromEntries([...f].map(([k, v]) => [k, v === true ? true : [...v].sort()])),
    stores: [...(f.stores ?? [])].sort(),
  };
}

// #region Roots

describe("store roots", () => {
  test("findStores: a createStore pattern's first name and a projection's name, under any import", () => {
    const src = js(`
      import { createStore as make, createProjection as project } from "@reactre/core/features/store";
      import * as S from "@reactre/core/features/store";
      export const [a, setA] = make({});
      let [b = 1] = S.createStore({}), [c] = make({});
      const d = project(() => {}, {}), e = S.createProjection(() => {}, {});
      let f; [f] = make({});
      const [, setG] = make({});
      const tuple = make({});
      const [h] = project(() => {}, {});
      if (x === make({})) y += make({});
      o.make({}); S.other({});
    `);
    expect([...findStores(src)].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    // Without the store module's import, nothing is a store, whatever its name.
    expect(findStores(js(`import { createStore } from "./mine"; const [s] = createStore({});`))).toEqual(new Set());
    expect(
      findStores(js(`import { reconcile } from "@reactre/core/features/store"; const [s] = reconcile({});`)),
    ).toEqual(new Set());
  });

  test("findStores: features/actions's optimistic store is a store; its other functions and namesakes are not", () => {
    const src = js(`
      import { createOptimisticStore as opt, createOptimistic } from "@reactre/core/features/actions";
      import * as A from "@reactre/core/features/actions";
      import { createOptimisticStore as notIt } from "@reactre/core/features/store";
      const [todos, setTodos] = opt(async () => [], []);
      const [b] = A.createOptimisticStore({}), [c] = A.createOptimistic(0), [d] = createOptimistic(0);
      const [e] = notIt({}), [f] = A.createStore({});
    `);
    expect([...findStores(src)].sort()).toEqual(["b", "todos"]);
    // Its rows and reads are bound, as a store's are.
    const out = compileSource(`
      import { For } from "@reactre/core";
      import { createOptimisticStore } from "@reactre/core/features/actions";
      const [todos] = createOptimisticStore([{ id: 1, title: "a" }], []);
      export const App = () => (
        <ul data-n={todos.length}>
          <For each={todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For>
        </ul>
      );
    `);
    expect(out).toContain("each: () => ([...(todos)])");
    expect(out).toContain("() => (todos.length)");
    expect(out).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
  });

  test("rootsIn: a member read, a mention passed on, a namespace import's member; not a key or another's member", () => {
    const roots = new Set(["s", "state.store", "ns.*"]);
    expect(rootsIn(`s.count + s[i] + s?.a`, roots)).toEqual(["s"]);
    expect(rootsIn(`f(s)`, roots)).toEqual(["s"]);
    expect(rootsIn(`{ ...s }`, roots)).toEqual(["s"]);
    expect(rootsIn(`{ s }`, roots)).toEqual(["s"]);
    expect(rootsIn(`x.s + { s: 1 }`, roots)).toEqual([]);
    expect(rootsIn(`state.store.n + state.other.n + ns.any.n`, roots)).toEqual(["state.store", "ns.any"]);
    expect(rootsIn(`() => s.count`, roots)).toEqual([]);
    const h = new Set(["jsx_aaaaaaaa"]);
    expect(rootsIn(`jsx_aaaaaaaa("b", { children: s.n })`, roots, h)).toEqual([]);
    expect(rootsIn(`s.n`, new Set())).toEqual([]);
  });

  test("propUse: a prop that mentions a store root says so; one that does not, as before", () => {
    const roots = new Set(["s"]);
    expect(propUse(`s.title`, new Set(), [], roots).stores).toEqual(["s"]);
    expect(propUse(`title`, new Set(), [], roots)).toEqual({ fn: false, lazy: false, calls: false, reads: [] });
    expect(propUse(`() => s.title`, new Set(), [], roots).stores).toBeUndefined();
  });
});

// #endregion

// #region Compiling

describe("compiling store reads", () => {
  test("a hole, an attribute, a class toggle, a <Show> and a handler that read a store are bound", () => {
    const out = compileSource(`
      import { Show } from "@reactre/core";
      ${STORE}
      const [s] = createStore({});
      export const A = () => (
        <p class={s.dark ? "d" : "l"} onClick={s.handler}>
          {s.count}<i class={{ on: s.on }} />
          <Show when={s.user}>u</Show>
        </p>
      );
    `);
    expect(out).toContain('__rrBind(__rrT0, 0, __n[0], () => (s.dark ? "d" : "l"));');
    expect(out).toContain('__rrOn(__n[1], "click", () => (s.handler));');
    expect(out).toContain("() => (s.count)");
    expect(out).toContain("() => (s.on)");
    expect(out).toContain("__rrMemo(() => !!(s.user))");
  });

  test("<For each> over a store reads a copy; its row's item-only holes are reactive, and a component is passed the item as a getter", () => {
    const out = compileSource(`
      import { For } from "@reactre/core";
      ${STORE}
      const [s] = createStore({ todos: [] });
      function Item(props) { return <i>{props.todo.title}</i>; }
      export const A = () => (
        <ul>
          <For each={s.todos} key={(t) => t.id} fallback={<li>{s.empty}</li>}>
            {(t) => <li class={t.done ? "d" : ""} title={x}>{t.title}<b><Item todo={t} /></b></li>}
          </For>
        </ul>
      );
    `);
    expect(out).toContain("const __rrL = ([...(s.todos)]);");
    expect(out).toContain('dyn: (t, __d) => { __d[0] = (t.done ? "d" : ""); __d[1] = (t.title); }');
    expect(out).toContain("fill: (t, __v) => { __v[1] = (x); }");
    expect(out).toContain("Item({ get todo() { return t; } })");
    // The fallback is outside the row: a store read, but not of the row's item.
    expect(out).toContain("(s.empty)");
    // Item's callers all pass todo a store: its hole is bound.
    expect(out).toContain("() => (props.todo.title)");
  });

  test("an array literal is not copied again; a nested list over the item's array is copied too", () => {
    const out = compileSource(`
      import { For } from "@reactre/core";
      ${STORE}
      const [s] = createStore({ todos: [] });
      export const A = () => (
        <ul><For each={[...s.todos]} key={(t) => t.id}>{(t) => <li><For each={t.tags} key={(g) => g}>{(g) => <b>{g}</b>}</For></li>}</For></ul>
      );
    `);
    expect(out).toContain("each: () => ([...s.todos])");
    expect(out).toContain("each: () => ([...(t.tags)])");
    expect(out).toContain("dyn: (g, __d) => { __d[0] = (g); }");
  });

  test("in a file with stores, what reads none compiles as before: other lists, other rows, a <Repeat>", () => {
    const body = `
      import { For, Repeat } from "@reactre/core";
      const t = { done: 1 };
      export const A = () => (
        <div>
          <ul><For each={rows()} key={(t) => t.id}>{(t) => <li class={t.done ? "d" : ""}>{t.title}</li>}</For></ul>
          <ol><Repeat count={3}>{(i) => <li>{i}</li>}</Repeat></ol>
          <p>{t.done}</p>
        </div>
      );
    `;
    const plain = compileSource(body);
    const withStore = compileSource(`${STORE} const [s] = createStore({}); ${body}`);
    expect(withStore.slice(withStore.indexOf("export const A"))).toBe(plain.slice(plain.indexOf("export const A")));
    // The row parameter shadows a store of the same name only within a store's row.
    const shadow = compileSource(`
      import { For } from "@reactre/core";
      ${STORE}
      const [t] = createStore({});
      export const A = () => <ul><For each={t.list} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>;
      export const B = () => <p>{t.title}</p>;
    `);
    expect(shadow).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
    expect(shadow).toContain("() => (t.title)");
  });

  test("what the compiler cannot follow stays as before: a local made of a member, a store in an object", () => {
    const out = compileSource(`
      import { For } from "@reactre/core";
      ${STORE}
      const [s] = createStore({ todos: [] });
      const todos = s.todos, box = { s };
      export const A = () => (
        <div>{box.s.n}<ul><For each={todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul></div>
      );
    `);
    expect(out).toContain('clone([(box.s.n), ""])');
    expect(out).toContain("each: () => (todos)");
    expect(out).toContain("fill: (t, __v) => { __v[0] = (t.title); }");
  });

  test("a file seen alone takes an import for a store, as it may be one; not @reactre's, an asset's or a local", () => {
    const out = compileSource(`
      import { For } from "@reactre/core";
      import * as core from "@reactre/core";
      import { store } from "./state";
      import * as state from "./state";
      import styles from "./app.module.css";
      import data from "./data.json?raw";
      function Label(props) { return <b>{props.text}</b>; }
      const local = { n: 1 };
      export const A = () => (
        <div class={styles.app} title={data.title}>
          {store.n}{state.store.n}{local.n}{core.version}
          <Label text={store.title} />
          <ul><For each={store.todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>
        </div>
      );
    `);
    expect(out).toContain("() => (store.n)");
    expect(out).toContain("() => (state.store.n)");
    expect(out).toContain("[...(store.todos)]");
    expect(out).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
    expect(out).toContain("get text() { return store.title; }");
    // Label is called here only, with a getter: its hole is bound.
    expect(out).toContain("() => (props.text)");
    expect(out).toContain(`clone([(styles.app), (data.title), "", "", (local.n), (core.version)`);
  });
});

// #endregion

// #region Programs

describe("stores across a program", () => {
  const state = `
    ${STORE}
    export const [store, setStore] = createStore({ n: 1, title: "a", todos: [] });
    const [inner] = createStore({});
    export { inner as renamed };
    export default inner;
    export const plain = { n: 1 };
  `;

  test("a store a module imports is a root there: by name, renamed, default, re-exported, through a namespace", () => {
    const p = program({
      state,
      barrel: `export { store as fromBarrel } from "./state"; export * from "./state";`,
      cycle: `export { loop } from "./cycle2";`,
      cycle2: `export { loop } from "./cycle";`,
      main: `
        import def, { store, renamed, plain } from "./state";
        import { fromBarrel, store as starred } from "./barrel";
        import * as ns from "./state";
        import * as bar from "./barrel";
        import { loop } from "./cycle";
        import { outside } from "./missing";
        import { lib } from "some-package";
        import * as pkg from "other-package";
        import { asset } from "./style.css";
        import { signal } from "@reactre/core";
        export const A = () => <p>{store.n}</p>;
      `,
    });
    // A module of the program is judged by its code (plain, cycle and missing hold none); a
    // package outside it may export a store, unless it is @reactre's or an asset.
    expect(facts(p, "main").stores).toEqual([
      "bar.fromBarrel",
      "bar.renamed",
      "bar.store",
      "def",
      "fromBarrel",
      "lib",
      "ns.default",
      "ns.renamed",
      "ns.store",
      "pkg.*",
      "renamed",
      "starred",
      "store",
    ]);
    expect(facts(p, "state").stores).toEqual(["inner", "store"]);
    expect(facts(p, "cycle").stores).toEqual([]);
    expect(p.factsOf("cycle").stores).toBeUndefined();
  });

  test("compileJs with the program's facts binds an imported store's reads, and copies its array for a <For>", () => {
    const main = `
      import { For } from "@reactre/core";
      import { store } from "./state";
      import * as ns from "./state";
      export const A = () => (
        <div>{store.n}{ns.store.title}{ns.plain.n}<ul><For each={ns.store.todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul></div>
      );
    `;
    const p = program({ state, main });
    const out = compileJs(js(main), { props: p.factsOf("main") });
    expect(out).toContain("() => (store.n)");
    expect(out).toContain("() => (ns.store.title)");
    expect(out).toContain("(ns.plain.n)");
    expect(out).toContain("[...(ns.store.todos)]");
    expect(out).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
  });

  test("a prop passed a store's member, or a store row's item, is reactive in a component of another module", () => {
    const p = program({
      state,
      label: `export function Label(props) { return <b>{props.text}</b>; } export function Plain(props) { return <b>{props.text}</b>; }`,
      item: `export function Item(props) { return <i>{props.todo.title}</i>; }`,
      main: `
        import { For } from "@reactre/core";
        import { store, plain } from "./state";
        import * as ns from "./state";
        import { Label, Plain } from "./label";
        import { Item } from "./item";
        export const A = () => (
          <div>
            <Label text={ns.store.title} /><Plain text={plain.n} />
            <ul><For each={store.todos} key={(t) => t.id}>{(t) => <li><Item todo={t} /><For each={t.tags} key={(g) => g}>{(g) => <Label text={g} />}</For></li>}</For></ul>
            <ol><For each={plain.list} key={(t) => t.id}>{(t) => <li><Plain text={t} /></li>}</For></ol>
          </div>
        );
      `,
    });
    expect(facts(p, "label").props).toEqual({ Label: ["text"], Plain: [] });
    expect(facts(p, "item").props).toEqual({ Item: ["todo"] });
    const out = compileJs(js(`export function Item(props) { return <i>{props.todo.title}</i>; }`), {
      props: p.factsOf("item"),
    });
    expect(out).toContain("() => (props.todo.title)");
  });

  test("with the program's facts, a module of it that exports no store is exact: its reads are written once", () => {
    const main = `import { plain } from "./state"; import { lib } from "some-package"; export const A = () => <p>{plain.n}{lib.n}</p>;`;
    const p = program({ state, main });
    const out = compileJs(js(main), { props: p.factsOf("main") });
    expect(out).toContain('clone([(plain.n), ""])');
    expect(out).toContain("() => (lib.n)");
    // Seen alone, the same file takes both for stores.
    expect(compileSource(main)).toContain('clone(["", ""])');
    const info = scanModule(js(`${STORE} const [s] = createStore({}); import { t } from "./x";`));
    expect([...info.stores]).toEqual(["s"]);
  });
});

// #endregion

// #region The Bun plugin

describe("reactreCompiler's whole program, with stores", () => {
  const dir = mkdtempSync(join(tmpdir(), "reactre-bun-stores-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a store exported by one module is followed where another reads it, and in a third's component", async () => {
    writeFileSync(
      join(dir, "state.ts"),
      `import { createStore } from "@reactre/core/features/store"; export const [store, setStore] = createStore({ n: 1, title: "a" });`,
    );
    writeFileSync(join(dir, "label.tsx"), `export function Label(props) { return <b>{props.text}</b>; }`);
    writeFileSync(
      join(dir, "main.tsx"),
      `import { store } from "./state.ts"; import { Label } from "./label.tsx"; export const App = () => <div>{store.n}<Label text={store.title} /></div>;`,
    );
    const build = async (wholeProgram: boolean) => {
      const r = await Bun.build({
        entrypoints: [join(dir, "main.tsx")],
        external: ["@reactre/core", "@reactre/core/features/store"],
        plugins: [reactreCompiler({ wholeProgram })],
      });
      return r.outputs[0]!.text();
    };
    const whole = await build(true);
    expect(whole).toContain("() => store.n");
    expect(whole).toContain("get text() {");
    expect(whole).toContain("() => props.text");
    // Each file alone: the import may be a store, so its read is bound all the same.
    const alone = await build(false);
    expect(alone).toContain("() => store.n");
    expect(alone).toContain("() => props.text");
  });
});

// #endregion
