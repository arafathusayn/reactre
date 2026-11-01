// Tests of control flow and the element features on the fake DOM: <Show>, <Switch> and <Match>,
// a <For>'s fallback, <Repeat>, <Portal>, <Dynamic> and dynamic(), class objects and arrays, the
// default* properties and ref arrays. Each TSX source here is compiled as the plugin compiles it
// and run against the runtime, outside lists and in <For> rows. Compile errors are in
// packages/compiler/test/flow.test.ts.
//
// The fake DOM has no classList, document.body or createElementNS: this file adds them for its
// own tests and takes them away after.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";

import * as runtime from "../src/index.ts";

const SVG = "http://www.w3.org/2000/svg";

// #region Harness

/** The page's body, made for each test (the fake document has none). */
let body: FakeElement;

beforeAll(() => {
  // classList's toggle and contains, over the class attribute, as the DOM's.
  Object.defineProperty(FakeElement.prototype, "classList", {
    configurable: true,
    get(this: FakeElement) {
      const el = this;
      const list = () => (el.getAttribute("class") ?? "").split(" ").filter(Boolean);
      return {
        contains: (c: string) => list().includes(c),
        toggle(c: string, force?: boolean) {
          const cs = list().filter((x) => x !== c);
          const on = force ?? !list().includes(c);
          if (on) cs.push(c);
          el.setAttribute("class", cs.join(" "));
          return on;
        },
      };
    },
  });
});
afterAll(() => {
  delete (FakeElement.prototype as unknown as Record<string, unknown>)["classList"];
  installFakeDocument();
});
beforeEach(() => {
  installFakeDocument();
  const doc = new FakeElement("HTML");
  doc.isDocument = true;
  body = new FakeElement("BODY");
  doc.appendChild(body);
  Object.assign(globalThis.document, {
    body,
    createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  });
});

/**
 * Compile a TSX test source (a module body ending in `return { ... }`) and run it with the
 * runtime, `root` in scope. Imports from @reactre/core become bindings to the runtime.
 */
function run<T>(src: string, root: FakeElement): T {
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
    .replace(/^import \* as (\w+) from "@reactre\/core";$/gm, "const $1 = rr;");
  return new Function("rr", "root", js)(runtime, root) as T;
}

/** A root inside the document, so what is under it is connected as in a page. */
const box = (): FakeElement => {
  const root = new FakeElement("DIV");
  body.appendChild(root);
  return root;
};

/** Tags, classes and text: enough to compare what was rendered. */
const html = (n: FakeElement): string => {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const cls = c.getAttribute("class");
      const tag = c.namespaceURI === SVG ? c.tagName : c.tagName.toLowerCase();
      out += `<${tag}${cls ? ` class="${cls}"` : ""}>${html(c)}</${tag}>`;
    } else out += c.textContent;
  }
  return out;
};

const click = (n: unknown): void => void (n as FakeElement).dispatchEvent(new FakeEvent("click"));

// #endregion

// #region <Show>

describe("<Show>", () => {
  test("shows its children while when is truthy, else the fallback, and rebuilds only when that changes", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void; builds: () => number }>(
      `
      import { render, signal, Show } from "@reactre/core";
      const [n, setN] = signal(0);
      let builds = 0;
      function Content() { builds++; return <b>{n()}</b>; }
      render(() => <div><Show when={n()} fallback={<i>none</i>}><Content /></Show><hr /></div>, root);
      return { setN, builds: () => builds };
    `,
      root,
    );
    expect(html(root)).toBe("<div><i>none</i><hr></hr></div>");
    api.setN(1);
    expect(html(root)).toBe("<div><b>1</b><hr></hr></div>");
    const b = (root.firstChild as FakeElement).firstChild;
    api.setN(2);
    expect(html(root)).toBe("<div><b>2</b><hr></hr></div>");
    expect((root.firstChild as FakeElement).firstChild).toBe(b);
    expect(api.builds()).toBe(1);
    api.setN(0);
    expect(html(root)).toBe("<div><i>none</i><hr></hr></div>");
  });

  test("a function child gets an accessor that follows the value and never reads a falsy one", () => {
    const root = box();
    const api = run<{ setUser: (u: { name: string } | null) => void; seen: string[] }>(
      `
      import { effect, render, signal, Show } from "@reactre/core";
      const [user, setUser] = signal({ name: "ann" });
      const seen = [];
      function Name(props) {
        effect(() => seen.push(props.u() ? props.u().name : "FALSY"));
        return <b>{props.u().name}</b>;
      }
      render(() => <p><Show when={user()} fallback="out">{(u) => <Name u={u} />}</Show></p>, root);
      return { setUser, seen };
    `,
      root,
    );
    expect(html(root)).toBe("<p><b>ann</b></p>");
    const b = (root.firstChild as FakeElement).firstChild;
    api.setUser({ name: "bob" });
    expect(html(root)).toBe("<p><b>bob</b></p>");
    expect((root.firstChild as FakeElement).firstChild).toBe(b);
    api.setUser(null);
    expect(html(root)).toBe("<p>out</p>");
    api.setUser({ name: "cy" });
    expect(html(root)).toBe("<p><b>cy</b></p>");
    expect(api.seen).not.toContain("FALSY");
  });

  test("keyed: a new value rebuilds the content, and a function child gets the value itself", () => {
    const root = box();
    const api = run<{ set: (u: { name: string } | null) => void; builds: () => number }>(
      `
      import { render, signal, Show } from "@reactre/core";
      const a = { name: "ann" };
      const [user, set] = signal(a);
      let builds = 0;
      render(() => <p><Show when={user()} keyed>{(u) => (builds++, <b>{u.name}</b>)}</Show></p>, root);
      return { set, builds: () => builds, a };
    `,
      root,
    );
    expect(html(root)).toBe("<p><b>ann</b></p>");
    api.set({ name: "bob" });
    expect(html(root)).toBe("<p><b>bob</b></p>");
    expect(api.builds()).toBe(2);
    api.set(null);
    expect(html(root)).toBe("<p></p>");
  });

  test("keyed element children are rebuilt for a new value, not for the same one", () => {
    const root = box();
    const api = run<{ set: (v: number) => void; tick: () => void; builds: () => number }>(
      `
      import { render, signal, Show } from "@reactre/core";
      const [v, set] = signal(1);
      const [t, setT] = signal(0);
      let builds = 0;
      function C() { builds++; return <b>c</b>; }
      render(() => <p><Show when={(t(), v())} keyed><C /></Show></p>, root);
      return { set, tick: () => setT((x) => x + 1), builds: () => builds };
    `,
      root,
    );
    api.tick();
    expect(api.builds()).toBe(1);
    api.set(2);
    expect(api.builds()).toBe(2);
    expect(html(root)).toBe("<p><b>c</b></p>");
  });

  test("a when that calls nothing is read once; a child that is a name is called when it is a function", () => {
    const root = box();
    run(
      `
      import { render, Show } from "@reactre/core";
      const show = (u) => <b>{u().name}</b>;
      const plain = "text";
      function Card(props) {
        return (
          <div>
            <Show when={props.user}>{show}</Show>
            <Show when={props.user} keyed>{(u) => <i>{u.name}</i>}</Show>
            <Show when={props.user}>{plain}</Show>
            <Show when={props.none} fallback="no">{show}</Show>
          </div>
        );
      }
      render(() => <Card user={{ name: "ann" }} none={null} />, root);
      return {};
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>ann</b><i>ann</i>textno</div>");
  });

  test("stands alone, in a fragment and nested; several children are a fragment, a reactive one a slot", () => {
    const root = box();
    const api = run<{ setA: (b: boolean) => void; setB: (b: boolean) => void; setN: (n: number) => void }>(
      `
      import { render, signal, Show } from "@reactre/core";
      const [a, setA] = signal(true);
      const [b, setB] = signal(false);
      const [n, setN] = signal(1);
      const Inner = () => <Show when={b()} fallback={<s>b off</s>}><u>b on</u> and {n()}</Show>;
      function App() {
        return (
          <>
            <Show when={a()}>
              <Inner />
            </Show>
            <Show when={a()}>{n()}</Show>
          </>
        );
      }
      render(App, root);
      return { setA, setB, setN };
    `,
      root,
    );
    expect(html(root)).toBe("<s>b off</s>1");
    api.setB(true);
    expect(html(root)).toBe("<u>b on</u> and 11");
    api.setN(2);
    expect(html(root)).toBe("<u>b on</u> and 22");
    api.setA(false);
    expect(html(root)).toBe("");
    api.setA(true);
    expect(html(root)).toBe("<u>b on</u> and 22");
  });

  test("hiding the content disposes what it made: its effects stop and its cleanups run", () => {
    const root = box();
    const api = run<{ set: (b: boolean) => void; bump: () => void; runs: () => number; cleaned: () => number }>(
      `
      import { effect, onCleanup, render, signal, Show } from "@reactre/core";
      const [on, set] = signal(true);
      const [n, setN] = signal(0);
      let runs = 0, cleaned = 0;
      function C() { effect(() => (n(), runs++)); onCleanup(() => cleaned++); return <b />; }
      render(() => <p><Show when={on()}><C /></Show></p>, root);
      return { set, bump: () => setN((x) => x + 1), runs: () => runs, cleaned: () => cleaned };
    `,
      root,
    );
    api.bump();
    expect(api.runs()).toBe(2);
    api.set(false);
    expect(api.cleaned()).toBe(1);
    api.bump();
    expect(api.runs()).toBe(2);
  });

  test("works in a <For> row, through the namespace import too", () => {
    const root = box();
    const api = run<{ setRows: (r: { id: number; on: boolean }[]) => void }>(
      `
      import * as R from "@reactre/core";
      const [rows, setRows] = R.signal([{ id: 1, on: true }, { id: 2, on: false }]);
      R.render(() => (
        <ul>
          <R.For each={rows()} key={(r) => r.id}>
            {(r) => <li><R.Show when={r.on} fallback={<i>{r.id}</i>}><b>{r.id}</b></R.Show></li>}
          </R.For>
        </ul>
      ), root);
      return { setRows };
    `,
      root,
    );
    expect(html(root)).toBe("<ul><li><b>1</b></li><li><i>2</i></li></ul>");
    api.setRows([
      { id: 1, on: false },
      { id: 2, on: true },
    ]);
    expect(html(root)).toBe("<ul><li><i>1</i></li><li><b>2</b></li></ul>");
  });
});

// #endregion

// #region <Switch>

describe("<Switch>", () => {
  test("renders the first truthy match, rebuilt only when another becomes the first; else the fallback", () => {
    const root = box();
    const api = run<{
      setA: (n: number) => void;
      setB: (n: number) => void;
      builds: () => number;
      reads: () => number;
    }>(
      `
      import { render, signal, Switch, Match } from "@reactre/core";
      const [a, setA] = signal(0);
      const [b, setB] = signal(0);
      let builds = 0, reads = 0;
      function A() { builds++; return <b>a</b>; }
      const readB = () => (reads++, b());
      render(() => (
        <p>
          <Switch fallback={<i>none</i>}>
            <Match when={a()}><A /></Match>
            {null}
            <Match when={readB()}>{(v) => <s>{v()}</s>}</Match>
          </Switch>
        </p>
      ), root);
      return { setA, setB, builds: () => builds, reads: () => reads };
    `,
      root,
    );
    expect(html(root)).toBe("<p><i>none</i></p>");
    api.setB(5);
    expect(html(root)).toBe("<p><s>5</s></p>");
    const s = (root.firstChild as FakeElement).firstChild;
    api.setB(6);
    expect(html(root)).toBe("<p><s>6</s></p>");
    expect((root.firstChild as FakeElement).firstChild).toBe(s);
    api.setA(1);
    expect(html(root)).toBe("<p><b>a</b></p>");
    // The first match is truthy: the second's condition is no longer read.
    const reads = api.reads();
    api.setB(7);
    expect(api.reads()).toBe(reads);
    api.setA(2);
    expect(api.builds()).toBe(1);
    api.setA(0);
    expect(html(root)).toBe("<p><s>7</s></p>");
  });

  test("a keyed match is rebuilt for a new value, and its function child gets the value", () => {
    const root = box();
    const api = run<{ setX: (v: unknown) => void; setY: (v: number) => void; builds: () => number }>(
      `
      import { render, signal, Switch, Match } from "@reactre/core";
      const [x, setX] = signal(null);
      const [y, setY] = signal(1);
      let builds = 0;
      render(() => (
        <p>
          <Switch>
            <Match when={x()} keyed>{(v) => (builds++, <b>{v.name}</b>)}</Match>
            <Match when={y()} keyed={false}>y</Match>
          </Switch>
        </p>
      ), root);
      return { setX, setY, builds: () => builds };
    `,
      root,
    );
    expect(html(root)).toBe("<p>y</p>");
    api.setX({ name: "ann" });
    expect(html(root)).toBe("<p><b>ann</b></p>");
    api.setY(2);
    expect(api.builds()).toBe(1);
    api.setX({ name: "bob" });
    expect(html(root)).toBe("<p><b>bob</b></p>");
    expect(api.builds()).toBe(2);
    api.setX(null);
    api.setY(0);
    expect(html(root)).toBe("<p></p>");
  });

  test("a keyed match's element children, an empty switch, and a switch standing alone", () => {
    const root = box();
    const api = run<{ set: (v: number) => void; builds: () => number }>(
      `
      import { render, signal, Switch, Match } from "@reactre/core";
      const [v, set] = signal(1);
      let builds = 0;
      function C() { builds++; return <b>c</b>; }
      const App = () => (
        <Switch fallback="never">
          <Match when={v()} keyed><C /></Match>
        </Switch>
      );
      render(() => <div><App /><Switch fallback="empty" /><Switch> <Match when={1}>one</Match> </Switch></div>, root);
      return { set, builds: () => builds };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>c</b>emptyone</div>");
    api.set(2);
    expect(api.builds()).toBe(2);
  });

  test("works in a <For> row", () => {
    const root = box();
    const api = run<{ setRows: (r: { id: number; k: string }[]) => void }>(
      `
      import { For, Match, render, signal, Switch } from "@reactre/core";
      const [rows, setRows] = signal([{ id: 1, k: "a" }, { id: 2, k: "b" }]);
      render(() => (
        <ul>
          <For each={rows()} key={(r) => r.id}>
            {(r) => <li><Switch fallback="?"><Match when={r.k === "a"}>A</Match><Match when={r.k === "b"}>B</Match></Switch></li>}
          </For>
        </ul>
      ), root);
      return { setRows };
    `,
      root,
    );
    expect(html(root)).toBe("<ul><li>A</li><li>B</li></ul>");
    api.setRows([
      { id: 1, k: "b" },
      { id: 2, k: "c" },
    ]);
    expect(html(root)).toBe("<ul><li>B</li><li>?</li></ul>");
  });
});

// #endregion

// #region Lists: <For fallback> and <Repeat>

describe("<For fallback>", () => {
  test("shows the fallback while each is empty, as the only child of its element", () => {
    const root = box();
    const api = run<{ setRows: (r: number[]) => void; builds: () => number }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [rows, setRows] = signal([]);
      let builds = 0;
      const Empty = () => (builds++, <li>empty</li>);
      render(() => <ul><For each={rows()} key={(r) => r} fallback={<Empty />}>{(r) => <li>{r}</li>}</For></ul>, root);
      return { setRows, builds: () => builds };
    `,
      root,
    );
    expect(html(root)).toBe("<ul><li>empty</li></ul>");
    api.setRows([1, 2]);
    expect(html(root)).toBe("<ul><li>1</li><li>2</li></ul>");
    api.setRows([3]);
    expect(html(root)).toBe("<ul><li>3</li></ul>");
    api.setRows([]);
    expect(html(root)).toBe("<ul><li>empty</li></ul>");
    // Another empty array: the fallback stays as it is.
    api.setRows([]);
    expect(api.builds()).toBe(2);
    api.setRows([4]);
    expect(html(root)).toBe("<ul><li>4</li></ul>");
  });

  test("beside other children, and in a <For> row", () => {
    const root = box();
    const api = run<{ setRows: (r: { id: number; kids: number[] }[]) => void }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [rows, setRows] = signal([{ id: 1, kids: [] }]);
      render(() => (
        <div>
          <h1>t</h1>
          <For each={rows()} key={(r) => r.id} fallback="no rows">
            {(r) => <ul><For each={r.kids} key={(k) => k} fallback={<li>none</li>}>{(k) => <li>{k}</li>}</For></ul>}
          </For>
          <hr />
        </div>
      ), root);
      return { setRows };
    `,
      root,
    );
    expect(html(root)).toBe("<div><h1>t</h1><ul><li>none</li></ul><hr></hr></div>");
    api.setRows([{ id: 1, kids: [7, 8] }]);
    expect(html(root)).toBe("<div><h1>t</h1><ul><li>7</li><li>8</li></ul><hr></hr></div>");
    api.setRows([]);
    expect(html(root)).toBe("<div><h1>t</h1>no rows<hr></hr></div>");
  });
});

describe("<Repeat>", () => {
  test("a row per index from `from`, kept while the count keeps it; the fallback at 0", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void }>(
      `
      import { render, Repeat, signal } from "@reactre/core";
      const [n, setN] = signal(2);
      render(() => (
        <div>
          <ul><Repeat count={n()}>{(i) => <li>{i}</li>}</Repeat></ul>
          <ol><Repeat count={n()} from={10} fallback={<li>none</li>}>{(i) => <li>{i}</li>}</Repeat></ol>
        </div>
      ), root);
      return { setN };
    `,
      root,
    );
    expect(html(root)).toBe("<div><ul><li>0</li><li>1</li></ul><ol><li>10</li><li>11</li></ol></div>");
    const first = ((root.firstChild as FakeElement).firstChild as FakeElement).firstChild;
    api.setN(3);
    expect(html(root)).toBe(
      "<div><ul><li>0</li><li>1</li><li>2</li></ul><ol><li>10</li><li>11</li><li>12</li></ol></div>",
    );
    expect(((root.firstChild as FakeElement).firstChild as FakeElement).firstChild).toBe(first);
    api.setN(0);
    expect(html(root)).toBe("<div><ul></ul><ol><li>none</li></ol></div>");
  });

  test("in a <For> row", () => {
    const root = box();
    const api = run<{ setRows: (r: { id: number; n: number }[]) => void }>(
      `
      import { For, render, Repeat, signal } from "@reactre/core";
      const [rows, setRows] = signal([{ id: 1, n: 2 }]);
      render(() => (
        <div>
          <For each={rows()} key={(r) => r.id}>
            {(r) => <p><Repeat count={r.n}>{(i) => <b>{r.id}.{i}</b>}</Repeat></p>}
          </For>
        </div>
      ), root);
      return { setRows };
    `,
      root,
    );
    expect(html(root)).toBe("<div><p><b>1.0</b><b>1.1</b></p></div>");
    api.setRows([{ id: 1, n: 1 }]);
    expect(html(root)).toBe("<div><p><b>1.0</b></p></div>");
  });
});

// #endregion

// #region <Portal>

describe("<Portal>", () => {
  test("puts its children at the end of document.body, and takes them out with their owner", () => {
    const root = box();
    const api = run<{ set: (b: boolean) => void; setN: (n: number) => void }>(
      `
      import { render, signal, Portal, Show } from "@reactre/core";
      const [open, set] = signal(false);
      const [n, setN] = signal(1);
      render(() => <main><Show when={open()}><Portal><p class="modal">{n()}</p><i>x</i></Portal></Show>inline</main>, root);
      return { set, setN };
    `,
      root,
    );
    expect(html(root)).toBe("<main>inline</main>");
    api.set(true);
    expect(html(root)).toBe("<main>inline</main>");
    expect(html(body)).toBe('<div><main>inline</main></div><p class="modal">1</p><i>x</i>');
    api.setN(2);
    expect(html(body)).toBe('<div><main>inline</main></div><p class="modal">2</p><i>x</i>');
    api.set(false);
    expect(html(body)).toBe("<div><main>inline</main></div>");
    expect(body.childNodes.length).toBe(1);
  });

  test("into a mount of its own, standing alone and in a <For> row", () => {
    const root = box();
    const target = new FakeElement("SECTION");
    body.appendChild(target);
    (globalThis as unknown as { target: FakeElement }).target = target;
    try {
      const api = run<{ setRows: (r: number[]) => void }>(
        `
        import { For, render, signal, Portal } from "@reactre/core";
        const [rows, setRows] = signal([1, 2]);
        const Alone = () => <Portal mount={globalThis.target}>alone</Portal>;
        render(() => (
          <div>
            <Alone />
            <ul><For each={rows()} key={(r) => r}>{(r) => <li><Portal mount={globalThis.target}><b>{r}</b></Portal></li>}</For></ul>
          </div>
        ), root);
        return { setRows };
      `,
        root,
      );
      expect(html(target)).toBe("alone<b>1</b><b>2</b>");
      api.setRows([2]);
      expect(html(target)).toBe("alone<b>2</b>");
    } finally {
      delete (globalThis as unknown as { target?: FakeElement }).target;
    }
  });
});

// #endregion

// #region <Dynamic> and dynamic()

describe("<Dynamic>", () => {
  test("a tag name builds its element with the props, rebuilt when the tag changes", () => {
    const root = box();
    const api = run<{ setTag: (t: string | null) => void; setTitle: (t: string) => void }>(
      `
      import { render, signal, Dynamic } from "@reactre/core";
      const [tag, setTag] = signal("h1");
      const [title, setTitle] = signal("a");
      const extra = { id: "e" };
      render(() => <div><Dynamic component={tag()} {...extra} class={{ big: true }} title={title()}>hi {title()}</Dynamic></div>, root);
      return { setTag, setTitle };
    `,
      root,
    );
    expect(html(root)).toBe('<div><h1 class="big">hi a</h1></div>');
    const h1 = (root.firstChild as FakeElement).firstChild as FakeElement;
    expect([h1.getAttribute("title"), h1.getAttribute("id")]).toEqual(["a", "e"]);
    api.setTitle("b");
    expect(h1.getAttribute("title")).toBe("b");
    expect(html(root)).toBe('<div><h1 class="big">hi b</h1></div>');
    api.setTag("h2");
    expect(html(root)).toBe('<div><h2 class="big">hi b</h2></div>');
    api.setTag(null);
    expect(html(root)).toBe("<div></div>");
  });

  test("a component is called with the props; a tag written as a string is compiled as the element", () => {
    const root = box();
    const api = run<{ setView: (v: string) => void }>(
      `
      import { render, signal, Dynamic } from "@reactre/core";
      const A = (p) => <b>A {p.label}</b>;
      const B = (p) => <i>B {p.label}</i>;
      const views = { A, B };
      const [view, setView] = signal("A");
      const Fixed = A;
      const opts = { id: "s" };
      render(() => (
        <div>
          <Dynamic component={views[view()]} label="x" />
          <Dynamic component={Fixed} label="y" />
          <Dynamic component="em" {...opts}>z</Dynamic>
          <Dynamic component={"span"}>w</Dynamic>
        </div>
      ), root);
      return { setView };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>A x</b><b>A y</b><em>z</em><span>w</span></div>");
    api.setView("B");
    expect(html(root)).toBe("<div><i>B x</i><b>A y</b><em>z</em><span>w</span></div>");
  });

  test("standing alone, with props that call nothing, in SVG, and in a <For> row", () => {
    const root = box();
    const api = run<{ setRows: (r: { id: number; tag: string }[]) => void }>(
      `
      import { For, render, signal, Dynamic } from "@reactre/core";
      const [rows, setRows] = signal([{ id: 1, tag: "b" }]);
      const shape = "circle";
      const Alone = () => <Dynamic component={rows()[0] ? "p" : "q"} id="alone" />;
      render(() => (
        <div>
          <Alone />
          <svg><Dynamic component={shape} r="1" /></svg>
          <ul><For each={rows()} key={(r) => r.id}>{(r) => <li><Dynamic component={r.tag}>{r.id}</Dynamic></li>}</For></ul>
        </div>
      ), root);
      return { setRows };
    `,
      root,
    );
    expect(html(root)).toBe("<div><p></p><svg><circle></circle></svg><ul><li><b>1</b></li></ul></div>");
    const svg = ((root.firstChild as FakeElement).childNodes as FakeElement[]).find((n) => n.tagName === "svg")!;
    const circle = svg.firstChild as FakeElement;
    expect(circle.namespaceURI).toBe(SVG);
    expect(circle.getAttribute("r")).toBe("1");
    api.setRows([{ id: 1, tag: "i" }]);
    expect(html(root)).toBe("<div><p></p><svg><circle></circle></svg><ul><li><i>1</i></li></ul></div>");
  });

  test("dynamic(source) is a component that renders what its source returns", () => {
    const root = box();
    const api = run<{ set: (v: unknown) => void; clicks: () => number }>(
      `
      import { dynamic, render, signal } from "@reactre/core";
      const B = (p) => <b>{p.label}</b>;
      const [v, set] = signal(B);
      let clicks = 0;
      const View = dynamic(() => v());
      render(() => <div><View label="x" onClick={() => clicks++}>kid</View></div>, root);
      return { set, clicks: () => clicks };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>x</b></div>");
    api.set("button");
    expect(html(root)).toBe("<div><button>kid</button></div>");
    const button = (root.firstChild as FakeElement).firstChild as FakeElement;
    expect(button.getAttribute("label")).toBe("x");
    click(button);
    expect(api.clicks()).toBe(1);
    api.set("hr");
    api.set(null);
    expect(html(root)).toBe("<div></div>");
    const bare = runtime.dynamic(() => "br")({} as never) as FakeElement[];
    expect(bare.map((n) => n.nodeName)).toEqual(["BR", "#text"]);
  });
});

// #endregion

// #region class lists

describe("class objects and arrays", () => {
  test("an object's literal keys join the template; its other keys are toggles, bound when they call", () => {
    const root = box();
    const api = run<{ setOn: (b: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [on, setOn] = signal(false);
      const off = 0;
      render(() => <div className="base" class={{ "a b": true, no: false, active: on(), zero: off }} />, root);
      return { setOn };
    `,
      root,
    );
    const div = root.firstChild as FakeElement;
    expect(div.getAttribute("class")).toBe("base a b");
    api.setOn(true);
    expect(div.getAttribute("class")).toBe("base a b active");
    // A toggle leaves classes added by anything else alone.
    div.setAttribute("class", div.getAttribute("class") + " extra");
    api.setOn(false);
    expect(div.getAttribute("class")).toBe("base a b extra");
  });

  test("an array of literals and objects is taken apart too; one with expressions becomes one string", () => {
    const root = box();
    const api = run<{ setSize: (s: unknown) => void; setOn: (b: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [on, setOn] = signal(false);
      const [size, setSize] = signal("lg");
      const extra = { x: true, y: false };
      const key = "k";
      render(() => (
        <div>
          <p class={["a", 1, 0, null, true, ["b", { c: true }], { d: on() }]} />
          <p class={["a", size(), { on: on() }, [extra], 0, false, 7]} />
          <p class={{ [key]: true, ...extra }} />
          <p class={["s", ...[extra]]} className="t" />
        </div>
      ), root);
      return { setSize, setOn };
    `,
      root,
    );
    const ps = (root.firstChild as FakeElement).childNodes as FakeElement[];
    const classes = () => ps.map((p) => p.getAttribute("class"));
    expect(classes()).toEqual(["a 1 b c", "a lg x 7", "k x", "s x t"]);
    api.setOn(true);
    api.setSize(null);
    expect(classes()).toEqual(["a 1 b c d", "a on x 7", "k x", "s x t"]);
  });

  test("on SVG, class is an attribute; spread props take class objects; rows toggle per item", () => {
    const root = box();
    const api = run<{ setRows: (r: { id: number; on: boolean }[]) => void; setSel: (n: number) => void }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [rows, setRows] = signal([{ id: 1, on: true }, { id: 2, on: false }]);
      const [sel, setSel] = signal(0);
      const rest = { id: "r" };
      render(() => (
        <div>
          <svg class={{ icon: true, on: sel() === 1 }}><circle class={["c", sel() ? "s" : ""]} /></svg>
          <span {...rest} class={{ sp: true }} />
          <ul><For each={rows()} key={(r) => r.id}>{(r) => <li class={{ row: true, on: r.on, sel: sel() === r.id }} />}</For></ul>
        </div>
      ), root);
      return { setRows, setSel };
    `,
      root,
    );
    const [svg, span, ul] = (root.firstChild as FakeElement).childNodes as FakeElement[];
    const lis = () => (ul!.childNodes as FakeElement[]).map((li) => li.getAttribute("class"));
    expect(svg!.getAttribute("class")).toBe("icon");
    expect((svg!.firstChild as FakeElement).getAttribute("class")).toBe("c");
    expect(span!.getAttribute("class")).toBe("sp");
    expect(lis()).toEqual(["row on", "row"]);
    api.setSel(1);
    expect(svg!.getAttribute("class")).toBe("icon on");
    expect((svg!.firstChild as FakeElement).getAttribute("class")).toBe("c s");
    expect(lis()).toEqual(["row on sel", "row"]);
    api.setRows([
      { id: 1, on: false },
      { id: 2, on: true },
    ]);
    expect(lis()).toEqual(["row sel", "row on"]);
  });

  test("__class makes any class list one string", () => {
    expect(
      runtime.__class(["a", 0, 1, "", null, undefined, true, false, ["b", [{ c: 1, d: 0 }]], { "e f": true }]),
    ).toBe("a 1 b c e f");
    expect(runtime.__class("x")).toBe("x");
    expect(runtime.__class(null)).toBe("");
    expect(runtime.__class(true)).toBe("");
  });
});

// #endregion

// #region default* properties and refs

describe("default properties", () => {
  test("defaultValue, defaultChecked, defaultSelected and defaultMuted are set as properties", () => {
    const root = box();
    const api = run<{ setV: (s: string) => void }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [v, setV] = signal("a");
      render(() => (
        <form>
          <input defaultValue="x" defaultChecked />
          <input defaultValue={v()} defaultChecked={false} />
          <textarea defaultValue={null} />
          <select><option defaultSelected /></select>
          <video defaultMuted />
          <ul><For each={[1]} key={(r) => r}>{(r) => <li><input defaultValue={"row " + r} /></li>}</For></ul>
        </form>
      ), root);
      return { setV };
    `,
      root,
    );
    const form = root.firstChild as FakeElement;
    const [a, b, area, select, video, ul] = form.childNodes as FakeElement[];
    expect([a!["defaultValue"], a!["defaultChecked"], a!.getAttribute("defaultValue")]).toEqual(["x", true, null]);
    expect([b!["defaultValue"], b!["defaultChecked"]]).toEqual(["a", false]);
    api.setV("b");
    expect(b!["defaultValue"]).toBe("b");
    expect(area!["defaultValue"]).toBeUndefined();
    expect((select!.firstChild as FakeElement)["defaultSelected"]).toBe(true);
    expect(video!["defaultMuted"]).toBe(true);
    expect(((ul!.firstChild as FakeElement).firstChild as FakeElement)["defaultValue"]).toBe("row 1");
  });
});

describe("refs", () => {
  test("each ref of an array gets the element, a null one is skipped; a directive is a ref", () => {
    const root = box();
    const api = run<{
      a: unknown[];
      b: { current: unknown };
      d: { current: unknown };
      c: unknown[];
      titled: () => unknown;
    }>(
      `
      import { For, render } from "@reactre/core";
      const a = [], c = [];
      const b = { current: null }, d = { current: null };
      const more = [(el) => c.push(el), null];
      const tooltip = (text) => (el) => el.setAttribute("title", text);
      const rest = { id: "s" };
      render(() => (
        <div>
          <p ref={[(el) => a.push(el), b, null, undefined, ...more]} />
          <i ref={tooltip("hi")} />
          <span {...rest} ref={[(el) => a.push(el), d]} />
          <ul><For each={[1]} key={(r) => r}>{(r) => <li ref={[(el) => a.push(el), null]} />}</For></ul>
        </div>
      ), root);
      return { a, b, c, d, titled: () => root.firstChild.childNodes[1].getAttribute("title") };
    `,
      root,
    );
    const [p, , span, ul] = (root.firstChild as FakeElement).childNodes as FakeElement[];
    // Refs run last, after spread props and lists: the span's and the row's come first.
    expect(api.a).toEqual([span, ul!.firstChild, p]);
    expect(api.b.current).toBe(p);
    expect(api.d.current).toBe(span);
    expect(api.c).toEqual([p]);
    expect(api.titled()).toBe("hi");
  });
});

// #endregion

// #region Uncompiled

describe("uncompiled", () => {
  test("each element compiled away says it must be compiled, and where to import it from", () => {
    for (const [name, f] of [
      ["Show", runtime.Show],
      ["Switch", runtime.Switch],
      ["Match", runtime.Match],
      ["Repeat", runtime.Repeat],
      ["Portal", runtime.Portal],
      ["Dynamic", runtime.Dynamic],
    ] as const)
      expect(() => (f as (p: unknown) => unknown)({})).toThrow(
        `reactre: <${name}> must be compiled by @reactre/compiler (import it from "@reactre/core"`,
      );
  });
});

// #endregion
