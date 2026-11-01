// What an app ships, and how it behaves, with each of @reactre/core's features on and off. Each
// app here is bundled as a production build bundles it (minified, tree-shaken, @reactre/core
// and @reactre/dom from their sources), then run on the fake DOM, so a feature that is off is
// really absent, not merely unused. The unbundled tests (index.test.ts) load the whole module,
// with every feature installed.
//
// Features:
//   ownership  the owner tree: effects own the effects and cleanups their runs make, slots and
//              rows with mounts dispose their content, `attach` returns a disposer. Included by
//              usage, with no opt-in: `effect`, `memo`, a slot, a fragment, a row with mounts or
//              `attach` brings it; an app with none of them ships none of it.
//   selectors  <For> rows that read several selector keys: @reactre/core/features/selectors,
//              imported by the compiler for a row whose reactive holes make two or more calls
//              with arguments, or by the app. Without it, a row's second key throws.
//   owner and timing APIs
//              Solid 2.0's, as feature modules: @reactre/core/features/owner (`createRoot`,
//              `getOwner`, `runWithOwner`), features/timing (`onSettled`, `flush`) and
//              features/reaction (`reaction`). Each comes only with its import and hooks into
//              nothing that runs without it: an app that does not import them ships the same
//              code as before. `createRoot` and `reaction` bring ownership, as `attach` and
//              `effect` do.
//   control    <Show>, <Switch>, <Repeat>, <Portal>, <Dynamic>, a <For>'s fallback, class
//   flow       objects and arrays: compiled to slots, memos and lists, with no opt-in and no
//              runtime of their own (only `__class` runs, imported when used; `dynamic()` is
//              a feature module, @reactre/core/features/dynamic).
//              The "show" profile is an app that uses some; the others use none, and are the
//              same bytes as before control flow existed.
//   stores and Solid 2.0's stores (@reactre/core/features/store) and memo and signal options
//   memo       (features/memo), built from the public API: each comes only with its import.
//   options
//   context    @reactre/core/features/context (`createContext`, `useContext`) and
//   and errors features/errors (`<Errored>`, `effect(fn, { error })`, `configureClientErrors`).
//              Loading one wraps methods of the owned effect class (and, for errors, of the list
//              class); an app that does not import them ships the core's code unchanged.
//
// The size profiles (../sizes.json), one app each:
//   jfb       the js-framework-benchmark app (apps/jfb/app/reactre.tsx): no opt-in at all.
//   plain     holes, a list, a selector and delegated handlers: the benchmark's features.
//   slot      a slot whose content has an effect and a cleanup: ownership by usage.
//   attach    `attach` alone.
//   imported  rows with several selector keys, by importing the feature.
//   root      `createRoot` around a `render`, with `getOwner` and `runWithOwner`.
//   settled   `onSettled` in a slot's content, rendered in a `flush(fn)`.
//   reaction  `reaction` beside a `render`.
//   show      a <Show> whose child reads an accessor, a <For> with a fallback, a class list.
//   store     a store's array in a <For>, written through its setter and `reconcile`.
//   memo      a memo with `equals`, and a writable derived signal of it.
//   context   a provider, and lookups in its children and in a slot's content made later.
//   errors    an <Errored> whose child's hole throws on an update, and its reset.
//
// The size budgets live in ../sizes.json. When a change is worth its bytes, record the new sizes:
//
//   UPDATE_SIZES=1 bun test packages/core/test/features.test.ts

import { beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { reactreCompiler } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

beforeEach(installFakeDocument);

const scratch = Bun.fileURLToPath(new URL("../.cache/features", import.meta.url));
const budgets = Bun.fileURLToPath(new URL("../sizes.json", import.meta.url));

/** Bundle `src`, a TSX module body with `root` in scope: minified, or not to read its code. */
async function bundle(name: string, src: string, minify = true): Promise<string> {
  const entry = `${scratch}/${name}.tsx`;
  await Bun.write(entry, src);
  const r = await Bun.build({
    entrypoints: [entry],
    format: "iife",
    minify,
    target: "browser",
    // The packages' sources, as the repository's own builds resolve them.
    conditions: ["reactre-source"],
    plugins: [reactreCompiler()],
  });
  if (!r.success) throw new Error(r.logs.join("\n"));
  return r.outputs[0]!.text();
}

/** Run a bundle with a fresh `root` (a div inside a fake document) as a global. */
function run(code: string): { root: FakeElement; api: Record<string, (...a: unknown[]) => unknown> } {
  const doc = new FakeElement("HTML");
  doc.isDocument = true;
  const root = new FakeElement("DIV");
  doc.appendChild(root);
  const g = globalThis as unknown as { root: FakeElement; api: Record<string, (...a: unknown[]) => unknown> };
  g.root = root;
  new Function(code)();
  return { root, api: g.api };
}

/** Text of an element and its descendants. */
const text = (n: FakeElement): string => n.textContent ?? "";

// One app per profile. Each sets `globalThis.api` to what the test drives.
const apps = {
  /** Holes, a list, a selector, delegated handlers: the benchmark's features, and nothing more. */
  plain: `
    import { batch, For, render, selector, signal } from "@reactre/core";
    const [rows, setRows] = signal([{ id: 1, label: "a" }, { id: 2, label: "b" }]);
    const [sel, setSel] = signal(0);
    const isSel = selector(sel);
    function App() {
      return (
        <ul>
          <For each={rows()} key={(r) => r.id}>
            {(r) => <li class={isSel(r.id) ? "on" : ""}><a onClick={() => setSel(r.id)}>{r.label}</a></li>}
          </For>
        </ul>
      );
    }
    render(App, root);
    globalThis.api = { setRows, setSel, batch };
  `,
  /** A slot that swaps content whose effect and cleanup must stop with it. */
  slot: `
    import { effect, onCleanup, render, signal } from "@reactre/core";
    const [show, setShow] = signal(true);
    const [n, setN] = signal(0);
    let runs = 0, cleaned = 0;
    function A() {
      effect(() => void (n(), runs++));
      onCleanup(() => cleaned++);
      return <b>{n()}</b>;
    }
    render(() => <p>{show() ? <A /> : <i>no</i>}</p>, root);
    globalThis.api = { setShow, setN, runs: () => runs, cleaned: () => cleaned };
  `,
  /** \`attach\` alone: its disposer stops the view's effects. */
  attach: `
    import { attach, signal } from "@reactre/core";
    const [n, setN] = signal(0);
    const dispose = attach(() => <p>{n()}</p>, root);
    globalThis.api = { setN, dispose };
  `,
  /** Control flow: a <Show> whose child reads an accessor, a <For> with a fallback, a class list. */
  show: `
    import { For, render, Show, signal } from "@reactre/core";
    const [rows, setRows] = signal([]);
    const [user, setUser] = signal(null);
    function App() {
      return (
        <div>
          <Show when={user()} fallback={<p>out</p>}>{(u) => <p class={["user", { admin: true }]}>{u().name}</p>}</Show>
          <ul><For each={rows()} key={(r) => r} fallback={<li>none</li>}>{(r) => <li>{r}</li>}</For></ul>
        </div>
      );
    }
    render(App, root);
    globalThis.api = { setRows, setUser };
  `,
  /** A row that reads two selectors through a function of its own, which the compiler cannot see. */
  hidden: `
    import { For, render, selector, signal } from "@reactre/core";
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const isA = selector(a), isB = selector(b);
    const cls = (id) => (isA(id) ? "a" : "") + (isB(id) ? "b" : "");
    function App() {
      return <ul><For each={[1, 2]} key={(r) => r}>{(r) => <li class={cls(r)} />}</For></ul>;
    }
    render(App, root);
    globalThis.api = { setA, setB };
  `,
  /** The same row with the feature imported by the app. */
  imported: `
    import "@reactre/core/features/selectors";
    import { For, render, selector, signal } from "@reactre/core";
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const isA = selector(a), isB = selector(b);
    const cls = (id) => (isA(id) ? "a" : "") + (isB(id) ? "b" : "");
    function App() {
      return <ul><For each={[1, 2]} key={(r) => r}>{(r) => <li class={cls(r)} />}</For></ul>;
    }
    render(App, root);
    globalThis.api = { setA, setB };
  `,
  /** Two selector calls in the row's own holes: the compiler imports the feature. */
  direct: `
    import { For, render, selector, signal } from "@reactre/core";
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const isA = selector(a), isB = selector(b);
    function App() {
      return <ul><For each={[1, 2]} key={(r) => r}>{(r) => <li class={isA(r) ? "a" : ""} title={isB(r) ? "b" : "-"} />}</For></ul>;
    }
    render(App, root);
    globalThis.api = { setA, setB };
  `,
  /** A root around a render, disposed by hand, and a cleanup added to it later through its owner. */
  root: `
    import { onCleanup, render, signal } from "@reactre/core";
    import { createRoot, getOwner, runWithOwner } from "@reactre/core/features/owner";
    const [n, setN] = signal(0);
    let cleaned = 0;
    const [dispose, owner] = createRoot((dispose) => {
      render(() => <p>{n()}</p>, root);
      return [dispose, getOwner()];
    });
    const later = () => runWithOwner(owner, () => onCleanup(() => cleaned++));
    globalThis.api = { setN, dispose, later, cleaned: () => cleaned };
  `,
  /** onSettled in a slot's content: rendered in a flush, then swapped in and out by writes. */
  settled: `
    import { batch, render, signal } from "@reactre/core";
    import { flush, onSettled } from "@reactre/core/features/timing";
    const log = [];
    const [show, setShow] = signal(true);
    function A() {
      onSettled(() => {
        log.push("in " + root.textContent);
        return () => log.push("out");
      });
      return <b>A</b>;
    }
    flush(() => render(() => <p>{show() ? <A /> : "none"}</p>, root));
    globalThis.api = { log, setShow, batch };
  `,
  /** A reaction, which applies only on a change of value, beside a view of the same signal. */
  reaction: `
    import { render, signal } from "@reactre/core";
    import { reaction } from "@reactre/core/features/reaction";
    const [id, setId] = signal(1);
    const log = [];
    reaction(
      () => id() % 10,
      (v, prev) => {
        log.push(prev + ">" + v);
        return () => log.push("cleanup " + v);
      },
    );
    render(() => <p>{id()}</p>, root);
    globalThis.api = { setId, log };
  `,
  /** A store's todos in a <For>, pushed to, toggled in place, and reconciled. */
  store: `
    import { For, render } from "@reactre/core";
    import { createStore, reconcile } from "@reactre/core/features/store";
    const [s, set] = createStore({ todos: [{ id: 1, title: "a", done: false }] });
    function App() {
      return (
        <ul>
          <For each={[...s.todos]} key={(t) => t.id}>
            {(t) => <li class={String(t.done)}>{t.title.trim()}</li>}
          </For>
        </ul>
      );
    }
    render(App, root);
    globalThis.api = {
      add: (id, title) => set((d) => { d.todos.push({ id, title, done: false }); }),
      toggle: (i) => set((d) => { d.todos[i].done = !d.todos[i].done; }),
      load: (todos) => set((d) => { reconcile(todos)(d.todos); }),
    };
  `,
  /** A memo with a custom equality, and a writable signal derived from it. */
  memo: `
    import { render, signal as base } from "@reactre/core";
    import { memo, signal } from "@reactre/core/features/memo";
    const [user, setUser] = base({ id: 1, name: "a" });
    let runs = 0;
    const current = memo(() => user(), { equals: (a, b) => a.id === b.id });
    const [label, setLabel] = signal(() => current().name);
    render(() => <p>{(runs++, current().name)}:{label()}</p>, root);
    globalThis.api = { setUser, setLabel, runs: () => runs };
  `,
  /**
   * A provider whose children read it, in its body and in a slot's content made later. The
   * provider gets its children as a getter, as lazy children compile.
   */
  context: `
    import { render, signal } from "@reactre/core";
    import { createContext, useContext } from "@reactre/core/features/context";
    const Theme = createContext("light");
    const Required = createContext();
    const [more, setMore] = signal(false);
    const Label = () => <b>{useContext(Theme)}</b>;
    function App() {
      return (
        <div>
          <Label />
          {Theme({ value: "dark", get children() { return <p><Label />{more() ? <Label /> : null}</p>; } })}
        </div>
      );
    }
    render(App, root);
    const missing = () => { try { useContext(Required); } catch (e) { return e.name; } };
    globalThis.api = { setMore, missing };
  `,
  /** A boundary whose child's hole throws on an update; its reset builds the child again. */
  errors: `
    import { render, signal } from "@reactre/core";
    import { Errored } from "@reactre/core/features/errors";
    const [n, setN] = signal(0);
    const fail = () => { throw new Error("bad " + n()); };
    const Count = () => <b>{n() === 1 ? fail() : n()}</b>;
    let retry;
    render(
      () => (
        <div>
          {Errored({
            fallback: (err, reset) => ((retry = reset), <i>{err.message}</i>),
            get children() { return <Count />; },
          })}
        </div>
      ),
      root,
    );
    globalThis.api = { setN, retry: () => retry() };
  `,
};

describe("ownership", () => {
  test("off: an app that makes no owner ships none of it, and works", async () => {
    const code = await bundle("plain", apps.plain, false);
    expect(code).not.toContain("class OwnedEffect");
    expect(code).not.toContain("function clean(");
    const { root, api } = run(await bundle("plain", apps.plain));
    expect(text(root)).toBe("ab");
    api.setSel!(2);
    const lis = (root.firstChild as FakeElement).childNodes as FakeElement[];
    expect(lis.map((li) => li.getAttribute("class") ?? "")).toEqual(["", "on"]);
    api.setRows!([{ id: 2, label: "B" }]);
    expect(text(root)).toBe("B");
  });

  test("on by usage: a slot disposes its old content's effects and cleanups", async () => {
    const code = await bundle("slot", apps.slot, false);
    expect(code).toContain("class OwnedEffect");
    const { root, api } = run(await bundle("slot", apps.slot));
    api.setN!(1);
    expect(text(root)).toBe("1");
    const before = api.runs!() as number;
    api.setShow!(false);
    expect(api.cleaned!()).toBe(1);
    api.setN!(2);
    expect(api.runs!()).toBe(before);
    expect(text(root)).toBe("no");
  });

  test("on by usage: attach's disposer stops the view's effects and takes its nodes out", async () => {
    const { root, api } = run(await bundle("attach", apps.attach));
    api.setN!(1);
    expect(text(root)).toBe("1");
    api.dispose!();
    expect(root.firstChild).toBeNull();
    api.setN!(2);
    expect(text(root)).toBe("");
  });
});

describe("selectors", () => {
  test("off: a row's second selector key throws, naming the module to import", async () => {
    const code = await bundle("hidden", apps.hidden, false);
    expect(code).not.toContain("scanMany = (");
    expect(() => run(code)).toThrow('import "@reactre/core/features/selectors"');
  });

  test("on by import: the row follows both selectors", async () => {
    const { root, api } = run(await bundle("imported", apps.imported));
    const cls = () =>
      ((root.firstChild as FakeElement).childNodes as FakeElement[]).map((li) => li.getAttribute("class") ?? "");
    api.setA!(1);
    api.setB!(1);
    expect(cls()).toEqual(["ab", ""]);
    api.setB!(2);
    expect(cls()).toEqual(["a", "b"]);
  });

  test("on by the compiler: two calls with arguments in a row's holes import it", async () => {
    const code = await bundle("direct", apps.direct, false);
    expect(code).toContain("scanMany = (");
    const { root, api } = run(code);
    const lis = () => (root.firstChild as FakeElement).childNodes as FakeElement[];
    api.setA!(2);
    api.setB!(2);
    expect(lis().map((li) => [li.getAttribute("class") ?? "", li.getAttribute("title")])).toEqual([
      ["", "-"],
      ["a", "b"],
    ]);
  });
});

describe("owner and timing APIs", () => {
  test("off: an app that does not import them ships none of their code", async () => {
    for (const name of ["plain", "slot", "attach"] as const) {
      const code = await bundle(name, apps[name], false);
      for (const fn of ["createRoot", "getOwner", "runWithOwner", "onSettled", "flush", "reaction"])
        expect(code).not.toContain(`function ${fn}(`);
      expect(code).not.toContain("settler");
      expect(code).not.toContain("queueMicrotask");
    }
  });

  test("createRoot: its dispose stops the holes rendered in it, and runWithOwner adds to it later", async () => {
    const code = await bundle("root", apps.root, false);
    // A root owns the runtime's own effects too, so it brings ownership.
    expect(code).toContain("class OwnedEffect");
    const { root, api } = run(await bundle("root", apps.root));
    api.setN!(1);
    expect(text(root)).toBe("1");
    api.later!();
    api.dispose!();
    expect(api.cleaned!()).toBe(1);
    api.setN!(2);
    expect(text(root)).toBe("1");
  });

  test("onSettled: before flush returns, at a batch's end, or at the next microtask; its cleanup goes with the content", async () => {
    const { root, api } = run(await bundle("settled", apps.settled));
    const log = api.log as unknown as string[];
    expect(log).toEqual(["in A"]);
    api.batch!(() => api.setShow!(false));
    expect(text(root)).toBe("none");
    expect(log).toEqual(["in A", "out"]);
    api.setShow!(true);
    expect(log).toEqual(["in A", "out"]);
    await Promise.resolve();
    expect(log).toEqual(["in A", "out", "in A"]);
  });

  test("reaction: apply runs on a change of compute's value, after the last apply's cleanup", async () => {
    const { root, api } = run(await bundle("reaction", apps.reaction));
    const log = api.log as unknown as string[];
    api.setId!(2);
    api.setId!(12);
    expect(text(root)).toBe("12");
    expect(log).toEqual(["undefined>1", "cleanup 1", "1>2"]);
  });
});

describe("control flow", () => {
  test("an app's <Show> and <For> fallback follow its signals once bundled", async () => {
    const { root, api } = run(await bundle("show", apps.show));
    expect(text(root)).toBe("outnone");
    api.setUser!({ name: "ann" });
    api.setRows!([1, 2]);
    expect(text(root)).toBe("ann12");
    expect(((root.firstChild as FakeElement).firstChild as FakeElement).getAttribute("class")).toBe("user admin");
    api.setUser!(null);
    api.setRows!([]);
    expect(text(root)).toBe("outnone");
  });
});

describe("stores and memo options", () => {
  test("off: an app that does not import them ships none of their code", async () => {
    for (const name of ["plain", "slot", "attach", "reaction"] as const) {
      const code = await bundle(name, apps[name], false);
      for (const fn of ["createStore", "createProjection", "reconcile", "snapshot", "deep", "merge", "omit"])
        expect(code).not.toContain(`function ${fn}(`);
      expect(code).not.toContain("new Proxy");
      expect(code).not.toContain("equals");
    }
  });

  test("store: <For> rows follow pushes, in-place writes to their items, and reconcile", async () => {
    const { root, api } = run(await bundle("store", apps.store));
    const lis = () => (root.firstChild as FakeElement).childNodes as FakeElement[];
    api.add!(2, "b");
    expect(text(root)).toBe("ab");
    const first = lis()[0];
    api.toggle!(0);
    expect(lis().map((li) => li.getAttribute("class"))).toEqual(["true", "false"]);
    api.load!([
      { id: 1, title: "A", done: true },
      { id: 3, title: "c", done: false },
    ]);
    expect(text(root)).toBe("Ac");
    expect(lis()[0]).toBe(first!);
  });

  test("memo: equals keeps readers from re-running, and the derived signal holds a write until its source changes", async () => {
    const { root, api } = run(await bundle("memo", apps.memo));
    expect(text(root)).toBe("a:a");
    api.setUser!({ id: 1, name: "b" });
    expect([text(root), api.runs!()]).toEqual(["a:a", 1]);
    api.setLabel!("x");
    expect(text(root)).toBe("a:x");
    api.setUser!({ id: 2, name: "c" });
    expect([text(root), api.runs!()]).toEqual(["c:c", 2]);
  });
});

describe("context and errors", () => {
  test("off: an app that does not import them ships none of their code", async () => {
    for (const name of ["plain", "slot", "attach", "show"] as const) {
      const code = await bundle(name, apps[name], false);
      for (const s of ["ContextNotFoundError", "function Errored(", "prototype.once", ".within =", "prototype.refresh"])
        expect(code).not.toContain(s);
    }
  });

  test("context: a provider's value reaches its children, and content a slot makes later", async () => {
    const { root, api } = run(await bundle("context", apps.context));
    expect(text(root)).toBe("lightdark");
    api.setMore!(true);
    expect(text(root)).toBe("lightdarkdark");
    expect(api.missing!()).toBe("ContextNotFoundError");
  });

  test("errors: a throw on an update shows the fallback; reset builds the children again", async () => {
    const { root, api } = run(await bundle("errors", apps.errors));
    expect(text(root)).toBe("0");
    api.setN!(1);
    expect(text(root)).toBe("bad 1");
    api.setN!(2);
    expect(text(root)).toBe("bad 1");
    api.retry!();
    expect(text(root)).toBe("2");
  });
});

describe("sizes", () => {
  test("each profile stays within its gzip budget", async () => {
    const jfb = Bun.fileURLToPath(new URL("../../../apps/jfb/app/reactre.tsx", import.meta.url));
    const sizes: Record<string, { min: number; gzip: number }> = {};
    const measure = (name: string, code: string) =>
      (sizes[name] = { min: code.length, gzip: gzipSync(code, { level: 9 }).length });
    // The benchmark app: what an app with no opt-in ships.
    measure("jfb", await bundle("jfb", await Bun.file(jfb).text()));
    for (const name of [
      "plain",
      "slot",
      "attach",
      "imported",
      "root",
      "settled",
      "reaction",
      "show",
      "store",
      "memo",
      "context",
      "errors",
    ] as const)
      measure(name, await bundle(name, apps[name]));
    if (process.env.UPDATE_SIZES) {
      await Bun.write(budgets, JSON.stringify(sizes, null, 2) + "\n");
      return;
    }
    const budget = (await Bun.file(budgets).json()) as typeof sizes;
    for (const [name, s] of Object.entries(sizes))
      expect({ name, gzip: s.gzip }).toEqual({ name, gzip: Math.min(s.gzip, budget[name]!.gzip) });
  });
});
