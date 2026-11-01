// Tests of reactive props: what a component call passes (values, or getters for what may change
// and for JSX), which holes reading a prop are bound (only where some call site may pass it
// reactively), and what the compiled code does on the fake DOM: a reactive prop updates the
// child, a provider's code runs before its children are built, a <For> row's components follow
// their reactive props, and spread props keep their getters. The whole-program analysis behind it
// is tested in program.test.ts.

import { beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";

import * as runtime from "../../core/src/index.ts";
import { compileSource } from "../src/index.ts";

beforeEach(installFakeDocument);

// #region Harness

/**
 * Compile a TSX test source (a module body ending in `return { ... }`) and run it with the
 * runtime, `root` in scope. Its imports from @reactre/core become bindings to the runtime.
 */
function run<T>(src: string, root: FakeElement): T {
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

/** A root inside a fake document, so what is under it is connected as in a page. */
const box = (): FakeElement => {
  const doc = new FakeElement("HTML");
  doc.isDocument = true;
  const root = new FakeElement("DIV");
  doc.appendChild(root);
  return root;
};

/** Tags, classes and text: enough to compare what was rendered. */
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

/** The compiled body of function `name` in `js`, up to the next top-level function. */
const body = (js: string, name: string): string => {
  const at = js.indexOf(`function ${name}(`);
  const end = js.indexOf("\nfunction ", at + 1);
  return js.slice(at, end < 0 ? undefined : end);
};

// #endregion

// #region Call sites

describe("call sites", () => {
  test("static props are values, written as before; a prop that may change is a getter", () => {
    const out = compileSource(`
      function C(p) { return <b>{p.a}</b>; }
      export const x = () => <div><C a="x" n={1} on={() => go()} f={handler} t={\`a\`} /></div>;
      export const y = () => <div><C a={n()} b={\`\${n()}\`} /></div>;
    `);
    expect(out).toMatch(/C\(\{\s+a: "x",\s+n: 1,\s+on: \(\) => go\(\),\s+f: handler,\s+t: `a`\s+\}\)/);
    expect(out).toContain("C({ get a() { return n(); }, get b() { return `${n()}`; } })");
  });

  test("children that hold JSX are a getter, built when read; text and a function child are values", () => {
    const out = compileSource(`
      function C(p) { return p.children; }
      export const x = () => <div><C><i /></C><C>text</C><C>{(v) => <b>{v}</b>}</C><C>{1}{2}</C></div>;
    `);
    expect(out).toContain("C({ get children() { return (() => {");
    expect(out).toMatch(/C\(\{\s+children: "text"\s+\}\)/);
    expect(out).toContain("children: (v) =>");
    expect(out).toMatch(/C\(\{\s+children: \[\s+1,\s+2\s+\]\s+\}\)/);
  });

  test("spread props are merged by __props, which keeps getters; only a file with one imports it", () => {
    const out = compileSource(`
      function C(p) { return <b>{p.a}</b>; }
      export const x = (rest) => <div><C a={1} {...rest} b={n()} /><C {...rest} /></div>;
    `);
    expect(out).toContain("__props as __rrProps");
    expect(out).toContain("C(__rrProps({ a: 1 }, rest, { get b() { return n(); } }))");
    expect(out).toContain("C(__rrProps(rest))");
    expect(compileSource(`export const x = () => <p />;`)).not.toContain("__props");
  });

  test("a prop read of the component around the call is passed on as a getter; only a reactive one binds", () => {
    const out = compileSource(`
      function Inner(p) { return <b title={p.w}>{p.v}</b>; }
      function Outer(props) { return <Inner v={props.v} w={props.w} q={"x"} />; }
      export const x = () => <div><Outer v={n()} w="static" /></div>;
    `);
    // A prop read is a getter whatever it reads, so children passed on stay unbuilt; Outer's v is
    // reactive at its call site and its w is not, so Inner binds the hole of v alone.
    expect(body(out, "Outer")).toContain('Inner({ get v() { return props.v; }, get w() { return props.w; }, q: "x" })');
    expect(body(out, "Inner")).toContain('clone([(p.w), ""])');
    expect(body(out, "Inner")).toContain("__rrBind(__rrT0, 1, __n[1], () => (p.v))");
  });

  test("children passed on to another component stay unbuilt until it reads them", () => {
    const out = compileSource(`
      function Frame(p) { return <section>{p.children}</section>; }
      function Card(props) { return <Frame>{props.children}</Frame>; }
      export const x = () => <div><Card><i /></Card></div>;
    `);
    expect(body(out, "Card")).toContain("Frame({ get children() { return props.children; } })");
    // Nothing passes children that may change: Frame inserts them once.
    expect(body(out, "Frame")).toContain("__rrInsert(__n[0], p.children, null)");
  });

  test("a key with a quote in it, and a <Dynamic> component's props", () => {
    const out = compileSource(`
      import { Dynamic } from "@reactre/core";
      function C(p) { return <b>{p["data-x"]}</b>; }
      export const x = () => <div><C data-x={n()} /><Dynamic component={C} title={t()} /></div>;
    `);
    expect(out).toContain('C({ get "data-x"() { return n(); } })');
    expect(out).toContain("__rrD({ get title() { return t(); } })");
  });
});

// #endregion

// #region Which holes are bound

describe("holes that read a prop", () => {
  test("a component whose callers all pass values writes its holes once", () => {
    const out = compileSource(`
      function Label(props) { return <b class={props.cls} title={props.t}>{props.text}</b>; }
      export const App = () => <div><Label text="a" cls="x" t={title} /><Label text="b" cls="y" /></div>;
    `);
    expect(body(out, "Label")).toContain("clone([(props.cls), (props.t), (props.text)])");
    expect(body(out, "Label")).not.toContain("__rrBind");
  });

  test("only the props some call site passes reactively are bound", () => {
    const out = compileSource(`
      function Label(props) { return <b class={props.cls}>{props.text}</b>; }
      export const App = () => <div><Label text={n()} cls="x" /><Label text="b" cls="y" /></div>;
    `);
    expect(body(out, "Label")).toContain('clone([(props.cls), ""])');
    expect(body(out, "Label")).toContain("__rrBind(__rrT0, 1, __n[1], () => (props.text))");
  });

  test("a component whose callers cannot all be seen binds every hole that reads a prop", () => {
    const cases = [
      // Exported: a caller outside the file may pass anything.
      `export function C(props) { return <b>{props.a}</b>; }`,
      `function C(props) { return <b>{props.a}</b>; } export { C as D };`,
      `function C(props) { return <b>{props.a}</b>; } export default C;`,
      `export default function (props) { return <b>{props.a}</b>; }`,
      // Used as a value.
      `function C(props) { return <b>{props.a}</b>; } const X = C;`,
      `function C(props) { return <b>{props.a}</b>; } export const all = [C];`,
      `import { Dynamic } from "@reactre/core"; function C(props) { return <b>{props.a}</b>; } export const x = <div><Dynamic component={C} /></div>;`,
      // Called with spread props.
      `function C(props) { return <b>{props.a}</b>; } export const x = (p) => <div><C {...p} /></div>;`,
      // Its definition hides its callers.
      `const C = wrap((props) => <b>{props.a}</b>);`,
      `export const ui = { Card: (props) => <b>{props.a}</b> };`,
      `export const ui = { Card(props) { return <b>{props.a}</b>; } };`,
      `const ui = {}; ui.Card = (props) => <b>{props.a}</b>;`,
    ];
    for (const src of cases) expect(compileSource(src)).toContain("() => (props.a)");
  });

  test("a destructured prop is read once, when the component runs, as in Solid", () => {
    const out = compileSource(`
      function Label({ text, cls: c }) { return <b class={c}>{text}</b>; }
      export const App = () => <div><Label text={n()} cls={k()} /></div>;
    `);
    expect(body(out, "Label")).toContain("clone([(c), (text)])");
  });

  test("an inner component's parameter hides an outer one's of the same name", () => {
    const out = compileSource(`
      function Outer(props) {
        function Inner(props) { return <i>{props.a}</i>; }
        return <div><Inner a="x" /><b>{props.a}</b></div>;
      }
      export const App = () => <div><Outer a={n()} /></div>;
    `);
    expect(out).toContain("clone([(props.a)])");
    expect(out).toContain("__rrBind(");
  });

  test("{props.children} is inserted, and followed when the children may change", () => {
    const out = compileSource(`
      function Box(props) { return <div>{props.children}</div>; }
      function Wrap({ children }) { return <p>{children}</p>; }
      export const App = () => <main><Box><i /></Box><Wrap><b /></Wrap></main>;
      export const Live = () => <main><Box>{n()}</Box></main>;
    `);
    expect(body(out, "Box")).toContain("__rrSlot(__n[0], () => (props.children))");
    expect(body(out, "Wrap")).toContain("__rrInsert(__n[0], children, null)");
    const fixed = compileSource(`
      function Box(props) { return <div>{props.children}</div>; }
      export const App = () => <main><Box><i /></Box></main>;
    `);
    expect(body(fixed, "Box")).toContain("__rrInsert(__n[0], props.children, null)");
  });

  test("a prop other than children that a call site passes JSX is inserted, as children are", () => {
    const out = compileSource(`
      function Card(props) { return <section><h1>{props.header}</h1><Inner title={props.header} /><p>{props.text}</p></section>; }
      function Inner({ title }) { return <b>{title}</b>; }
      function Merged(props) { const p = merge({}, props); return <i>{p.icon}</i>; }
      export const App = () => <main><Card header={<em />} text="a" /><Merged icon={on() ? <b /> : null} /></main>;
    `);
    expect(body(out, "Card")).toContain("__rrInsert(__n[0], props.header, null)");
    // Passed on, it is content where it lands too; a prop given text stays a text hole.
    expect(body(out, "Card")).toContain("Inner({ get title() { return props.header; } })");
    expect(body(out, "Inner")).toContain("__rrInsert(__n[0], title, null)");
    expect(body(out, "Card")).toContain("(props.text)])");
    // A prop that may change, and holds JSX, is followed.
    expect(body(out, "Merged")).toContain("__rrSlot(__n[0], () => (p.icon))");
  });

  test("a component whose callers cannot all be seen may be passed JSX in any prop: its prop holes are inserted", () => {
    // Seen alone, a file cannot see the callers of what it exports; a whole program that sees them
    // is exact (program.test.ts).
    const out = compileSource(`
      export function Card(props) { return <section><h1>{props.header}</h1></section>; }
      export const Count = ({ value }) => <p>{value}</p>;
    `);
    expect(out).toContain("__rrSlot(__n[0], () => (props.header))");
    expect(out).toContain("__rrSlot(__n[0], () => (value))");
  });

  test("a local made of the whole props object reads props: merge's defaults, omit's rest, a spread", () => {
    const out = compileSource(`
      function Button(props) {
        const size = props.size, p = merge({ size: "m" }, props);
        const rest = omit(p, "size");
        return <button class={p.size} title={size} {...rest}>{p.children}</button>;
      }
      function Plain(props) { return <i {...props} />; }
      export const App = () => <div><Button size={n()}><b /></Button><Plain title={t()} /></div>;
    `);
    // p and rest hold the props' getters; size read its value once.
    expect(body(out, "Button")).toContain("__rrApply(__n[0], __rrSpread, () => (");
    expect(body(out, "Button")).toContain('"class": p.size');
    expect(body(out, "Button")).toContain("__rrSlot(__n[1], () => (p.children))");
    expect(body(out, "Plain")).toContain("__rrApply(__n[0], __rrSpread, () => ({ ...props }))");
    const fixed = compileSource(`
      function Label(props) { const p = merge({ size: "m" }, props); return <b>{p.size}</b>; }
      export const App = () => <div><Label size="l" /></div>;
    `);
    expect(body(fixed, "Label")).toContain("clone([(p.size)])");
  });
});

// #endregion

// #region At runtime

describe("at runtime", () => {
  test("a reactive prop updates the child, through a component that passes it on", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void; renders: () => number }>(
      `
      import { render, signal } from "@reactre/core";
      const [n, setN] = signal(1);
      let renders = 0;
      function Label(props) { renders++; return <b class={props.n > 1 ? "big" : "small"}>{props.n}</b>; }
      function Pass(props) { return <Label n={props.n} />; }
      render(() => <div><Label n={n()} /><Pass n={n() * 10} /><Label n={5} /></div>, root);
      return { setN, renders: () => renders };
    `,
      root,
    );
    expect(html(root)).toBe('<div><b class="small">1</b><b class="big">10</b><b class="big">5</b></div>');
    api.setN(2);
    expect(html(root)).toBe('<div><b class="big">2</b><b class="big">20</b><b class="big">5</b></div>');
    // Components run once: the holes follow the props.
    expect(api.renders()).toBe(3);
  });

  test("a provider's code runs before its children are built", () => {
    const root = box();
    const api = run<{ log: string[] }>(
      `
      import { render } from "@reactre/core";
      const log = [];
      function Provider(props) { log.push("provider"); const out = <section>{props.children}</section>; log.push("provided"); return out; }
      function Child() { log.push("child"); return <i>child</i>; }
      function Bare(props) { log.push("bare"); return props.children; }
      render(() => <div><Provider><Child /></Provider><Bare><Child /></Bare></div>, root);
      return { log };
    `,
      root,
    );
    expect(api.log).toEqual(["provider", "child", "provided", "bare", "child"]);
    expect(html(root)).toBe("<div><section><i>child</i></section><i>child</i></div>");
  });

  test("children that may change are followed where the child inserts them", () => {
    const root = box();
    const api = run<{ setOn: (b: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [on, setOn] = signal(false);
      function Box(props) { return <div>{props.children}</div>; }
      render(() => <Box>{on() ? <b>on</b> : "off"}</Box>, root);
      return { setOn };
    `,
      root,
    );
    expect(html(root)).toBe("<div>off</div>");
    api.setOn(true);
    expect(html(root)).toBe("<div><b>on</b></div>");
  });

  test("a <For> row's components follow their reactive props without being rebuilt", () => {
    const root = box();
    const api = run<{ setSel: (n: number) => void; setRows: (r: unknown[]) => void; cells: () => number }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [rows, setRows] = signal([{ id: 1, label: "a" }, { id: 2, label: "b" }]);
      const [sel, setSel] = signal(1);
      let cells = 0;
      function Cell(props) { cells++; return <td class={props.on ? "on" : ""}>{props.label}</td>; }
      render(() => (
        <table><tbody>
          <For each={rows()} key={(r) => r.id}>{(row) => <tr><Cell on={sel() === row.id} label={row.label} /></tr>}</For>
        </tbody></table>
      ), root);
      return { setSel, setRows, cells: () => cells };
    `,
      root,
    );
    expect(html(root)).toBe('<table><tbody><tr><td class="on">a</td></tr><tr><td>b</td></tr></tbody></table>');
    api.setSel(2);
    expect(html(root)).toBe('<table><tbody><tr><td>a</td></tr><tr><td class="on">b</td></tr></tbody></table>');
    expect(api.cells()).toBe(2);
    api.setRows([{ id: 2, label: "b" }]);
    expect(html(root)).toBe('<table><tbody><tr><td class="on">b</td></tr></tbody></table>');
  });

  test("spread props keep the getters of the props they spread", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [n, setN] = signal(1);
      function Label(props) { return <b title={props.title}>{props.n}</b>; }
      function Forward(props) { return <Label title="t" {...props} />; }
      render(() => <div><Forward n={n()} /><Label {...{ n: 7 }} {...null} /></div>, root);
      return { setN };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>1</b><b>7</b></div>");
    api.setN(3);
    expect(html(root)).toBe("<div><b>3</b><b>7</b></div>");
  });

  test("a <Dynamic> component's reactive prop updates it", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void }>(
      `
      import { Dynamic, render, signal } from "@reactre/core";
      const [n, setN] = signal(1);
      function Label(props) { return <b>{props.n}</b>; }
      render(() => <div><Dynamic component={Label} n={n()} /></div>, root);
      return { setN };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>1</b></div>");
    api.setN(2);
    expect(html(root)).toBe("<div><b>2</b></div>");
  });

  test("JSX in a prop other than children renders: an element, a component, a fragment, an array, a conditional", () => {
    const root = box();
    const api = run<{ setOn: (v: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [on, setOn] = signal(true);
      function Card(props) { return <section><h1>{props.header}</h1>{props.children}</section>; }
      function Pattern({ header }) { return <p>{header}</p>; }
      function Title(props) { return <b>{props.t}</b>; }
      render(() => (
        <div>
          <Card header={<i>hi</i>}>body</Card>
          <Card header={<Title t="comp" />} />
          <Card header={<><b>a</b>frag</>} />
          <Card header={[<i>x</i>, <i>y</i>]} />
          <Card header={on() ? <b>yes</b> : "no"} />
          <Pattern header={<em>pat</em>} />
        </div>
      ), root);
      return { setOn };
    `,
      root,
    );
    const cards = [
      "<section><h1><i>hi</i></h1>body</section>",
      "<section><h1><b>comp</b></h1></section>",
      "<section><h1><b>a</b>frag</h1></section>",
      "<section><h1><i>x</i><i>y</i></h1></section>",
    ].join("");
    expect(html(root)).toBe(`<div>${cards}<section><h1><b>yes</b></h1></section><p><em>pat</em></p></div>`);
    api.setOn(false);
    expect(html(root)).toBe(`<div>${cards}<section><h1>no</h1></section><p><em>pat</em></p></div>`);
  });

  test("a component used as a value renders JSX and text in any prop, and follows them", () => {
    const root = box();
    const api = run<{ cards: unknown[]; setOn: (v: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [on, setOn] = signal(true);
      function Card(props) { return <h1>{props.header}|{props.text}</h1>; }
      render(() => <div><Card header={on() ? <i>hi</i> : "no"} text={on() ? "a" : "b"} /></div>, root);
      return { cards: [Card], setOn };
    `,
      root,
    );
    expect(api.cards.length).toBe(1);
    expect(html(root)).toBe("<div><h1><i>hi</i>|a</h1></div>");
    api.setOn(false);
    expect(html(root)).toBe("<div><h1>no|b</h1></div>");
  });

  test("a destructured prop keeps the value it had when the component ran", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [n, setN] = signal(1);
      function Label({ n }) { return <b>{n}</b>; }
      render(() => <div><Label n={n()} /></div>, root);
      return { setN };
    `,
      root,
    );
    api.setN(2);
    expect(html(root)).toBe("<div><b>1</b></div>");
  });

  test("a handler passed reactively is followed", () => {
    const root = box();
    const api = run<{ setMode: (m: string) => void; seen: string[] }>(
      `
      import { render, signal } from "@reactre/core";
      const [mode, setMode] = signal("a");
      const seen = [];
      const a = () => seen.push("a"), b = () => seen.push("b");
      function Btn(props) { return <button onClick={props.onClick}>go</button>; }
      render(() => <Btn onClick={mode() === "a" ? a : b} />, root);
      return { setMode, seen };
    `,
      root,
    );
    click(root.firstChild);
    api.setMode("b");
    click(root.firstChild);
    expect(api.seen).toEqual(["a", "b"]);
  });

  test("a template literal's call is reactive", () => {
    const root = box();
    const api = run<{ setN: (n: number) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const [n, setN] = signal(1);
      const unit = "!";
      render(() => <p title={\`t\${n()}\`}>{\`n is \${unit}\${n()}\`}</p>, root);
      return { setN };
    `,
      root,
    );
    api.setN(2);
    expect(html(root)).toBe("<p>n is !2</p>");
  });
});

// #endregion
