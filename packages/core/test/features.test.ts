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

describe("sizes", () => {
  test("each profile stays within its gzip budget", async () => {
    const jfb = Bun.fileURLToPath(new URL("../../../apps/jfb/app/reactre.tsx", import.meta.url));
    const sizes: Record<string, { min: number; gzip: number }> = {};
    const measure = (name: string, code: string) =>
      (sizes[name] = { min: code.length, gzip: gzipSync(code, { level: 9 }).length });
    // The benchmark app: what an app with no opt-in ships.
    measure("jfb", await bundle("jfb", await Bun.file(jfb).text()));
    for (const name of ["plain", "slot", "attach", "imported"] as const) measure(name, await bundle(name, apps[name]));
    if (process.env.UPDATE_SIZES) {
      await Bun.write(budgets, JSON.stringify(sizes, null, 2) + "\n");
      return;
    }
    const budget = (await Bun.file(budgets).json()) as typeof sizes;
    for (const [name, s] of Object.entries(sizes))
      expect({ name, gzip: s.gzip }).toEqual({ name, gzip: Math.min(s.gzip, budget[name]!.gzip) });
  });
});
