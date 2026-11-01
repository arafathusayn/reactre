// The features of this release together, written as JSX and compiled as the plugin compiles a
// file seen alone: context and error boundaries through lazy children, reactive props through
// the store's props helpers, control flow and <For> rows. Each feature has tests of its own
// (context.test.ts, errors.test.ts, store.test.ts, flow.test.ts, the compiler's props.test.ts);
// these check what only shows when they meet.
//
// Importing the feature modules installs them in the one runtime instance every test file
// shares, as their own test files do.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as context from "../src/features/context.ts";
import * as errors from "../src/features/errors.ts";
import { configureClientErrors } from "../src/features/errors.ts";
import * as store from "../src/features/store.ts";
import * as core from "../src/index.ts";

/** What a source's imports of @reactre/core and of its feature modules bind to. */
const runtime = { ...core, ...context, ...errors, ...store };

beforeEach(installFakeDocument);
afterEach(() => configureClientErrors({}));

/** Compile a TSX module body ending in `return { ... }` and run it, `root` in scope. */
function run<T>(src: string, root: FakeElement): T {
  const js = compileSource(src).replace(
    /^import \{([^}]*)\} from "@reactre\/core(?:\/features\/\w+)?";$/gm,
    (_, names: string) =>
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

const text = (n: FakeElement): string => n.textContent ?? "";

type Api = Record<string, (...a: never[]) => unknown>;

describe("context through JSX", () => {
  test("<Ctx value> provides to its children, written as JSX; outside it, the default", () => {
    const root = box();
    run(
      `
      import { render } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const Label = () => <b>{useContext(Theme)}</b>;
      render(() => <div><Label /><Theme value="dark"><Label /></Theme><Label /></div>, root);
      return {};
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>light</b><b>dark</b><b>light</b></div>");
  });

  test("nested providers: the nearest wins, and the outer one is back after the inner one", () => {
    const root = box();
    run(
      `
      import { render } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const Size = createContext(1);
      const Label = () => <b>{useContext(Theme)}{useContext(Size)}</b>;
      render(
        () => (
          <Theme value="dark">
            <Label />
            <Size value={2}>
              <Theme value="blue"><Label /></Theme>
              <Label />
            </Size>
            <Label />
          </Theme>
        ),
        root,
      );
      return {};
    `,
      root,
    );
    expect(text(root)).toBe("dark1blue2dark2dark1");
  });

  test("a slot's later content, and a direct child that may change, find the provider", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const [more, setMore] = signal(false);
      let labels = 0;
      const Label = () => (labels++, <b>{useContext(Theme)}</b>);
      render(
        () => (
          <div>
            <Theme value="dark">
              <p>{more() ? <Label /> : "-"}</p>
              {more() ? <Label /> : null}
            </Theme>
          </div>
        ),
        root,
      );
      return { setMore, labels: () => labels };
    `,
      root,
    );
    expect(text(root)).toBe("-");
    api.setMore!(true as never);
    expect(text(root)).toBe("darkdark");
    api.setMore!(false as never);
    expect(text(root)).toBe("-");
  });

  test("<For> rows made later find the provider, and so do the components in them", () => {
    const root = box();
    const api = run<Api>(
      `
      import { For, render, signal } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const [rows, setRows] = signal([]);
      const Label = (props) => <b>{props.n}{useContext(Theme)}</b>;
      render(
        () => (
          <Theme value="dark">
            <ul><For each={rows()} key={(r) => r}>{(r) => <li><Label n={r} /></li>}</For></ul>
          </Theme>
        ),
        root,
      );
      return { setRows };
    `,
      root,
    );
    expect(text(root)).toBe("");
    api.setRows!([1, 2] as never);
    expect(text(root)).toBe("1dark2dark");
    api.setRows!([2, 3] as never);
    expect(text(root)).toBe("2dark3dark");
  });

  test("a component's children passed on to a provider are built inside it", () => {
    const root = box();
    run(
      `
      import { render } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const Label = () => <b>{useContext(Theme)}</b>;
      function Dark(props) { return <section><Theme value="dark">{props.children}</Theme></section>; }
      render(() => <Dark><Label /><i><Label /></i></Dark>, root);
      return {};
    `,
      root,
    );
    expect(html(root)).toBe("<section><b>dark</b><i><b>dark</b></i></section>");
  });

  test("a provided signal's read function, passed reactively, follows the signal", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext(() => "light");
      const [theme, setTheme] = signal("dark");
      const Label = () => <b>{useContext(Theme)()}</b>;
      render(() => <Theme value={theme}><Label /></Theme>, root);
      return { setTheme };
    `,
      root,
    );
    expect(text(root)).toBe("dark");
    api.setTheme!("blue" as never);
    expect(text(root)).toBe("blue");
  });
});

describe("error boundaries through JSX", () => {
  test("a throw in a child's component body shows the fallback; reset builds the child again", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      let bad = true, built = 0, retry;
      function Child() {
        built++;
        if (bad) throw new Error("body");
        return <b>ok</b>;
      }
      render(
        () => (
          <div>
            <Errored fallback={(e, reset) => ((retry = reset), <i>{e.message}</i>)}><Child /></Errored>
          </div>
        ),
        root,
      );
      return { fix: () => (bad = false), retry: () => retry(), built: () => built };
    `,
      root,
    );
    expect(html(root)).toBe("<div><i>body</i></div>");
    expect(api.built!()).toBe(1);
    api.fix!();
    api.retry!();
    expect(html(root)).toBe("<div><b>ok</b></div>");
    expect(api.built!()).toBe(2);
  });

  test("a throw in an update, through a reactive prop, shows the fallback; reset builds fresh nodes", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [n, setN] = signal(0);
      const fail = (v) => { throw new Error("bad " + v); };
      let built = 0, retry;
      function Count(props) {
        built++;
        return <b>{props.n === 1 ? fail(props.n) : props.n}</b>;
      }
      render(
        () => (
          <div>
            <Errored fallback={(e, reset) => ((retry = reset), <i>{e.message}</i>)}>
              <Count n={n()} />
            </Errored>
          </div>
        ),
        root,
      );
      return { setN, retry: () => retry(), built: () => built, first: () => root.firstChild.firstChild };
    `,
      root,
    );
    expect(text(root)).toBe("0");
    const before = api.first!();
    api.setN!(2 as never);
    expect(text(root)).toBe("2");
    expect(api.first!()).toBe(before);
    expect(api.built!()).toBe(1);
    api.setN!(1 as never);
    expect(html(root)).toBe("<div><i>bad 1</i></div>");
    api.setN!(3 as never);
    expect(text(root)).toBe("bad 1");
    api.retry!();
    expect(html(root)).toBe("<div><b>3</b></div>");
    expect(api.built!()).toBe(2);
    expect(api.first!()).not.toBe(before);
    api.setN!(4 as never);
    expect(text(root)).toBe("4");
  });

  test("the children getter builds new nodes each time it is read", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      let seen = [];
      function Peek(props) { seen.push(props.children, props.children); return <p>{props.children}</p>; }
      render(() => <Peek><b>x</b></Peek>, root);
      return { seen: () => seen };
    `,
      root,
    );
    const [a, b] = api.seen!() as FakeElement[];
    expect(a).toBeInstanceOf(FakeElement);
    expect(a).not.toBe(b);
    expect(html(root)).toBe("<p><b>x</b></p>");
  });

  test("a boundary inside a provider: the fallback and the rebuilt children find the provider", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      import { Errored } from "@reactre/core/features/errors";
      const Theme = createContext("light");
      const [bad, setBad] = signal(false);
      let retry;
      function Child() { return <b>{bad() ? (() => { throw new Error(useContext(Theme)); })() : useContext(Theme)}</b>; }
      render(
        () => (
          <Theme value="dark">
            <Errored fallback={(e, reset) => ((retry = reset), <i>{e.message}:{useContext(Theme)}</i>)}>
              <Child />
            </Errored>
          </Theme>
        ),
        root,
      );
      return { setBad, retry: () => retry() };
    `,
      root,
    );
    expect(text(root)).toBe("dark");
    api.setBad!(true as never);
    expect(text(root)).toBe("dark:dark");
    api.setBad!(false as never);
    api.retry!();
    expect(text(root)).toBe("dark");
  });

  test("a child that may change, directly under a boundary, is followed and caught", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [n, setN] = signal(0);
      function Bad() { throw new Error("bad"); }
      render(
        () => <div><Errored fallback={(e) => <i>{e.message}</i>}><b>a</b>{n() > 0 ? <Bad /> : "b"}</Errored></div>,
        root,
      );
      return { setN };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>a</b>b</div>");
    api.setN!(1 as never);
    expect(html(root)).toBe("<div><i>bad</i></div>");
  });
});

describe("reactive props with the store's props helpers", () => {
  test("merge's defaults: a hole that reads the merged props follows a reactive prop", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { merge } from "@reactre/core/features/store";
      const [size, setSize] = signal("l");
      function Button(props) {
        const p = merge({ size: "m", label: "go" }, props);
        return <button class={p.size}>{p.label}</button>;
      }
      render(() => <div><Button size={size()} /><Button label="stop" /></div>, root);
      return { setSize };
    `,
      root,
    );
    expect(html(root)).toBe('<div><button class="l">go</button><button class="m">stop</button></div>');
    api.setSize!("s" as never);
    expect(html(root)).toBe('<div><button class="s">go</button><button class="m">stop</button></div>');
  });

  test("merge and omit keep getters, spread into a component and into an element", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { merge, omit } from "@reactre/core/features/store";
      const [n, setN] = signal(1);
      function Inner(props) { return <i class={props.cls}>{props.n}</i>; }
      function Outer(props) {
        const rest = omit(props, "label");
        return <p>{props.label}<Inner {...merge({ cls: "x" }, rest)} /><span {...rest} /></p>;
      }
      render(() => <Outer label="a" n={n()} title={"t" + n()} />, root);
      return { setN, span: () => root.firstChild.lastChild };
    `,
      root,
    );
    expect(html(root)).toBe('<p>a<i class="x">1</i><span></span></p>');
    expect((api.span!() as FakeElement).getAttribute("title")).toBe("t1");
    api.setN!(2 as never);
    expect(html(root)).toBe('<p>a<i class="x">2</i><span></span></p>');
    expect((api.span!() as FakeElement).getAttribute("title")).toBe("t2");
  });

  test("a store's reads passed as props: a member read and a call are both getters", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ title: "a" });
      function Label(props) { return <b>{props.text}</b>; }
      render(() => <p><Label text={s.title} /><Label text={s.title.trim()} /></p>, root);
      return { rename: (t) => set((d) => { d.title = t; }) };
    `,
      root,
    );
    expect(text(root)).toBe("aa");
    api.rename!("b" as never);
    expect(text(root)).toBe("bb");
  });
});

describe("reactive props with control flow and lists", () => {
  test("<Show when={props.x}> in a component given a reactive x", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, Show, signal } from "@reactre/core";
      const [on, setOn] = signal(false);
      let built = 0;
      const Yes = () => (built++, <b>yes</b>);
      function Toggle(props) { return <div><Show when={props.x} fallback={<i>no</i>}><Yes /></Show></div>; }
      render(() => <Toggle x={on()} />, root);
      return { setOn, built: () => built };
    `,
      root,
    );
    expect(html(root)).toBe("<div><i>no</i></div>");
    api.setOn!(true as never);
    expect(html(root)).toBe("<div><b>yes</b></div>");
    api.setOn!(1 as never);
    expect(api.built!()).toBe(1);
    api.setOn!(false as never);
    expect(html(root)).toBe("<div><i>no</i></div>");
  });

  test("a <Show> whose children are a component's reactive children", () => {
    const root = box();
    const api = run<Api>(
      `
      import { render, Show, signal } from "@reactre/core";
      const [on, setOn] = signal(true);
      const [n, setN] = signal(1);
      function Maybe(props) { return <div><Show when={props.when}>{props.children}</Show></div>; }
      render(() => <Maybe when={on()}><b>{n()}</b></Maybe>, root);
      return { setOn, setN };
    `,
      root,
    );
    expect(html(root)).toBe("<div><b>1</b></div>");
    api.setN!(2 as never);
    expect(html(root)).toBe("<div><b>2</b></div>");
    api.setOn!(false as never);
    expect(html(root)).toBe("<div></div>");
    api.setOn!(true as never);
    expect(html(root)).toBe("<div><b>2</b></div>");
  });

  test("<For> rows of components with reactive props follow them in place, from a store too", () => {
    const root = box();
    const api = run<Api>(
      `
      import { For, render, signal } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Mark = createContext("*");
      const [s, set] = createStore({ todos: [{ id: 1, title: "a" }, { id: 2, title: "b" }] });
      const [sel, setSel] = signal(1);
      let items = 0;
      function Item(props) {
        items++;
        return <span class={props.on ? "on" : ""}>{props.title}{props.on ? useContext(Mark) : ""}</span>;
      }
      render(
        () => (
          <Mark value="!">
            <ul>
              <For each={[...s.todos]} key={(t) => t.id}>
                {(t) => <li><Item title={t.title.trim()} on={sel() === t.id} /></li>}
              </For>
            </ul>
          </Mark>
        ),
        root,
      );
      return {
        setSel,
        rename: (i, t) => set((d) => { d.todos[i].title = t; }),
        add: (id, title) => set((d) => { d.todos.push({ id, title }); }),
        items: () => items,
      };
    `,
      root,
    );
    const li = (on: string, t: string) => `<li><span${on ? ' class="on"' : ""}>${t}</span></li>`;
    expect(html(root)).toBe(`<ul>${li("on", "a!")}${li("", "b")}</ul>`);
    api.setSel!(2 as never);
    expect(html(root)).toBe(`<ul>${li("", "a")}${li("on", "b!")}</ul>`);
    api.rename!(0 as never, "A" as never);
    expect(html(root)).toBe(`<ul>${li("", "A")}${li("on", "b!")}</ul>`);
    expect(api.items!()).toBe(2);
    api.add!(3 as never, "c" as never);
    api.setSel!(3 as never);
    expect(html(root)).toBe(`<ul>${li("", "A")}${li("", "b")}${li("on", "c!")}</ul>`);
    expect(api.items!()).toBe(3);
  });
});
