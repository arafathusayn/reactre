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
    // `tuple` keeps a store's tuple whole: `tuple[0]` is the store.
    expect([...findStores(src)].sort()).toEqual(["a", "b", "c", "d", "e", "f", "tuple"]);
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

  test("a local made of a store's member is a store root: its holes are bound, a <For> over it is copied", () => {
    const out = compileSource(`
      import { For } from "@reactre/core";
      ${STORE}
      const [s] = createStore({ todos: [] });
      const todos = s.todos, { list: first = [] } = s, plain = { n: 1 }, n = plain.n;
      export const A = () => (
        <div>
          {todos.length}{first.length}{n}
          <ul><For each={todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>
        </div>
      );
    `);
    expect(out).toContain("() => (todos.length)");
    expect(out).toContain("() => (first.length)");
    expect(out).toContain("each: () => ([...(todos)])");
    expect(out).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
    // A local made of what holds no store is as before.
    expect(out).toContain('clone(["", "", (n), ""])');
  });

  test("a store in an object, a store's tuple kept whole, and what is assigned one are store roots", () => {
    const out = compileSource(`
      ${STORE}
      const [s] = createStore({ n: 1 });
      const box = { s }, t = createStore({ n: 1 }), nested = { inner: { get s() { return s; } } };
      let late, slots = {}, list = [];
      late = s; slots.a = s; list[0] = s;
      class C { f = s; m() { this.x = s; } }
      export const A = () => <p>{box.s.n}{t[0].n}{nested.inner.s.n}{late.n}{slots.a.n}{list[0].n}</p>;
    `);
    for (const read of ["box.s.n", "t[0].n", "nested.inner.s.n", "late.n", "slots.a.n", "list[0].n"])
      expect(out).toContain(`() => (${read})`);
  });

  test("a function that returns a store is a store root: a hole and a <For> that read its result follow it", () => {
    const out = compileSource(`
      import { For } from "@reactre/core";
      ${STORE}
      const [s] = createStore({ todos: [] });
      function useTodos() { return s; }
      const getTodos = () => s.todos, current = useTodos();
      export const A = () => (
        <div data-n={current.n}>
          <ul><For each={useTodos().todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>
          <ol><For each={getTodos()} key={(t) => t.id}>{(t) => <li>{t.done ? "+" : "-"}</li>}</For></ol>
        </div>
      );
    `);
    expect(out).toContain("() => (current.n)");
    expect(out).toContain("each: () => ([...(useTodos().todos)])");
    expect(out).toContain("each: () => ([...(getTodos())])");
    expect(out).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
    expect(out).toContain('dyn: (t, __d) => { __d[0] = (t.done ? "+" : "-"); }');
  });

  test("a store's array passed in as a prop: the component's <For> over it is copied and its rows follow", () => {
    const out = compileSource(`
      import { For } from "@reactre/core";
      ${STORE}
      const [s] = createStore({ todos: [] });
      function List(props) {
        const todos = props.todos;
        return (
          <div>
            <ul><For each={props.todos} key={(t) => t.id}>{(t) => <li><Item todo={t} /></li>}</For></ul>
            <ol><For each={todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ol>
            <Pattern list={props.todos} />
          </div>
        );
      }
      function Pattern({ list }) {
        return <ul><For each={list} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>;
      }
      function Item(props) { return <ul><For each={props.todo.tags} key={(g) => g}>{(g) => <b>{g}</b>}</For></ul>; }
      function Plain(props) { return <ul><For each={props.rows} key={(r) => r.id}>{(r) => <li>{r.title}</li>}</For></ul>; }
      export const A = () => <main><List todos={s.todos} /><Plain rows={[{ id: 1, title: "a" }]} /></main>;
    `);
    expect(out).toContain("each: () => ([...(props.todos)])");
    expect(out).toContain("each: () => ([...(todos)])");
    expect(out).toContain("each: () => ([...(list)])");
    expect(out).toContain("Item({ get todo() { return t; } })");
    expect(out).toContain("each: () => ([...(props.todo.tags)])");
    // A component no call site passes a store compiles as before.
    expect(out).toContain("each: () => (props.rows)");
    expect(out).toContain("fill: (r, __v) => { __v[0] = (r.title); }");
  });

  test("an exported component seen alone may be passed a store in any prop; a whole program that sees its callers is exact", () => {
    const list = `
      import { For } from "@reactre/core";
      export function List(props) { return <ul><For each={props.todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>; }
      export function Rows(props) { return <ul><For each={props.rows} key={(r) => r.id}>{(r) => <li>{r.title}</li>}</For></ul>; }
    `;
    // Seen alone, its file cannot see the callers: each list is copied, its rows bound.
    const alone = compileSource(list);
    expect(alone).toContain("each: () => ([...(props.todos)])");
    expect(alone).toContain("each: () => ([...(props.rows)])");
    expect(alone).toContain("dyn: (r, __d) => { __d[0] = (r.title); }");
    // The program sees List passed a store's array and Rows plain rows.
    const p = program({
      list,
      main: `${STORE} import { List, Rows } from "./list"; const [s] = createStore({ todos: [] }); export const A = () => <div><List todos={s.todos} /><Rows rows={[{ id: 1, title: "a" }]} /></div>;`,
    });
    const whole = compileJs(js(list), { props: p.factsOf("list") });
    expect(whole).toContain("each: () => ([...(props.todos)])");
    expect(whole).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
    expect(whole).toContain("each: () => (props.rows)");
    expect(whole).toContain("fill: (r, __v) => { __v[0] = (r.title); }");
  });

  test("a keyed <Show>'s and <Match>'s child gets a store: its holes that read it are bound", () => {
    const out = compileSource(`
      import { Match, Show, Switch } from "@reactre/core";
      ${STORE}
      const [s] = createStore({ user: null });
      const plain = { user: { name: "a" } };
      export const A = () => (
        <div>
          <Show when={s.user} keyed>{(u) => <p>{u.name}</p>}</Show>
          <Switch><Match when={s.user} keyed>{(m) => <i>{m.name}</i>}</Match></Switch>
          <Show when={plain.user} keyed>{(v) => <b>{v.name}</b>}</Show>
        </div>
      );
    `);
    expect(out).toContain("() => (u.name)");
    expect(out).toContain("() => (m.name)");
    expect(out).toContain("clone([(v.name)])");
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

  test("what a module makes of a store and exports is a store where another imports it; what it makes of none is not", () => {
    const made = `
      import { store, plain } from "./state";
      import { lib } from "some-package";
      export const todos = store.todos, box = { store }, n = plain.n, fromLib = lib.x;
      export function useStore() { return store; }
      export const getPlain = () => plain;
    `;
    const main = `
      import { For } from "@reactre/core";
      import { todos, box, n, fromLib, useStore, getPlain } from "./made";
      export const A = () => (
        <div>
          {todos.length}{box.store.n}{n}{fromLib.y}{getPlain().n}
          <ul><For each={useStore().todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>
          <ol><For each={getPlain().list} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ol>
        </div>
      );
    `;
    const p = program({ state, made, main });
    expect(facts(p, "made").stores).toEqual(["box", "fromLib", "lib", "store", "todos", "useStore"]);
    expect(facts(p, "main").stores).toEqual(["box", "fromLib", "todos", "useStore"]);
    const out = compileJs(js(main), { props: p.factsOf("main") });
    expect(out).toContain("() => (todos.length)");
    expect(out).toContain("() => (box.store.n)");
    expect(out).toContain("() => (fromLib.y)");
    expect(out).toContain("[...(useStore().todos)]");
    expect(out).toContain("dyn: (t, __d) => { __d[0] = (t.title); }");
    // `n` and `getPlain` hold no store: written once, and a list over them is not copied.
    expect(out).toContain('clone(["", "", (n), "", "", "", ""])');
    expect(out).toContain("each: () => (getPlain().list)");
  });

  test("scanModule: the locals that may hold a store, with what they are made of", () => {
    const info = scanModule(
      js(`
        ${STORE}
        import { ext } from "./ext";
        const [s] = createStore({});
        const a = s.x, b = a.y, { c, d: e = 1, ...f } = ext;
        for (const g of s.list) use(g);
        for (const [h] of a) use(h);
        function fn() { return b; }
        function Comp(props) { const i = props.i; return i; }
        function Pat({ j, k: l }) { return j; }
        let none = 1, m = () => s;
        if (none == s) none += s;
        this.q = s; obj[key].r = s;
      `),
    );
    const roots = Object.fromEntries([...info.aliases].map(([k, a]) => [k, [...a.roots].sort()]));
    // A function is one by what its body mentions, its own locals too (Comp's `i`, Pat's `j`, `l`).
    expect(roots).toEqual({
      Comp: ["i"],
      Pat: ["j", "l"],
      a: ["s"],
      b: ["a"],
      c: ["ext"],
      e: ["ext"],
      f: ["ext"],
      g: ["s"],
      h: ["a"],
      fn: ["b"],
      i: [],
      j: [],
      l: [],
      m: ["s"],
      obj: ["s"],
    });
    expect(info.aliases.get("i")!.reads.map(([d, r]) => [d.name, [...(r as Set<string>)]])).toEqual([["Comp", ["i"]]]);
    expect(info.aliases.get("l")!.reads.map(([d, r]) => [d.name, [...(r as Set<string>)]])).toEqual([["Pat", ["k"]]]);
    // Those its own store alone makes stores are its stores.
    expect([...info.stores].sort()).toEqual(["a", "b", "fn", "g", "h", "m", "obj", "s"]);
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
