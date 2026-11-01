// Ports of Solid 2.0's tests of lists: <For> (keyed by reference, by default), <For keyed={false}>
// and <Repeat>, from packages/web/test/for.spec.tsx, for.nonkeyed.spec.tsx,
// for.nonkeyed.store.spec.tsx and repeat.spec.tsx, and the runtime list functions under them,
// mapArray and repeat, from packages/signals/tests/mapArray.test.ts and repeat.test.ts;
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's <For> keys rows by reference with no key; reactre's needs a key, so a port keys its
// strings by themselves (`key={(x) => x}`), which is the same for strings. Solid's tests share a
// component across a describe ("Create", then the permutations, then "dispose"); the ports keep
// that order, and the last test of each describe disposes. The "multi child" describes insert the
// list before a text node that is already there (Solid's `insert(div, <Component />, marker)`);
// reactre has no public `insert`, so a port mounts the component with `attach`, which appends.
// `innerHTML` is `html()`, which the fake DOM lacks.
//
// for.nonkeyed.spec.tsx's and repeat.spec.tsx's "fragment children" and "array children"
// describes are the "only child" describe's source with the item written twice (the two have the
// same source); they are not ported again.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeElement, type FakeNode, installFakeDocument } from "@reactre/testdom";

import { reaction } from "../../src/features/reaction.ts";
import { createStore } from "../../src/features/store.ts";
import { flush } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import { signal } from "../../src/index.ts";
import { base, compile, type Gap, gap } from "./harness.ts";

beforeEach(installFakeDocument);

/** What a mounted source returns: its setter, its <div>, and its disposer. */
interface Api {
  setList(v: string[]): void;
  div(): FakeElement;
  dispose(): void;
}

/** Compile and run a source ending in `return { ... }`, with `root` and `host` (holding "z") in scope. */
function mount(src: string): Api {
  const host = new FakeElement("DIV");
  host.appendChild(document.createTextNode("z") as unknown as FakeNode);
  return compile<Api>(src, base, { root: new FakeElement("DIV"), host });
}

/** `innerHTML`: elements with their attributes, and text; comments (markers) left out. */
function html(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      const attrs = c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
      out += `<${tag}${attrs}>${html(c)}</${tag}>`;
    } else if (c.nodeType === 3) out += c.textContent;
  }
  return out;
}

/** The elements under `n` with class `cls`, in document order. */
function byClass(n: FakeNode, cls: string, out: FakeElement[] = []): FakeElement[] {
  for (let c = n.firstChild; c !== null; c = c.nextSibling)
    if (c instanceof FakeElement) {
      if (c.getAttribute("class") === cls) out.push(c);
      byClass(c, cls, out);
    }
  return out;
}

const [n1, n2, n3, n4] = ["a", "b", "c", "d"] as const;

/**
 * The permutation tests Solid runs on each list ("1 missing" to "swap backward edge"), over a
 * component that renders `list`: `shown` is what the page shows for a list, `marker` what follows
 * it ("z" in the "multi child" describes). With `kind`, each is a gap of that kind.
 */
function permutations(name: string, src: string, shown: (a: string[]) => string, gapOf?: [Gap, string]): void {
  const it = (title: string, fn: () => void): void => (gapOf ? gap(gapOf[0], gapOf[1], title, fn) : test(title, fn));
  describe(name, () => {
    let t: Api;
    const view = (): string => html(t.div());
    function apply(array: string[]): void {
      t.setList(array);
      flush();
      expect(view()).toBe(shown(array));
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(view()).toBe(shown([n1, n2, n3, n4]));
    }
    it("Create each control flow", () => {
      t = mount(src);
      expect(view()).toBe(shown([n1, n2, n3, n4]));
    });
    it("1 missing", () => {
      apply([n2, n3, n4]);
      apply([n1, n3, n4]);
      apply([n1, n2, n4]);
      apply([n1, n2, n3]);
    });
    it("2 missing", () => {
      apply([n3, n4]);
      apply([n2, n4]);
      apply([n2, n3]);
      apply([n1, n4]);
      apply([n1, n3]);
      apply([n1, n2]);
    });
    it("3 missing", () => {
      apply([n1]);
      apply([n2]);
      apply([n3]);
      apply([n4]);
    });
    it("all missing", () => apply([]));
    it("swaps", () => {
      apply([n2, n1, n3, n4]);
      apply([n3, n2, n1, n4]);
      apply([n4, n2, n3, n1]);
    });
    it("rotations", () => {
      apply([n2, n3, n4, n1]);
      apply([n3, n4, n1, n2]);
      apply([n4, n1, n2, n3]);
    });
    it("reversal", () => apply([n4, n3, n2, n1]));
    it("full replace", () => apply(["e", "f", "g", "h"]));
    it("swap backward edge", () => {
      t.setList(["milk", "bread", "chips", "cookie", "honey"]);
      flush();
      t.setList(["chips", "bread", "cookie", "milk", "honey"]);
      flush();
      t.dispose();
    });
  });
}

/** A source whose component is `<div>` holding `list`, written as `jsx`. */
const onlyChild = (imports: string, jsx: string): string => `
  import { attach, ${imports}, signal } from "@reactre/core";
  const [list, setList] = signal(["a", "b", "c", "d"]);
  let div;
  const Component = () => <div ref={(el) => (div = el)}>${jsx}</div>;
  return { setList, div: () => div, dispose: attach(Component, root) };
`;

/** A source whose component is `list`, written as `jsx`, mounted into `host` after its "z". */
const multiChild = (imports: string, jsx: string): string => `
  import { attach, ${imports}, signal } from "@reactre/core";
  const [list, setList] = signal(["a", "b", "c", "d"]);
  const Component = () => ${jsx};
  return { setList, div: () => host, dispose: attach(Component, host) };
`;

const joined = (a: string[]): string => a.join("");
const doubled = (a: string[]): string => a.map((p) => `${p}${p}`).join("");
const rowShape = (what: string): [Gap, string] => ["row-shape", `a ${what} row is refused`];
const placement: [Gap, string] = ["for-placement", "a list that is a component's whole view is refused"];

/** The "fallback", "maps to undefined" and "indexes" describes, over an empty list and `jsx`. */
const empty = (imports: string, jsx: string): string => `
  import { attach, ${imports}, signal } from "@reactre/core";
  const [list, setList] = signal([]);
  let div;
  const Component = () => <div ref={(el) => (div = el)}>${jsx}</div>;
  return { setList, div: () => div, dispose: attach(Component, root) };
`;

// #region for.spec.tsx

describe("for.spec.tsx", () => {
  permutations(
    "Testing an only child each control flow",
    onlyChild("For", `<For each={list()} key={(x) => x}>{(item) => item}</For>`),
    joined,
    rowShape("text"),
  );
  permutations(
    "Testing an multi child each control flow",
    multiChild("For", `<For each={list()} key={(x) => x}>{(item) => item}</For>`),
    (a) => `${joined(a)}z`,
    placement,
  );
  permutations(
    "Testing an only child each control flow with fragment children",
    onlyChild("For", `<For each={list()} key={(x) => x}>{(item) => <>{item}{item}</>}</For>`),
    doubled,
    rowShape("fragment"),
  );
  permutations(
    "Testing an only child each control flow with array children",
    onlyChild("For", `<For each={list()} key={(x) => x}>{(item) => [item, item]}</For>`),
    doubled,
    rowShape("array"),
  );

  describe("Testing each control flow with fallback", () => {
    gap("row-shape", "a text row is refused", "Create each control flow", () => {
      const t = mount(empty("For", `<For each={list()} key={(x) => x} fallback={"Empty"}>{(item) => item}</For>`));
      expect(html(t.div())).toBe("Empty");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe("abcd");
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("Empty");
      t.dispose();
    });
  });

  describe("Testing each that maps to undefined", () => {
    gap("row-shape", "a row of undefined is refused", "Create each control flow", () => {
      const t = mount(empty("For", `<For each={list()} key={(x) => x}>{(item) => undefined}</For>`));
      expect(html(t.div())).toBe("");
      t.setList([n1, n2, n3, n4]);
      expect(html(t.div())).toBe("");
      t.setList([]);
      expect(html(t.div())).toBe("");
      t.dispose();
    });
  });

  describe("Testing each with indexes", () => {
    gap("for-index", "a keyed row gets no index", "Create each control flow", () => {
      const t = mount(
        empty(
          "For",
          `<For each={list()} key={(x) => x} fallback={"Hi"}>{(item, i) => <span>{item + i()}</span>}</For>`,
        ),
      );
      expect(html(t.div())).toBe("Hi");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe("<span>a0</span><span>b1</span><span>c2</span><span>d3</span>");
      t.setList([n2, n3, n4, n1]);
      flush();
      expect(html(t.div())).toBe("<span>b0</span><span>c1</span><span>d2</span><span>a3</span>");
      t.setList([n3, n4, n1]);
      flush();
      expect(html(t.div())).toBe("<span>c0</span><span>d1</span><span>a2</span>");
      t.setList([n3, n2, n4, n1]);
      flush();
      expect(html(t.div())).toBe("<span>c0</span><span>b1</span><span>d2</span><span>a3</span>");
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("Hi");
      t.setList([n1]);
      flush();
      expect(html(t.div())).toBe("<span>a0</span>");
      t.dispose();
    });
  });
});

// #endregion

// #region for.nonkeyed.spec.tsx

describe("for.nonkeyed.spec.tsx", () => {
  permutations(
    "Testing an only child each control flow",
    onlyChild("For", `<For each={list()} keyed={false}>{(item) => <>{item()}</>}</For>`),
    joined,
    rowShape("fragment"),
  );
  permutations(
    "Testing an multi child each control flow",
    multiChild("For", `<For each={list()} keyed={false}>{(item) => <>{item()}</>}</For>`),
    (a) => `${joined(a)}z`,
    placement,
  );

  describe("Testing each control flow with fallback", () => {
    gap("row-shape", "a fragment row is refused", "Create each control flow", () => {
      const t = mount(
        empty("For", `<For each={list()} fallback={"Empty"} keyed={false}>{(item) => <>{item()}</>}</For>`),
      );
      expect(html(t.div())).toBe("Empty");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe("abcd");
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("Empty");
      t.dispose();
    });
  });

  describe("Testing each that maps to undefined", () => {
    gap("row-shape", "a row of undefined is refused", "Create each control flow", () => {
      const t = mount(empty("For", `<For each={list()} keyed={false}>{(item) => undefined}</For>`));
      expect(html(t.div())).toBe("");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe("");
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("");
      t.dispose();
    });
  });

  describe("Testing each with indexes", () => {
    test("Create each control flow", () => {
      const t = mount(empty("For", `<For each={list()} keyed={false}>{(item, i) => <span>{item() + i}</span>}</For>`));
      expect(html(t.div())).toBe("");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe("<span>a0</span><span>b1</span><span>c2</span><span>d3</span>");
      t.setList([n2, n3, n4, n1]);
      flush();
      expect(html(t.div())).toBe("<span>b0</span><span>c1</span><span>d2</span><span>a3</span>");
      t.setList([n3, n4, n1]);
      flush();
      expect(html(t.div())).toBe("<span>c0</span><span>d1</span><span>a2</span>");
      t.setList([n3, n2, n4, n1]);
      flush();
      expect(html(t.div())).toBe("<span>c0</span><span>b1</span><span>d2</span><span>a3</span>");
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("");
      t.dispose();
    });
  });
});

// #endregion

// #region for.nonkeyed.store.spec.tsx

describe("<For keyed={false}> backed by a store (#2687)", () => {
  test("item() and store[i()] both reflect per-index store writes", () => {
    const root = new FakeElement("DIV");
    const t = compile<{ setStore: (fn: (x: string[]) => void) => void; dispose: () => void }>(
      `
      import { attach, For } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [store, setStore] = createStore(["a", "b", "c"]);
      const dispose = attach(
        () => (
          <div>
            <For each={store} keyed={false}>
              {(item, i) => (
                <div>
                  <span class="item">{item()}</span>
                  <span class="store">{store[i]}</span>
                </div>
              )}
            </For>
          </div>
        ),
        root,
      );
      return { setStore, dispose };
      `,
      base,
      { root },
    );
    const read = (): { items: string[]; stores: string[] } => ({
      items: byClass(root, "item").map((n) => n.textContent ?? ""),
      stores: byClass(root, "store").map((n) => n.textContent ?? ""),
    });
    flush();
    expect(read()).toEqual({ items: ["a", "b", "c"], stores: ["a", "b", "c"] });
    t.setStore((x) => {
      x[0] = "x";
    });
    flush();
    expect(read()).toEqual({ items: ["x", "b", "c"], stores: ["x", "b", "c"] });
    t.setStore((x) => {
      x[0] = "xy";
    });
    flush();
    expect(read()).toEqual({ items: ["xy", "b", "c"], stores: ["xy", "b", "c"] });
    t.dispose();
  });
});

// #endregion

// #region repeat.spec.tsx

describe("repeat.spec.tsx", () => {
  permutations(
    "Testing an only child each control flow",
    onlyChild("Repeat", `<Repeat count={list().length}>{(i) => <>{list()[i]}</>}</Repeat>`),
    joined,
    rowShape("fragment"),
  );
  permutations(
    "Testing an multi child each control flow",
    multiChild("Repeat", `<Repeat count={list().length}>{(i) => <>{list()[i]}</>}</Repeat>`),
    (a) => `${joined(a)}z`,
    placement,
  );

  describe("Testing each control flow with fallback", () => {
    gap("row-shape", "a fragment row is refused", "Create each control flow", () => {
      const t = mount(
        empty("Repeat", `<Repeat count={list().length} fallback={"Empty"}>{(i) => <>{list()[i]}</>}</Repeat>`),
      );
      expect(html(t.div())).toBe("Empty");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe("abcd");
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("Empty");
      t.dispose();
    });
  });

  describe("Testing each that maps to undefined", () => {
    gap("row-shape", "a row of undefined is refused", "Create each control flow", () => {
      const t = mount(empty("Repeat", `<Repeat count={list().length}>{(i) => undefined}</Repeat>`));
      expect(html(t.div())).toBe("");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe("");
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("");
      t.dispose();
    });
  });

  describe("Testing each without callback", () => {
    gap("row-shape", "an element child (no row function) is refused", "Create each control flow", () => {
      const t = mount(empty("Repeat", `<Repeat count={list().length}><span>Hello</span></Repeat>`));
      const hello = (k: number): string => "<span>Hello</span>".repeat(k);
      expect(html(t.div())).toBe("");
      t.setList([n1, n2, n3, n4]);
      flush();
      expect(html(t.div())).toBe(hello(4));
      t.setList([n2, n3, n4, n1]);
      flush();
      expect(html(t.div())).toBe(hello(4));
      t.setList([n3, n4, n1]);
      flush();
      expect(html(t.div())).toBe(hello(3));
      t.setList([n3, n2, n4, n1]);
      flush();
      expect(html(t.div())).toBe(hello(4));
      t.setList([]);
      flush();
      expect(html(t.div())).toBe("");
      t.dispose();
    });
  });

  gap("row-shape", "an element child (no row function) is refused", "element children run once per row", () => {
    const t = compile<{
      runs: () => number;
      setCount: (n: number) => void;
      div: () => FakeElement;
      dispose: () => void;
    }>(
      `
      import { attach, Repeat, signal } from "@reactre/core";
      let runs = 0;
      let div;
      const [count, setCount] = signal(1);
      const dispose = attach(
        () => (
          <div ref={(el) => (div = el)}>
            <Repeat count={count()}>
              <span ref={() => runs++}>x</span>
            </Repeat>
          </div>
        ),
        root,
      );
      return { runs: () => runs, setCount, div: () => div, dispose };
      `,
      base,
      { root: new FakeElement("DIV") },
    );
    expect(t.runs()).toBe(1);
    expect(html(t.div())).toBe("<span>x</span>");
    t.setCount(3);
    flush();
    expect(t.runs()).toBe(3);
    expect(html(t.div())).toBe("<span>x</span><span>x</span><span>x</span>");
    t.dispose();
  });
});

// #endregion

// #region mapArray.test.ts and repeat.test.ts

/** Solid's mapArray and repeat, as reactre would export them beside <For> and <Repeat>; it has neither. */
const lists = core as unknown as {
  mapArray<T, U>(
    list: () => readonly T[],
    map: (value: T, index: () => number) => U,
    options?: { keyed?: boolean | ((item: T) => unknown) },
  ): () => U[];
  repeat<U>(count: () => number, map: (index: number) => U, options?: { from?: () => number }): () => U[];
};

const why = "reactre's lists are compiled <For> and <Repeat>, with no runtime function";

describe("mapArray.test.ts", () => {
  gap("list-functions", why, "should compute keyed map", () => {
    const [$source, setSource] = signal([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const computed = mock();
    const map = lists.mapArray($source, (value, index) => {
      computed();
      return {
        get id() {
          return value.id;
        },
        get index() {
          return index();
        },
      };
    });
    const [a, b, c] = map();
    expect([a?.id, a?.index, b?.id, b?.index, c?.id, c?.index]).toEqual(["a", 0, "b", 1, "c", 2]);
    expect(computed).toHaveBeenCalledTimes(3);
    // Move values around
    setSource((p) => {
      const tmp = p[1]!;
      p[1] = p[0]!;
      p[0] = tmp;
      return [...p];
    });
    flush();
    const [a2, b2, c2] = map();
    expect([a2?.id, a2?.index, b2?.id, b2?.index, c2?.id, c2?.index]).toEqual(["b", 0, "a", 1, "c", 2]);
    expect(a === b2 && b === a2 && c === c2).toBe(true);
    expect(computed).toHaveBeenCalledTimes(3);
    // Add new value
    setSource((p) => [...p, { id: "d" }]);
    flush();
    expect(map().length).toBe(4);
    expect(map()[3]?.id).toBe("d");
    expect(map()[3]?.index).toBe(3);
    expect(computed).toHaveBeenCalledTimes(4);
    // Remove value
    setSource((p) => p.slice(1));
    flush();
    expect(map().length).toBe(3);
    expect(map()[0]?.id).toBe("a");
    expect(map()[0] === b2 && map()[0] === a).toBe(true);
    expect(computed).toHaveBeenCalledTimes(4);
    // Empty
    setSource([]);
    flush();
    expect(map().length).toBe(0);
    expect(computed).toHaveBeenCalledTimes(4);
  });

  gap("list-functions", why, "should notify observer", () => {
    const [$source, setSource] = signal([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const map = lists.mapArray($source, (value) => ({
      get id() {
        return value.id;
      },
    }));
    const effect = mock();
    reaction(map, effect);
    flush();
    setSource((prev) => prev.slice(1));
    flush();
    expect(effect).toHaveBeenCalledTimes(2);
  });

  gap("list-functions", why, "should compute map when key by index", () => {
    const [$source, setSource] = signal([1, 2, 3]);
    const computed = mock();
    const map = lists.mapArray(
      $source,
      (value, index) => {
        computed();
        return {
          get id() {
            return (value as unknown as () => number)() * 2;
          },
          get index() {
            return index as unknown as number;
          },
        };
      },
      { keyed: false },
    );
    const [a, b, c] = map();
    expect([a?.index, a?.id, b?.index, b?.id, c?.index, c?.id]).toEqual([0, 2, 1, 4, 2, 6]);
    expect(computed).toHaveBeenCalledTimes(3);
    // Move values around
    setSource([3, 2, 1]);
    flush();
    const [a2, b2, c2] = map();
    expect([a2?.index, a2?.id, b2?.index, b2?.id, c2?.index, c2?.id]).toEqual([0, 6, 1, 4, 2, 2]);
    expect(a === a2 && b === b2 && c === c2).toBe(true);
    expect(computed).toHaveBeenCalledTimes(3);
    // Add new value
    setSource([3, 2, 1, 4]);
    flush();
    expect(map().length).toBe(4);
    expect(map()[3]?.index).toBe(3);
    expect(map()[3]?.id).toBe(8);
    expect(computed).toHaveBeenCalledTimes(4);
    // Remove value
    setSource([2, 1, 4]);
    flush();
    expect(map().length).toBe(3);
    expect(map()[0]?.id).toBe(4);
    // Empty
    setSource([]);
    flush();
    expect(map().length).toBe(0);
    expect(computed).toHaveBeenCalledTimes(4);
  });
});

describe("repeat.test.ts", () => {
  gap("list-functions", why, "should compute keyed map", () => {
    const [source, setSource] = createStore<{ id: string }[]>([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const computed = mock();
    const map = lists.repeat(
      () => source.length,
      (index) => {
        computed();
        return {
          get id() {
            return source[index]!.id;
          },
          get index() {
            return index;
          },
        };
      },
    );
    const [a, b, c] = map();
    expect([a?.id, a?.index, b?.id, b?.index, c?.id, c?.index]).toEqual(["a", 0, "b", 1, "c", 2]);
    expect(computed).toHaveBeenCalledTimes(3);
    // Move values around
    setSource((p) => {
      [p[0], p[1]] = [p[1]!, p[0]!];
    });
    flush();
    const [a2, b2, c2] = map();
    expect([a2?.id, a2?.index, b2?.id, b2?.index, c2?.id, c2?.index]).toEqual(["b", 0, "a", 1, "c", 2]);
    expect(a === a2 && b === b2 && c === c2).toBe(true);
    expect(computed).toHaveBeenCalledTimes(3);
    // Add new value
    setSource((p) => {
      p.push({ id: "d" });
    });
    flush();
    expect(map().length).toBe(4);
    expect(map()[3]?.id).toBe("d");
    expect(map()[3]?.index).toBe(3);
    expect(computed).toHaveBeenCalledTimes(4);
    // Remove value
    setSource((p) => {
      p.pop();
    });
    flush();
    expect(map().length).toBe(3);
    expect(map()[0]?.id).toBe("b");
    expect(map()[0] === a2 && map()[0] === a).toBe(true);
    expect(computed).toHaveBeenCalledTimes(4);
    // Empty
    setSource((p) => {
      p.length = 0;
    });
    flush();
    expect(map().length).toBe(0);
    expect(computed).toHaveBeenCalledTimes(4);
  });

  gap("list-functions", why, "should notify observer", () => {
    const [source, setSource] = createStore([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const map = lists.repeat(
      () => source.length,
      (index) => ({
        get id() {
          return source[index]!.id;
        },
      }),
    );
    const effect = mock();
    reaction(map, effect);
    flush();
    setSource((prev) => {
      prev.pop();
    });
    flush();
    expect(effect).toHaveBeenCalledTimes(2);
  });
});

// #endregion
