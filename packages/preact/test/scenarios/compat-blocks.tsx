/** @jsxImportSource preact/compat */
// Scenarios for compiled templates under compat: React's prop names and values, compiled with
// the compiler's "react" source. blocks.test.ts runs each on preact/compat as written and on
// @reactre/preact/compat compiled.

import type { Ctx } from "../same.ts";

type Scenario = (t: Ctx) => unknown;

export const scenarios: Record<string, Scenario> = {
  "React names and values in statics and holes": (t) => {
    const { render } = t.X;
    const view = (n: number, s: unknown) => (
      <div className="root" title={null as any} translate={"no" as any} data-n={n}>
        <svg strokeWidth={2} viewBox="0 0 1 1">
          <path strokeLinecap="round" fillOpacity={n} />
        </svg>
        <a download={true} href="#" style={{ width: 10, flexGrow: 1 }}>
          d
        </a>
        <b
          style={s as any}
          className={n > 1 ? "big" : "small"}
          // @ts-expect-error download is an anchor's prop; compat writes it on any element
          download={n > 1}
          translate={(n > 1 ? "no" : "yes") as any}
        >
          {n}
        </b>
        <p class="lit" id={String(n)} />
      </div>
    );
    render(view(1, { height: 2, zIndex: 3 }), t.c);
    t.snap("mount");
    render(view(2, { height: 2, opacity: 0.5 }), t.c);
    t.snap("update");
    render(view(3, null), t.c);
    t.snap("null style");
  },

  "event renames in holes": (t) => {
    const { render } = t.X;
    const log = (name: string) => (e: any) => t.log(name, e.type, typeof e.persist);
    render(
      <div
        // @ts-expect-error React's name, which compat renames
        onDoubleClick={log("dbl")}
        onFocus={log("focus")}
        onBlur={log("blur")}
        onClick={null as any}
      >
        <span onChange={log("change")} onInput={log("input")}>
          {"x"}
        </span>
      </div>,
      t.c,
    );
    const div = t.c.firstChild as any;
    t.fire(div, "dblclick");
    t.fire(div, "focusin");
    t.fire(div, "focusout");
    t.fire(div.firstChild, "change");
    t.fire(div.firstChild, "input");
  },

  "a block is a React element": (t) => {
    const { isValidElement, Children, cloneElement, render } = t.X;
    const el = (
      <p className="a" title={"t" as string}>
        <b>{"x"}</b>
      </p>
    );
    t.log("valid", isValidElement(el), typeof (el as any).$$typeof);
    t.log("count", Children.count(el.props.children));
    render(cloneElement(el, { className: "c" }), t.c);
    t.snap("cloned");
  },

  "a suspended subtree of blocks comes back with its props revalidated": async (t) => {
    const { render, Suspense, lazy, useState } = t.X;
    let resolve!: (v: unknown) => void;
    const Lazy = lazy(() => new Promise((r) => (resolve = r)));
    let show: any;
    function App() {
      const [s, set] = useState(false);
      show = set;
      return (
        <Suspense fallback={<p className="wait">{"loading"}</p>}>
          <div className="kept" title={s ? "s" : "n"}>
            <b>{s ? "on" : "off"}</b>
          </div>
          {s && <Lazy />}
        </Suspense>
      );
    }
    render(<App />, t.c);
    show(true);
    await t.tick();
    t.snap("fallback");
    resolve({ default: () => <i className="lazy">{"done"}</i> });
    await t.tick();
    await t.tick();
    t.snap("resolved");
  },
};
