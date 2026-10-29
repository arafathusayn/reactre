/** @jsxImportSource preact */
// The `html` tag against JSX: each scenario has its view written twice, as JSX (run on Preact)
// and as an `html` tagged template (run on @reactre/preact). html.test.ts compares the two
// transcripts, so a tagged template must render exactly what the same JSX renders on Preact.

import type { Ctx } from "../same.ts";

/** A scenario: its run, given the view for the runtime (JSX on Preact, `html` on ours). */
export interface Pair {
  run: (t: Ctx, view: any) => unknown;
  jsx: (t: Ctx) => any;
  html: (t: Ctx) => any;
}

// A custom element, by a name JSX's types accept.
const XEl = "x-el" as any;

export const pairs: Record<string, Pair> = {
  "statics, holes, attribute order and text": {
    jsx: () => (a: string, b: unknown, n: number) => (
      <div id="s" title={a} data-x="lit" aria-label={b as string} hidden={false} tabIndex={0}>
        <p class="c">
          text <b>bold</b> {n} of {3}
        </p>
        <i style="color: red" />
        {a} and {n}
      </div>
    ),
    html: (t) => (a: string, b: unknown, n: number) => t.R.html`
      <div id="s" title=${a} data-x="lit" aria-label=${b} hidden=${false} tabIndex=${0}>
        <p class="c">
          text <b>bold</b> ${n} of ${3}
        </p>
        <i style="color: red" />
        ${a} and ${n}
      </div>
    `,
    run: (t, view) => {
      t.R.render(view("a", "b", 1), t.c);
      t.snap("mount");
      t.R.render(view("a2", null, 2), t.c);
      t.snap("update");
    },
  },

  "a quoted attribute mixing text and values, bare attributes, comments": {
    jsx: () => (a: string) => (
      <p class={`x ${a} y`} title={"t"} hidden>
        {"in"}
      </p>
    ),
    html: (t) => (a: string) => t.R.html`<p class="x ${a} y" title='t' hidden><!-- a comment -->in</p>`,
    run: (t, view) => {
      t.R.render(view("1"), t.c);
      t.R.render(view("2"), t.c);
      t.snap("attrs");
    },
  },

  "keyed lists, components, children and closing forms": {
    jsx: () => {
      const Item = (p: { n: number; children?: any }) => (
        <li class="item">
          {p.n}
          {p.children}
        </li>
      );
      return (keys: number[]) => (
        <ul>
          {keys.map((k) => (
            <Item key={k} n={k}>
              <b>{k * 2}</b>
            </Item>
          ))}
          <Item n={0} />
          <Item n={-1}>end</Item>
        </ul>
      );
    },
    html: (t) => {
      const { html } = t.R;
      const Item = (p: { n: number; children?: any }) => html`<li class="item">${p.n}${p.children}</li>`;
      return (keys: number[]) =>
        html`<ul>
          ${keys.map((k) => html`<${Item} key=${k} n=${k}><b>${k * 2}</b></${Item}>`)}
          <${Item} n=${0} />
          <${Item} n=${-1}>end<//>
        </ul>`;
    },
    run: (t, view) => {
      t.R.render(view([1, 2, 3]), t.c);
      const first = (t.c.firstChild as any).firstChild;
      t.R.render(view([3, 1, 4]), t.c);
      t.log("kept", (t.c.firstChild as any).childNodes[1] === first);
      t.snap("list");
    },
  },

  "spread props, refs, keys inside, form fields and custom elements stay vnodes": {
    jsx: () => (o: object, r: unknown) => (
      <div>
        <p {...o} class="after" />
        <i ref={r as any}>{"r"}</i>
        <input value="v" disabled />
        <XEl a="1" />
        <span>
          <b key="k">k</b>
        </span>
        <p dangerouslySetInnerHTML={{ __html: "<u>h</u>" }} />
      </div>
    ),
    html: (t) => (o: object, r: unknown) =>
      t.R.html`<div>
        <p ...${o} class="after" />
        <i ref=${r}>r</i>
        <input value="v" disabled />
        <x-el a="1" />
        <span><b key="k">k</b></span>
        <p dangerouslySetInnerHTML=${{ __html: "<u>h</u>" }} />
      </div>`,
    run: (t, view) => {
      const r = t.R.createRef();
      t.R.render(view({ id: "spread", title: "t" }, r), t.c);
      t.log("ref", r.current === (t.c.firstChild as any).childNodes[1]);
      t.R.render(view({ id: "s2" }, r), t.c);
      t.snap("plain");
    },
  },

  "events, svg, several roots and top-level text": {
    jsx: (t) => (n: number) => [
      <button onClick={() => t.log("click", n)}>go</button>,
      <svg viewBox="0 0 1 1">
        <circle r={n} />
      </svg>,
      "tail",
    ],
    html: (t) => (n: number) =>
      t.R
        .html`<button onClick=${() => t.log("click", n)}>go</button><svg viewBox="0 0 1 1"><circle r=${n} /></svg>tail`,
    run: (t, view) => {
      t.R.render(view(1), t.c);
      t.R.render(view(2), t.c);
      t.fire(t.c.firstChild, "click");
      t.snap("roots");
      t.log((t.c.childNodes[1] as any).firstChild.namespaceURI);
    },
  },

  "a single value and whitespace-only templates": {
    jsx: () => (x: unknown) => <p>{x as any}</p>,
    html: (t) => (x: unknown) => t.R.html`<p>${x}</p>`,
    run: (t, view) => {
      t.R.render(view("one"), t.c);
      t.R.render(view(["a", "b"]), t.c);
      t.R.render(view(null), t.c);
      t.snap("value");
    },
  },

  "compat: React's prop names in templates and vnodes": {
    jsx: (t) => (n: number) => (
      <div
        className={n > 1 ? "big" : "small"}
        // @ts-expect-error React's names, which compat renames
        onDoubleClick={() => t.log("dbl", n)}
        translate={"no" as any}
      >
        <svg strokeWidth={n} viewBox="0 0 1 1" />
        <a download href="#" title={null as any}>
          d
        </a>
        <p className="lit" style={{ width: n }} />
      </div>
    ),
    html: (t) => (n: number) =>
      t.X.html`<div className=${n > 1 ? "big" : "small"} onDoubleClick=${() => t.log("dbl", n)} translate="no">
        <svg strokeWidth=${n} viewBox="0 0 1 1" />
        <a download href="#" title=${null}>d</a>
        <p className="lit" style=${{ width: n }} />
      </div>`,
    run: (t, view) => {
      t.X.render(view(1), t.c);
      t.X.render(view(2), t.c);
      t.fire(t.c.firstChild, "dblclick");
      t.snap("compat");
    },
  },

  "bare and unquoted values, CRLF text, a value where a name goes": {
    jsx: () => (x: string) => (
      <p data-a="b" title="t">
        {"one two"}
        {x}
      </p>
    ),
    html: (t) => (x: string) =>
      t.R.html(["<p data-a=b ", ' title="t">\r\n  one\r\n  two\r\n  ', "</p>"] as any, "ignored", x),
    run: (t, view) => {
      t.R.render(view("x"), t.c);
      t.snap("edge");
    },
  },
};
