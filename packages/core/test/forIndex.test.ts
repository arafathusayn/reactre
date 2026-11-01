// `<For each keyed={false}>`, rows by position (@reactre/core/features/index), and `keyed` as a
// key function: compiled as the plugin compiles them and run on the fake DOM. A row by position
// is built once per index; a new item at its index re-runs only the holes that read `item()`.

import { beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";

import * as indexFeature from "../src/features/index.ts";
import * as storeFeature from "../src/features/store.ts";
import * as runtime from "../src/index.ts";

beforeEach(installFakeDocument);

/** The modules a test source may import from, by specifier. */
const modules: Record<string, unknown> = {
  "@reactre/core": runtime,
  "@reactre/core/features/index": indexFeature,
  "@reactre/core/features/store": storeFeature,
};

/**
 * Compile a TSX test source (a module body ending in `return { ... }`) and run it with the
 * runtime, `root` in scope. Imports from @reactre/core and its features become bindings to them.
 */
function run<T>(src: string, root: FakeElement): T {
  const js = compileSource(src).replace(
    /^import \{([^}]*)\} from "(@reactre\/core[^"]*)";$/gm,
    (_, names: string, from: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr[${JSON.stringify(from)}].${a};`;
        })
        .join("\n"),
  );
  return new Function("rr", "root", js)(modules, root) as T;
}

const kids = (n: FakeElement): FakeElement[] => n.childNodes as FakeElement[];
const texts = (n: FakeElement): string[] => kids(n).map((c) => c.textContent ?? "");

describe("<For keyed={false}>", () => {
  test("rows by position: a new item updates its row in place; the list grows and shrinks at its end", () => {
    const root = new FakeElement("DIV");
    const api = run<{ set: (v: string[]) => void; runs: () => number }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [names, set] = signal(["a", "b", "c"]);
      let runs = 0;
      render(() => (
        <ul>
          <For each={names()} keyed={false}>
            {(name, i) => <li class={i % 2 ? "odd" : "even"}>{i}:{(runs++, name())}</li>}
          </For>
        </ul>
      ), root);
      return { set, runs: () => runs };
    `,
      root,
    );
    const ul = root.firstChild as FakeElement;
    expect(texts(ul)).toEqual(["0:a", "1:b", "2:c"]);
    expect(kids(ul).map((li) => li.getAttribute("class"))).toEqual(["even", "odd", "even"]);
    const [first, second] = kids(ul);
    // A new array with the same items at 0 and 2: only row 1 runs again, and no row is rebuilt.
    api.set(["a", "B", "c"]);
    expect(texts(ul)).toEqual(["0:a", "1:B", "2:c"]);
    expect(api.runs()).toBe(4);
    expect(kids(ul)[0]).toBe(first!);
    expect(kids(ul)[1]).toBe(second!);
    // Reversed: each row keeps its element, and takes the item now at its index.
    api.set(["c", "B", "a"]);
    expect(texts(ul)).toEqual(["0:c", "1:B", "2:a"]);
    expect(kids(ul)[0]).toBe(first!);
    api.set(["x"]);
    expect(texts(ul)).toEqual(["0:x"]);
    api.set(["x", "y", "z", "w"]);
    expect(texts(ul)).toEqual(["0:x", "1:y", "2:z", "3:w"]);
    expect(kids(ul)[0]).toBe(first!);
    api.set([]);
    expect(texts(ul)).toEqual([]);
  });

  test("a row's handler reads its position's current item; a row of one parameter, beside other content", () => {
    const root = new FakeElement("DIV");
    const api = run<{ set: (v: { n: number }[]) => void; got: number[] }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [items, set] = signal([{ n: 1 }, { n: 2 }]);
      const got = [];
      render(() => (
        <ul>
          <li>head</li>
          <For each={items()} keyed={false}>
            {(item) => <li onClick={() => got.push(item().n)}>{item().n}</li>}
          </For>
        </ul>
      ), root);
      return { set, got };
    `,
      root,
    );
    const ul = root.firstChild as FakeElement;
    // The rows, then the list's anchor.
    expect(texts(ul)).toEqual(["head", "1", "2", ""]);
    api.set([{ n: 3 }, { n: 2 }]);
    kids(ul)[1]!.dispatchEvent(new FakeEvent("click"));
    expect(api.got).toEqual([3]);
    expect(texts(ul)).toEqual(["head", "3", "2", ""]);
  });

  test("a component in a row is built once per position, its props following the item; with a fallback", () => {
    const root = new FakeElement("DIV");
    const api = run<{ set: (v: string[]) => void; builds: () => number }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [names, set] = signal(["a"]);
      let builds = 0;
      function Label(props) { builds++; return <b>{props.text}</b>; }
      render(() => (
        <ul>
          <For each={names()} keyed={false} fallback={<li>none</li>}>
            {(name, i) => <li><Label text={name() + i} /></li>}
          </For>
        </ul>
      ), root);
      return { set, builds: () => builds };
    `,
      root,
    );
    const ul = root.firstChild as FakeElement;
    expect(texts(ul)).toEqual(["a0", ""]);
    api.set(["b", "c"]);
    expect(texts(ul).filter(Boolean)).toEqual(["b0", "c1"]);
    expect(api.builds()).toBe(2);
    api.set([]);
    expect(texts(ul).filter(Boolean)).toEqual(["none"]);
  });

  test("over a store: in-place writes to an item and new items at a position both show", () => {
    const root = new FakeElement("DIV");
    const api = run<{ rename: (i: number, t: string) => void; replace: (i: number, t: string) => void }>(
      `
      import { For, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ todos: [{ title: "a" }, { title: "b" }] });
      render(() => (
        <ul>
          <For each={s.todos} keyed={false}>{(t) => <li>{t().title}</li>}</For>
        </ul>
      ), root);
      return {
        rename: (i, title) => set((d) => { d.todos[i].title = title; }),
        replace: (i, title) => set((d) => { d.todos[i] = { title }; }),
      };
    `,
      root,
    );
    const ul = root.firstChild as FakeElement;
    api.rename(0, "A");
    expect(texts(ul)).toEqual(["A", "b"]);
    api.replace(1, "B");
    expect(texts(ul)).toEqual(["A", "B"]);
  });
});

describe("<For keyed={fn}>", () => {
  test("is key: rows by key, reused across moves", () => {
    const root = new FakeElement("DIV");
    const api = run<{ set: (v: { id: number; t: string }[]) => void }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [rows, set] = signal([{ id: 1, t: "a" }, { id: 2, t: "b" }]);
      render(() => <ul><For each={rows()} keyed={(r) => r.id}>{(r) => <li>{r.t}</li>}</For></ul>, root);
      return { set };
    `,
      root,
    );
    const ul = root.firstChild as FakeElement;
    const [a, b] = kids(ul);
    api.set([
      { id: 2, t: "B" },
      { id: 1, t: "a" },
    ]);
    expect(texts(ul)).toEqual(["B", "a"]);
    expect(kids(ul)).toEqual([b!, a!]);
  });
});

describe("compiling keyed", () => {
  const list = (props: string, row = "(r) => <li>{r}</li>") =>
    `import { For } from "@reactre/core"; export const A = () => <ul><For each={xs()} ${props}>{${row}}</For></ul>;`;

  test("keyed={fn} compiles as key={fn}, and a keyed list as before, without the feature's import", () => {
    const keyed = compileSource(list("keyed={(r) => r.id}"));
    expect(keyed).toBe(compileSource(list("key={(r) => r.id}")));
    expect(keyed).not.toContain("features/index");
    expect(compileSource(list("keyed={function (r) { return r.id; }}"))).toContain("key: function");
  });

  test("keyed={false} imports the feature, and gives the row its cell's accessor and index", () => {
    const js = compileSource(list("keyed={false}", "(item, i) => <li>{i}{item()}</li>"));
    expect(js).toContain('import { __index as __rrIndex } from "@reactre/core/features/index";');
    expect(js).toContain("__rrIndex({ each: () => (xs()), t: ");
    expect(js).toContain("fill: ({ v: item, i: i }, __v)");
    expect(js).not.toContain("key:");
  });

  test("keyed beside key, keyed as anything else, and a row of three parameters do not compile", () => {
    expect(() => compileSource(list("key={(r) => r} keyed={false}"))).toThrow("takes key or keyed, not both");
    expect(() => compileSource(list("keyed={byId}"))).toThrow("keyed must be written as false");
    expect(() => compileSource(list("keyed"))).toThrow("keyed must be written as false");
    expect(() => compileSource(list("keyed={false}", "(a, i, x) => <li />"))).toThrow(
      "row must be (item, i) => its content",
    );
  });
});
