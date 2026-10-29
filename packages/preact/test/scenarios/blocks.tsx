/** @jsxImportSource preact */
// Scenarios for compiled templates. blocks.test.ts runs each on Preact 11.1.0 as written, and on
// @reactre/preact with this file compiled by @reactre/preact/compiler, so the JSX here becomes
// blocks. The transcripts must be equal.
//
// The JSX is what decides what the compiler makes: literal props are template statics, other
// props holes; static children are inlined; any other children are one children hole.

import type { Ctx } from "../same.ts";

type Scenario = (t: Ctx) => unknown;

export const scenarios: Record<string, Scenario> = {
  "statics, prop holes and attribute order": (t) => {
    const { render } = t.R;
    const view = (a: unknown, b: unknown) => (
      <div id="s" title={a as string} data-x="lit" aria-label={b as string} hidden={false} tabIndex={0} dir={undefined}>
        <p class="c">
          text<b>bold</b>
          {1}
        </p>
        <i style="color: red" />
      </div>
    );
    render(view("a", "b"), t.c);
    t.snap("mount");
    render(view("a2", null), t.c);
    t.snap("update");
    render(view(undefined, "x"), t.c);
    t.snap("again");
  },

  "children holes: text, numbers, arrays, components and nothing": async (t) => {
    const { render, useState } = t.R;
    let set: any;
    const Item = (p: { n: number }) => <li class="item">{p.n}</li>;
    function App() {
      const [n, s] = useState(0);
      set = s;
      return (
        <section>
          <h1>{n % 2 ? "odd" : n}</h1>
          <ul>
            {Array.from({ length: n }, (_, i) => (
              <Item key={i} n={i} />
            ))}
          </ul>
          <p>
            {n} of {3}
          </p>
          <div>{n == 2 ? null : <b>{n}</b>}</div>
          <span>{n == 1 ? <i>one</i> : "text"}</span>
          <em>{n == 3 ? [<u key="a">a</u>, "b"] : n}</em>
        </section>
      );
    }
    render(<App />, t.c);
    t.snap("0");
    for (const n of [1, 2, 3, 0]) {
      set(n);
      await t.tick();
      t.snap(String(n));
    }
  },

  "a keyed list of blocks reorders like elements": (t) => {
    const { render } = t.R;
    const list = (keys: string[]) => (
      <ul>
        {keys.map((k) => (
          <li key={k} class="row">
            <span>{k}</span>
            <a onClick={() => t.log("click", k)}>x</a>
          </li>
        ))}
      </ul>
    );
    render(list(["a", "b", "c", "d"]), t.c);
    const first = (t.c.firstChild as any).firstChild;
    render(list(["d", "b", "a", "c", "e"]), t.c);
    t.snap("moved");
    t.log("kept", (t.c.firstChild as any).childNodes[2] === first);
    render(list(["e", "a"]), t.c);
    t.fire((t.c.firstChild as any).lastChild.lastChild, "click");
    t.snap("removed");
    render(list([]), t.c);
    t.snap("empty");
  },

  "events in holes: swapped in place, removed, and dropped on unmount": (t) => {
    const { render } = t.R;
    let held: any;
    const view = (f: unknown) => (
      <div>
        <button onClick={f as any} ref={(n: any) => (held = held || n)}>
          b
        </button>
        <a onClick={f as any}>a</a>
      </div>
    );
    render(
      view(() => t.log("one")),
      t.c,
    );
    const a = (t.c.firstChild as any).lastChild;
    t.fire(a, "click");
    render(
      view(() => t.log("two")),
      t.c,
    );
    t.fire(a, "click");
    render(view(undefined), t.c);
    t.fire(a, "click");
    render(
      view(() => t.log("three")),
      t.c,
    );
    t.fire(a, "click");
    render(null, t.c);
    t.fire(a, "click");
    t.log("held", !!held);
  },

  "templates swap: another template, a plain element, a component": async (t) => {
    const { render, createElement: h } = t.R;
    const A = (x: unknown) => (
      <div class="a">
        <b>{x as any}</b>
      </div>
    );
    const B = (x: unknown) => (
      <div class="b" title={x as string}>
        <i>static</i>
      </div>
    );
    render(A(1), t.c);
    render(B("t"), t.c);
    t.snap("a to b");
    render(A(<u>{2}</u>), t.c);
    t.snap("b to a");
    render(h("div", { class: "plain" }, h("b", null, "p")), t.c);
    t.snap("a to plain");
    render(A("back"), t.c);
    t.snap("plain to a");
    render(<p>{A("nested")}</p>, t.c);
    render(<p>{B("nested")}</p>, t.c);
    t.snap("nested");
  },

  "the same block rendered twice, and reused when nothing changed": (t) => {
    const { render } = t.R;
    const el = (
      <b title="t">
        <i>x</i>
      </b>
    );
    const view = (
      <div>
        {el}
        {el}
      </div>
    );
    render(view, t.c);
    render(view, t.c);
    render(
      <div>
        {el}
        {el}
        {el}
      </div>,
      t.c,
    );
    t.snap("copies");
  },

  "namespaces: svg, foreignObject and math": (t) => {
    const { render } = t.R;
    const view = (r: number) => (
      <div>
        <svg viewBox="0 0 10 10" class="icon">
          <circle r={r} cx="5" fill="red" />
          <g>{r > 1 ? <rect width={r} /> : null}</g>
          <foreignObject>
            <p class="html">{r}</p>
          </foreignObject>
        </svg>
        <math>
          <mi>
            <b>{r}</b>
          </mi>
        </math>
      </div>
    );
    render(view(1), t.c);
    render(view(2), t.c);
    t.snap("ns");
    const svg = (t.c.firstChild as any).firstChild;
    t.log(
      svg.namespaceURI,
      svg.firstChild.namespaceURI,
      svg.lastChild.firstChild.namespaceURI,
      (t.c.firstChild as any).lastChild.namespaceURI,
    );
    // A block whose root is created inside an svg parent.
    render(
      <svg>
        {[1, 2].map((n) => (
          <circle key={n} r={n} />
        ))}
      </svg>,
      t.c,
    );
    t.snap("svg list");
  },

  "styles and DOM properties in holes": (t) => {
    const { render } = t.R;
    const view = (s: unknown, n: number) => (
      <div style={s as any} tabIndex={n} draggable={n > 1} class={n > 1 ? "big" : undefined}>
        x
      </div>
    );
    render(view({ color: "red", width: "1px" }, 1), t.c);
    render(view({ color: "blue" }, 2), t.c);
    render(view("margin: 0", 3), t.c);
    render(view(null, 1), t.c);
    t.snap("props");
    t.log("style", (t.c.firstChild as any).style.log);
  },

  "props of a block as a component sees them": (t) => {
    const { render, cloneElement, toChildArray } = t.R;
    function Show(p: { children: any }) {
      for (const c of toChildArray(p.children) as any[])
        t.log(
          "child",
          c.type,
          JSON.stringify(c.props, (k, v) => (k.startsWith("__") ? undefined : v)),
        );
      return <div>{p.children}</div>;
    }
    const kid = (x: unknown) => (
      <p class="k" title={x as string}>
        a<b>{x as any}</b>
      </p>
    );
    render(
      <Show>
        {kid("one")}
        <i />
      </Show>,
      t.c,
    );
    const clone = cloneElement(kid("two"), { id: "c" });
    render(<Show>{clone}</Show>, t.c);
    t.snap("cloned");
  },

  "a component returning blocks moves its DOM and finds siblings": async (t) => {
    const { render, Component, Fragment } = t.R;
    let set: any;
    const Swap: any = class extends Component<any, any> {
      state = { a: true };
      render() {
        set = (a: boolean) => this.setState({ a });
        return this.state.a ? (
          <i>{"a"}</i>
        ) : (
          <Fragment>
            {null}
            <b>{"b"}</b>
          </Fragment>
        );
      }
    };
    render(
      <div>
        <Swap />
        <s>{"s"}</s>
      </div>,
      t.c,
    );
    set(false);
    await t.tick();
    t.snap("b");
    set(true);
    await t.tick();
    t.snap("a");
  },

  "hydrating over server DOM": (t) => {
    const { hydrate } = t.R;
    t.c.innerHTML = '<div class="h"><p title="x">hi<b>1</b></p><a>link</a></div>';
    const p = (t.c.firstChild as any).firstChild;
    hydrate(
      <div class="h">
        <p title="x">
          hi<b>{1}</b>
        </p>
        <a onClick={() => t.log("clicked")}>link</a>
      </div>,
      t.c,
    );
    t.log("kept", (t.c.firstChild as any).firstChild === p);
    t.fire((t.c.firstChild as any).lastChild, "click");
    t.snap("hydrated");
  },

  "rendering over existing DOM claims it": (t) => {
    const { render } = t.R;
    t.c.innerHTML = '<p data-old="1">old</p><i></i>';
    render(
      <p title="new">
        <b>{"x"}</b>
      </p>,
      t.c,
    );
    t.snap("claimed");
  },

  "a ref and a key inside a tree keep it a plain element": (t) => {
    const { render, createRef, createElement: h } = t.R;
    const r = createRef();
    render(
      <div>
        <i ref={r}>{"r"}</i>
        {[<b key="k">k</b>]}
        <input value="v" />
        {h("x-custom", { a: "1" })}
        <p {...{ id: "spread" }} />
        <p dangerouslySetInnerHTML={{ __html: "<u>h</u>" }} />
        <p class="a" className="b" />
      </div>,
      t.c,
    );
    t.log("ref", r.current === (t.c.firstChild as any).firstChild);
    t.snap("plain");
  },

  "an error below a block reaches the boundary": async (t) => {
    const { render, Component } = t.R;
    const Boom = () => {
      throw new Error("boom");
    };
    const B: any = class extends Component<any, any> {
      state = { e: "" };
      static getDerivedStateFromError(e: Error) {
        return { e: e.message };
      }
      render() {
        return this.state.e ? <p class="err">{this.state.e}</p> : <div>{this.props.children}</div>;
      }
    };
    render(
      <B>
        <span>{"before"}</span>
        <Boom />
      </B>,
      t.c,
    );
    await t.tick();
    t.snap("caught");
  },

  "options hooks see block vnodes": (t) => {
    const { render, options } = t.R;
    const seen: string[] = [];
    const old = options.diffed;
    options.diffed = (v: any) => {
      if (typeof v.type == "string") seen.push(v.type);
      old?.(v);
    };
    render(
      <div title="t">
        <b>{"x"}</b>
      </div>,
      t.c,
    );
    options.diffed = old;
    t.log("diffed", seen.includes("div"));
  },
};
