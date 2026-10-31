// Tests of reactre and @reactre/compiler on the fake DOM: TSX sources written
// here are compiled as the plugin compiles them and run against the runtime.
// They cover holes that follow signals, components and slots, batch, memo and
// untrack, and <For>: node reuse, selector updates, delegated handlers and
// row subscriptions; selectors read outside lists, __insert's flattening and an
// uncompiled <For>. Compile errors are checked last.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { compileSource, ReactreCompileError } from "@reactre/compiler";
import { FakeElement, FakeEvent, FakeText, installFakeDocument, withStyles } from "@reactre/testdom";

import * as runtime from "../src/index.ts";

beforeEach(installFakeDocument);

// Compile this file's own TSX test source (a module body ending in `return { ... }`)
// and run it with the runtime, `root` in scope.
function run<T>(src: string, root: FakeElement): T {
  // new Function cannot import: each `import { a, b as c } from "@reactre/core"`
  // becomes `const` bindings to the runtime passed in as `rr`, and a feature module's import its
  // install call.
  const js = compileSource(src)
    .replace(/^import \{([^}]*)\} from "@reactre\/core";$/gm, (_, names: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr.${a};`;
        })
        .join("\n"),
    )
    .replace(/^import "@reactre\/core\/features\/selectors";$/gm, "rr.__installSelectors();");
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
  let selects = 0;
  function App() {
    return (
      <table><tbody>
        <For each={rows()} key={(row) => row.id}>
          {(row) => (
            <tr class={isSelected(row.id) ? "danger" : ""}>
              <td>{row.id}</td>
              <td><a onClick={() => (selects++, setSelected(row.id))}>{row.label}</a></td>
              <td><a onClick={() => (removed.push(row.id), setRows((r) => r.filter((x) => x.id !== row.id)))}><span>x</span></a></td>
              <td>{label(row)}</td>
            </tr>
          )}
        </For>
      </tbody></table>
    );
  }
  render(App, root);
  return { rows, setRows, setSelected, setSuffix, calls: () => calls, removed, selects: () => selects };
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
  selects: () => number;
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
    // One listener per event type: two click handlers per row, but one call per click.
    expect(api.selects()).toBe(1);
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

describe("reactre: selectors", () => {
  test("a row keeps every selector and key it reads", () => {
    const root = box();
    const api = run<{ setSel: (n: number) => void; setHover: (n: number) => void }>(
      `
      import { For, render, selector, signal } from "@reactre/core";
      const [sel, setSel] = signal(0);
      const [hover, setHover] = signal(0);
      const isSel = selector(sel);
      const isHover = selector(hover);
      const rows = [1, 2, 3].map((id) => ({ id }));
      function App() {
        return (
          <ul>
            <For each={rows} key={(r) => r.id}>
              {(r) => (
                <li class={isSel(r.id) ? "sel" : ""} title={isHover(r.id) ? "hover" : "-"}>
                  {isSel(r.id) ? "me" : isSel(r.id + 1) ? "next" : ""}
                </li>
              )}
            </For>
          </ul>
        );
      }
      render(App, root);
      return { setSel, setHover };
    `,
      root,
    );
    const lis = () => [...(root.firstChild as FakeElement).childNodes] as FakeElement[];
    api.setHover(2);
    api.setSel(2);
    expect(lis().map((li) => li.getAttribute("class") ?? "")).toEqual(["", "sel", ""]);
    expect(lis().map((li) => li.getAttribute("title"))).toEqual(["-", "hover", "-"]);
    // Row 1 asked about key 2 as well, so it follows it.
    expect(lis().map((li) => li.textContent)).toEqual(["next", "me", ""]);
    api.setHover(3);
    api.setSel(3);
    expect(lis().map((li) => li.getAttribute("title"))).toEqual(["-", "-", "hover"]);
    expect(lis().map((li) => li.textContent)).toEqual(["", "next", "me"]);
  });

  test("an observer outside a row stops following a key it no longer reads", () => {
    const [sel, setSel] = runtime.signal("x");
    const [asks, setAsks] = runtime.signal(true);
    const is = runtime.selector(sel);
    let runs = 0;
    runtime.effect(() => {
      runs++;
      if (asks()) is("a");
    });
    setAsks(false);
    const before = runs;
    setSel("a");
    setSel("b");
    expect(runs).toBe(before);
  });
});

describe("reactre: rows with slots", () => {
  test("a component in a row renders with the row, follows a new item and is disposed with the row", () => {
    const root = box();
    const api = run<{
      setRows: (r: { id: number; n: number }[]) => void;
      setTick: (n: number) => void;
      runs: () => number;
      cleaned: () => number;
    }>(
      `
      import { effect, For, onCleanup, render, signal } from "@reactre/core";
      const [rows, setRows] = signal([]);
      const [tick, setTick] = signal(0);
      let runs = 0, cleaned = 0;
      function Badge({ n }) {
        effect(() => void (tick(), runs++));
        onCleanup(() => cleaned++);
        return <b>{n}</b>;
      }
      function App() {
        return (
          <ul>
            <For each={rows()} key={(r) => r.id}>
              {(r) => <li class="row"><Badge n={r.n} />{r.id}</li>}
            </For>
          </ul>
        );
      }
      render(App, root);
      return { setRows, setTick, runs: () => runs, cleaned: () => cleaned };
    `,
      root,
    );
    const two = { id: 2, n: 20 };
    api.setRows([{ id: 1, n: 10 }, two]);
    expect(html(root)).toBe('<ul><li class="row"><b>10</b>1</li><li class="row"><b>20</b>2</li></ul>');
    const first = (root.firstChild as FakeElement).firstChild;
    api.setRows([{ id: 1, n: 11 }, two]);
    expect(html(root)).toBe('<ul><li class="row"><b>11</b>1</li><li class="row"><b>20</b>2</li></ul>');
    // The row element is kept; only its slot was rebuilt.
    expect((root.firstChild as FakeElement).firstChild).toBe(first);
    expect(api.cleaned()).toBe(1);
    api.setRows([]);
    expect(api.cleaned()).toBe(3);
    const before = api.runs();
    api.setTick(1);
    expect(api.runs()).toBe(before);
  });

  test("a row can hold a nested <For> and a JSX expression that follows a signal", () => {
    const root = box();
    const api = run<{ setRows: (r: unknown[]) => void; setOpen: (b: boolean) => void; runs: () => number }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [rows, setRows] = signal([]);
      const [open, setOpen] = signal(false);
      let runs = 0;
      const isOpen = () => (runs++, open());
      function App() {
        return (
          <div>
            <For each={rows()} key={(r) => r.id}>
              {(r) => (
                <section>
                  <h2>{r.id}</h2>
                  <ul><For each={r.kids} key={(k) => k}>{(k) => <li onClick={() => r.picked.push(k)}>{r.id}.{k}</li>}</For></ul>
                  {isOpen() ? <p>open {r.id}</p> : null}
                </section>
              )}
            </For>
          </div>
        );
      }
      render(App, root);
      return { setRows, setOpen, runs: () => runs };
    `,
      root,
    );
    const picked: number[] = [];
    api.setRows([
      { id: 1, kids: [1, 2], picked },
      { id: 2, kids: [3], picked },
    ]);
    expect(html(root)).toBe(
      "<div><section><h2>1</h2><ul><li>1.1</li><li>1.2</li></ul></section><section><h2>2</h2><ul><li>2.3</li></ul></section></div>",
    );
    api.setOpen(true);
    expect(html(root)).toBe(
      "<div><section><h2>1</h2><ul><li>1.1</li><li>1.2</li></ul><p>open 1</p></section><section><h2>2</h2><ul><li>2.3</li></ul><p>open 2</p></section></div>",
    );
    // The nested list's handlers are delegated to its own parent.
    const section = (root.firstChild as FakeElement).firstChild as FakeElement;
    click((section.childNodes[1] as FakeElement).childNodes[1]);
    expect(picked).toEqual([2]);
    // A new item for row 1: its nested list follows the new kids.
    api.setRows([
      { id: 1, kids: [2, 5], picked },
      { id: 2, kids: [3], picked },
    ]);
    expect(html(root)).toBe(
      "<div><section><h2>1</h2><ul><li>1.2</li><li>1.5</li></ul><p>open 1</p></section><section><h2>2</h2><ul><li>2.3</li></ul><p>open 2</p></section></div>",
    );
    api.setRows([]);
    const before = api.runs();
    api.setOpen(false);
    expect(api.runs()).toBe(before);
  });

  test("a host-only row compiles to the plain list, with no slot machinery", () => {
    const out = compileSource(
      `export const x = (rows) => <ul><For each={rows} key={(r) => r}>{(r) => <li>{r}</li>}</For></ul>;`,
    );
    expect(out).toContain("__rrFor(");
    expect(out).not.toContain("mounts");
  });
});

describe("reactre: compiler coverage", () => {
  let unstyle: () => void;
  beforeAll(() => (unstyle = withStyles()));
  afterAll(() => unstyle());

  test("fragments render their children, follow signals and leave together", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void; setShow: (b: boolean) => void; setInner: (b: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [n, setN] = signal(0);
      const [show, setShow] = signal(true);
      const [inner, setInner] = signal(false);
      const Pair = () => <>a<b>{n()}</b>{inner() ? <i>in</i> : null}</>;
      function App() {
        return <div><>x<hr /></>{show() ? <Pair /> : <s>gone</s>}</div>;
      }
      render(App, root);
      return { setN, setShow, setInner };
    `,
      root,
    );
    expect(html(root)).toBe("<div>x<hr></hr>a<b>0</b></div>");
    api.setN(1);
    api.setInner(true);
    expect(html(root)).toBe("<div>x<hr></hr>a<b>1</b><i>in</i></div>");
    api.setShow(false);
    expect(html(root)).toBe("<div>x<hr></hr><s>gone</s></div>");
  });

  test("spread props set attributes, classes and handlers, and follow a reactive object", () => {
    const root = box();
    const api = run<{ setP: (p: Record<string, unknown>) => void; clicks: () => number }>(
      `
      import { render, signal } from "@reactre/core";
      let clicks = 0;
      const base = { id: "a", title: "t", onClick: () => clicks++ };
      const [p, setP] = signal({ "data-x": "1" });
      function App() {
        return <div><span {...base} class="s" /><em {...p()} /></div>;
      }
      render(App, root);
      return { setP, clicks: () => clicks };
    `,
      root,
    );
    const [span, em] = (root.firstChild as FakeElement).childNodes as FakeElement[];
    expect(span!.getAttribute("id")).toBe("a");
    expect(span!.getAttribute("title")).toBe("t");
    expect(span!.getAttribute("class")).toBe("s");
    click(span);
    expect(api.clicks()).toBe(1);
    expect(em!.getAttribute("data-x")).toBe("1");
    api.setP({ "data-y": "2" });
    expect(em!.getAttribute("data-x")).toBeNull();
    expect(em!.getAttribute("data-y")).toBe("2");
  });

  test("style objects, refs, and checked and value as properties", () => {
    const root = box();
    const api = run<{
      setColor: (c: string) => void;
      setV: (v: string) => void;
      refs: unknown[];
      obj: { current: unknown };
    }>(
      `
      import { render, signal } from "@reactre/core";
      const [color, setColor] = signal("red");
      const [v, setV] = signal("a");
      const refs = [];
      const obj = { current: null };
      function App() {
        return (
          <form>
            <p style={{ color: color(), "--gap": "2px" }} ref={(el) => refs.push(el)}>x</p>
            <p style="margin: 0" ref={obj}>y</p>
            <input value={v()} checked={v() === "b"} />
          </form>
        );
      }
      render(App, root);
      return { setColor, setV, refs, obj };
    `,
      root,
    );
    const [p1, p2, input] = (root.firstChild as FakeElement).childNodes as FakeElement[];
    const style = (el: FakeElement) => el.style as { getPropertyValue(k: string): string; cssText: string };
    expect(style(p1!).getPropertyValue("color")).toBe("red");
    expect(style(p1!).getPropertyValue("--gap")).toBe("2px");
    api.setColor("blue");
    expect(style(p1!).getPropertyValue("color")).toBe("blue");
    expect(p2!.getAttribute("style")).toBe("margin: 0");
    expect(api.refs).toEqual([p1]);
    expect(api.obj.current).toBe(p2);
    expect(input!.value).toBe("a");
    expect(input!.checked).toBe(false);
    expect(input!.getAttribute("value")).toBeNull();
    api.setV("b");
    expect(input!.value).toBe("b");
    expect(input!.checked).toBe(true);
  });

  test("SVG elements get the SVG namespace, whatever the template's root", () => {
    const root = box();
    const api = run<{ setC: (c: string) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [c, setC] = signal("a");
      const Dot = () => <g><circle class={c()} r={2} /></g>;
      function App() {
        return <svg viewBox="0 0 4 4"><Dot /></svg>;
      }
      render(App, root);
      return { setC };
    `,
      root,
    );
    const svg = root.firstChild as FakeElement;
    const g = svg.firstChild as FakeElement;
    const circle = g.firstChild as FakeElement;
    for (const el of [svg, g, circle]) expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(circle.getAttribute("class")).toBe("a");
    api.setC("b");
    expect(circle.getAttribute("class")).toBe("b");
  });

  test("focus and blur, which do not bubble, reach row handlers", () => {
    const root = box();
    const api = run<{ seen: string[] }>(
      `
      import { For, render } from "@reactre/core";
      const seen = [];
      function App() {
        return (
          <ul>
            <For each={[1, 2]} key={(r) => r}>
              {(r) => <li><input onFocus={() => seen.push("focus " + r)} onBlur={() => seen.push("blur " + r)} /></li>}
            </For>
          </ul>
        );
      }
      render(App, root);
      return { seen };
    `,
      root,
    );
    const inputs = ((root.firstChild as FakeElement).childNodes as FakeElement[]).map(
      (li) => li.firstChild as FakeElement,
    );
    inputs[1]!.dispatchEvent(new FakeEvent("focus", { bubbles: false }));
    inputs[1]!.dispatchEvent(new FakeEvent("blur", { bubbles: false }));
    expect(api.seen).toEqual(["focus 2", "blur 2"]);
  });

  test("a key on an element outside <For> rebuilds it when the key changes", () => {
    const root = box();
    const api = run<{ setK: (k: number) => void; setN: (n: number) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [k, setK] = signal(1);
      const [n, setN] = signal(0);
      function App() {
        return <div><p key={k()}>{n()}</p><i key="fixed">i</i></div>;
      }
      render(App, root);
      return { setK, setN };
    `,
      root,
    );
    const div = root.firstChild as FakeElement;
    const p = div.firstChild;
    api.setN(1);
    expect(div.firstChild).toBe(p);
    api.setK(2);
    expect(div.firstChild).not.toBe(p);
    expect(html(root)).toBe("<div><p>1</p><i>i</i></div>");
  });
});

describe("reactre: handlers outside lists", () => {
  test("a handler expression that reads a signal follows it", () => {
    const root = box();
    const api = run<{ setUp: (b: boolean) => void; count: () => number }>(
      `
      import { render, signal } from "@reactre/core";
      const [up, setUp] = signal(true);
      const [count, setCount] = signal(0);
      const inc = () => setCount((c) => c + 1);
      const dec = () => setCount((c) => c - 1);
      function App() {
        return <button onClick={up() ? inc : dec}>{count()}</button>;
      }
      render(App, root);
      return { setUp, count };
    `,
      root,
    );
    click(root.firstChild);
    api.setUp(false);
    click(root.firstChild);
    click(root.firstChild);
    expect(api.count()).toBe(-1);
  });
});

describe("reactre: batching", () => {
  test("a long batch queues each effect once and stays linear", () => {
    const n = 100000;
    const sigs = Array.from({ length: n }, () => runtime.signal(0));
    let runs = 0;
    for (const [read] of sigs) runtime.effect(() => void (read(), runs++));
    runs = 0;
    const t0 = performance.now();
    runtime.batch(() => {
      for (const [, write] of sigs) write(1);
      // Written twice: still one run each.
      for (const [, write] of sigs) write(2);
    });
    // Quadratic queueing takes seconds here; linear takes milliseconds.
    expect(performance.now() - t0).toBeLessThan(400);
    expect(runs).toBe(n);
  });

  test("an effect that writes what it reads settles, or throws when it never does", () => {
    const [a, setA] = runtime.signal(0);
    let runs = 0;
    runtime.effect(() => {
      runs++;
      if (a() < 5) setA(a() + 1);
    });
    expect(a()).toBe(5);
    expect(runs).toBe(6);
    const [b, setB] = runtime.signal(0);
    expect(() => runtime.effect(() => setB(b() + 1))).toThrow(/writes a signal it reads/);
    // Two effects that write each other's source are a cycle too.
    const [c, setC] = runtime.signal(0);
    const [d, setD] = runtime.signal(0);
    runtime.effect(() => setD(c() + 1));
    expect(() => runtime.effect(() => setC(d() + 1))).toThrow(/writes a signal it reads/);
  });

  test("an effect that throws during a flush leaves the rest queued for the next one", () => {
    const [a, setA] = runtime.signal(0);
    const seen: number[] = [];
    runtime.effect(() => {
      if (a() === 1) throw new Error("boom");
    });
    runtime.effect(() => void seen.push(a()));
    expect(() => runtime.batch(() => setA(1))).toThrow("boom");
    runtime.batch(() => {});
    expect(seen).toEqual([0, 1]);
  });
});

describe("reactre: ownership", () => {
  test("an effect disposes the effects it created, and runs its cleanups, before it re-runs", () => {
    const [a, setA] = runtime.signal(0);
    const [b, setB] = runtime.signal(0);
    let inner = 0,
      cleaned = 0;
    runtime.effect(() => {
      a();
      runtime.effect(() => void (b(), inner++));
      runtime.onCleanup(() => cleaned++);
    });
    setA(1);
    setA(2);
    expect(cleaned).toBe(2);
    inner = 0;
    setB(1);
    // Only the inner effect of the last run is still subscribed.
    expect(inner).toBe(1);
  });

  test("a slot that replaces its content disposes the old content's effects", () => {
    const root = box();
    const api = run<{
      setShow: (b: boolean) => void;
      setN: (n: number) => void;
      runs: () => number;
      cleaned: () => number;
    }>(
      `
      import { effect, onCleanup, render, signal } from "@reactre/core";
      const [show, setShow] = signal(true);
      const [n, setN] = signal(0);
      let runs = 0, cleaned = 0;
      function A() {
        effect(() => void (n(), runs++));
        onCleanup(() => cleaned++);
        return <b>{n()}</b>;
      }
      function App() {
        return <div>{show() ? <A /> : <i>no</i>}</div>;
      }
      render(App, root);
      return { setShow, setN, runs: () => runs, cleaned: () => cleaned };
    `,
      root,
    );
    api.setN(1);
    expect(html(root)).toBe("<div><b>1</b></div>");
    const before = api.runs();
    api.setShow(false);
    expect(api.cleaned()).toBe(1);
    api.setN(2);
    expect(api.runs()).toBe(before);
    expect(html(root)).toBe("<div><i>no</i></div>");
    api.setShow(true);
    expect(html(root)).toBe("<div><b>2</b></div>");
  });

  test("attach returns a function that disposes the view; onCleanup outside any owner is ignored", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void; dispose: () => void; runs: () => number }>(
      `
      import { attach, effect, onCleanup, render, signal } from "@reactre/core";
      const [n, setN] = signal(0);
      let runs = 0;
      onCleanup(() => { throw new Error("never"); });
      // render keeps its view for good, and returns nothing.
      if (render(() => <i />, root) !== undefined) throw new Error("render returned something");
      function App() {
        effect(() => void (n(), runs++));
        return <p>{n()}</p>;
      }
      const dispose = attach(App, root);
      return { setN, dispose, runs: () => runs };
    `,
      root,
    );
    api.setN(1);
    expect(api.runs()).toBe(2);
    api.dispose();
    api.setN(2);
    expect(api.runs()).toBe(2);
  });
});

describe("@reactre/compiler: errors", () => {
  test("constructs it does not compile are errors, not a runtime fallback", () => {
    expect(() => compileSource(`const x = <For each={[]} key={(r) => r}>{(r) => <b />}</For>;`)).toThrow(
      ReactreCompileError,
    );
    expect(() => compileSource(`const x = <ul><For each={[]} key={(r) => r}>{(r) => <><b /></>}</For></ul>;`)).toThrow(
      ReactreCompileError,
    );
    expect(() => compileSource(`const x = <For each={[]} key={(r) => r}>{(r) => <b />}</For>;`)).toThrow(
      ReactreCompileError,
    );
  });
});
