// Tests of reactre and @reactre/compiler on the fake DOM: TSX sources written
// here are compiled as the plugin compiles them and run against the runtime.
// They cover holes that follow signals, components and slots, batch, memo and
// untrack, and <For>: node reuse, selector updates, delegated handlers and
// row subscriptions; selectors read outside lists, __insert's flattening and an
// uncompiled <For>. Compile errors are checked last.

import { beforeEach, describe, expect, test } from "bun:test";

import { compileSource, ReactreCompileError } from "@reactre/compiler";
import { FakeElement, FakeEvent, FakeText, installFakeDocument } from "@reactre/testdom";

import * as runtime from "../src/index.ts";

beforeEach(installFakeDocument);

// Compile this file's own TSX test source (a module body ending in `return { ... }`)
// and run it with the runtime, `root` in scope.
function run<T>(src: string, root: FakeElement): T {
  // new Function cannot import: each `import { a, b as c } from "@reactre/core"`
  // becomes `const` bindings to the runtime passed in as `rr`.
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

// Serializes tags, classes and text: enough to compare what was rendered.
const html = (n: FakeElement): string => {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const cls = c.getAttribute("class");
      const tag = c.tagName.toLowerCase();
      out += `<${tag}${cls ? ` class="${cls}"` : ""}>${html(c)}</${tag}>`;
    } else out += c.textContent;
  }
  return out;
};
const click = (n: unknown): void => void (n as FakeElement).dispatchEvent(new FakeEvent("click"));
// A root inside a fake document, so the DOM under it is connected as in a page.
const box = (): FakeElement => {
  const doc = new FakeElement("HTML");
  doc.isDocument = true;
  const root = new FakeElement("DIV");
  doc.appendChild(root);
  return root;
};

describe("reactre: elements and signals", () => {
  test("a hole that reads a signal follows it; the rest is written once, and components run once", () => {
    const root = box();
    const api = run<{ setName: (s: string) => void; setOn: (b: boolean) => void; renders: () => number }>(
      `
      import { render, signal } from "@reactre/core";
      const [name, setName] = signal("a");
      const [on, setOn] = signal(false);
      let renders = 0;
      function App() {
        renders++;
        const fixed = "static";
        return <p class={on() ? "on" : "off"}><b>{name()}</b><i>{fixed}</i></p>;
      }
      render(App, root);
      return { setName, setOn, renders: () => renders };
    `,
      root,
    );
    expect(html(root)).toBe('<p class="off"><b>a</b><i>static</i></p>');
    const p = root.firstChild;
    api.setName("b");
    api.setOn(true);
    expect(html(root)).toBe('<p class="on"><b>b</b><i>static</i></p>');
    expect(root.firstChild).toBe(p);
    expect(api.renders()).toBe(1);
  });

  test("components take props once; handlers on elements outside lists are listeners", () => {
    const root = box();
    const api = run<{ count: () => number }>(
      `
      import { render, signal } from "@reactre/core";
      const [count, setCount] = signal(0);
      function Button({ label, onClick }) {
        return <button onClick={onClick}>{label}</button>;
      }
      function App() {
        return <div><Button label="up" onClick={() => setCount((c) => c + 1)} /><span>{count()}</span></div>;
      }
      render(App, root);
      return { count };
    `,
      root,
    );
    const div = root.firstChild as FakeElement;
    click(div.firstChild);
    click(div.firstChild);
    expect(api.count()).toBe(2);
    expect(html(root)).toBe("<div><button>up</button><span>2</span></div>");
  });

  test("an expression holding JSX is a slot that follows what it reads", () => {
    const root = box();
    const api = run<{ setShow: (b: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [show, setShow] = signal(true);
      function App() {
        return <div>{show() ? <b>yes</b> : <i>no</i>}<hr /></div>;
      }
      render(App, root);
      return { setShow };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>yes</b><hr></hr></div>");
    api.setShow(false);
    expect(html(root)).toBe("<div><i>no</i><hr></hr></div>");
  });

  test("batch runs each effect once, at its end; memo and untrack", () => {
    const [a, setA] = runtime.signal(1);
    const [b, setB] = runtime.signal(2);
    const sum = runtime.memo(() => a() + b());
    const seen: number[] = [];
    runtime.effect(() => void seen.push(sum()));
    runtime.batch(() => {
      setA(10);
      setB(20);
    });
    expect(seen).toEqual([3, 30]);
    let runs = 0;
    runtime.effect(() => {
      runs++;
      runtime.untrack(a);
    });
    setA(11);
    expect(runs).toBe(1);
  });
});

// The benchmark's shape: a keyed list of rows, a selection, row handlers.
const LIST = `
  import { For, render, selector, signal } from "@reactre/core";
  const [rows, setRows] = signal([]);
  const [selected, setSelected] = signal(0);
  const [suffix, setSuffix] = signal("");
  const isSelected = selector(selected);
  let calls = 0;
  const label = (row) => (calls++, row.label + suffix());
  const removed = [];
  function App() {
    return (
      <table><tbody>
        <For each={rows()} key={(row) => row.id}>
          {(row) => (
            <tr class={isSelected(row.id) ? "danger" : ""}>
              <td>{row.id}</td>
              <td><a onClick={() => setSelected(row.id)}>{row.label}</a></td>
              <td><a onClick={() => (removed.push(row.id), setRows((r) => r.filter((x) => x.id !== row.id)))}><span>x</span></a></td>
              <td>{label(row)}</td>
            </tr>
          )}
        </For>
      </tbody></table>
    );
  }
  render(App, root);
  return { rows, setRows, setSelected, setSuffix, calls: () => calls, removed };
`;
type ListApi = {
  rows: () => { id: number; label: string }[];
  setRows: (
    r: { id: number; label: string }[] | ((r: { id: number; label: string }[]) => { id: number; label: string }[]),
  ) => void;
  setSelected: (id: number) => void;
  setSuffix: (s: string) => void;
  calls: () => number;
  removed: number[];
};
const make = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i, label: "r" + (from + i) }));

describe("reactre: <For>", () => {
  const setup = () => {
    const root = box();
    const api = run<ListApi>(LIST, root);
    const tbody = (root.firstChild as FakeElement).firstChild as FakeElement;
    const trs = () => [...tbody.childNodes] as FakeElement[];
    return { root, api, tbody, trs };
  };

  test("rows mount in order and keep their nodes when the list changes", () => {
    const { api, tbody, trs } = setup();
    api.setRows(make(5));
    expect(trs().map((tr) => tr.firstChild!.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    const nodes = trs();
    // Swap the second and fourth.
    api.setRows((r) => {
      const x = r.slice();
      [x[1], x[3]] = [x[3]!, x[1]!];
      return x;
    });
    expect(trs().map((tr) => tr.firstChild!.textContent)).toEqual(["1", "4", "3", "2", "5"]);
    expect(trs()).toEqual([0, 3, 2, 1, 4].map((i) => nodes[i]!));
    // A new item for a key: its holes are compared and written in place.
    api.setRows((r) => r.map((x) => (x.id === 3 ? { id: 3, label: "changed" } : x)));
    expect((trs()[2]!.childNodes[1] as FakeElement).textContent).toBe("changed");
    expect(trs()[2]).toBe(nodes[2]);
    api.setRows([]);
    expect(tbody.childNodes.length).toBe(0);
  });

  test("the selection re-renders only the rows it leaves and enters", () => {
    const { api, trs } = setup();
    api.setRows(make(50));
    const before = api.calls();
    api.setSelected(7);
    expect(trs()[6]!.getAttribute("class")).toBe("danger");
    api.setSelected(9);
    expect(trs()[6]!.getAttribute("class") ?? "").toBe("");
    expect(trs()[8]!.getAttribute("class")).toBe("danger");
    // Each change re-ran the reactive holes of the rows it left and entered:
    // one for the first (no row had key 0), two for the second.
    expect(api.calls() - before).toBe(3);
  });

  test("row handlers are delegated and get their own row", () => {
    const { api, trs } = setup();
    api.setRows(make(5));
    click((trs()[2]!.childNodes[1] as FakeElement).firstChild);
    expect(trs()[2]!.getAttribute("class")).toBe("danger");
    // A click on the span inside the remove link reaches the link's handler.
    click(((trs()[3]!.childNodes[2] as FakeElement).firstChild as FakeElement).firstChild);
    expect(api.removed).toEqual([4]);
    expect(trs().map((tr) => tr.firstChild!.textContent)).toEqual(["1", "2", "3", "5"]);
  });

  test("a row that reads a signal follows it, and stops when it leaves the list", () => {
    const { api, trs } = setup();
    api.setRows(make(3));
    api.setSuffix("!");
    expect(trs().map((tr) => tr.lastChild!.textContent)).toEqual(["r1!", "r2!", "r3!"]);
    api.setRows(make(1));
    const before = api.calls();
    api.setSuffix("?");
    // Only the remaining row re-ran.
    expect(api.calls() - before).toBe(1);
    expect(trs()[0]!.lastChild!.textContent).toBe("r1?");
  });
});

describe("reactre: runtime helpers", () => {
  test("a selector read by an effect re-runs it only when its key gains or loses the selection", () => {
    const [sel, setSel] = runtime.signal<string>("x");
    const is = runtime.selector(sel);
    const runs: string[] = [];
    runtime.effect(() => void runs.push("a " + is("a")));
    runtime.effect(() => void runs.push("b " + is("b")));
    runtime.effect(() => void runs.push("b again " + is("b")));
    setSel("a");
    setSel("c");
    expect(runs).toEqual(["a false", "b false", "b again false", "a true", "a false"]);
    setSel("b");
    expect(runs.slice(5)).toEqual(["b true", "b again true"]);
  });

  test("__insert places text for values and nodes as they are, flattening arrays and skipping holes", () => {
    const parent = new FakeElement("P");
    const anchor = parent.appendChild(new FakeText(""));
    const node = new FakeElement("B");
    const at = (v: unknown, prev: unknown[] | null) =>
      runtime.__insert(anchor as unknown as Node, v, prev as Node[] | null) as unknown[] | null;
    const out = at(["a", [1, null, [false, node]], true, undefined], null);
    expect(html(parent)).toBe("a1<b></b>");
    expect(out).toHaveLength(3);
    expect(at(false, out)).toBeNull();
    expect(html(parent)).toBe("");
  });

  test("<For> run without the compiler says it must be compiled", () => {
    expect(() => runtime.For({ each: [], key: (r) => r, children: () => null })).toThrow(
      "reactre: <For> must be compiled by @reactre/compiler",
    );
  });
});

describe("@reactre/compiler: errors", () => {
  test("constructs it does not compile are errors, not a runtime fallback", () => {
    expect(() => compileSource(`const x = <><b /></>;`)).toThrow(ReactreCompileError);
    expect(() => compileSource(`const p = {}; const x = <b {...p} />;`)).toThrow(ReactreCompileError);
    expect(() => compileSource(`const x = <For each={[]} key={(r) => r}>{(r) => <b />}</For>;`)).toThrow(
      ReactreCompileError,
    );
  });
});
