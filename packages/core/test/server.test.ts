// Server rendering (@reactre/core/server), on the unbundled runtime: TSX sources compiled with
// @reactre/compiler's server mode and rendered with renderToString, renderToStream and
// renderToStringAsync; the same sources compiled for the client and rendered on the fake DOM, to
// compare the HTML; and the runtime's helpers one by one.
//
// A context's provider and <Errored> run on the server's `__frag` only in a server build, where
// @reactre/plugin points the feature modules at @reactre/core/server: they are tested through real
// builds in packages/plugin/test/ssr.test.ts. Here the async runtime is turned on before the tests
// and off after them, as in async.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileSource, reactreCompiler } from "@reactre/compiler";
import { FakeElement, type FakeNode, FakeText, installFakeDocument, withStyles } from "@reactre/testdom";

import * as asyncApi from "../src/features/async.ts";
import { __hooks } from "../src/features/async.ts";
import { configureClientErrors, Errored } from "../src/features/errors.ts";
import * as indexApi from "../src/features/index.ts";
import * as memoApi from "../src/features/memo.ts";
import * as timing from "../src/features/timing.ts";
import * as core from "../src/index.ts";
import * as browser from "../src/server.browser.ts";
import * as server from "../src/server.ts";
import * as serverAsync from "../src/server/async.ts";
import * as serverDynamic from "../src/server/dynamic.ts";
import * as serverEffects from "../src/server/effects.ts";
import * as serverErrors from "../src/server/errors.ts";
import * as serverReaction from "../src/server/reaction.ts";
import * as serverTiming from "../src/server/timing.ts";

const SVG = "http://www.w3.org/2000/svg";

// #region Harness

let body: FakeElement;
let unstyle: () => void;

beforeAll(() => {
  core.__installAsync(__hooks);
  unstyle = withStyles();
  // classList's toggle over the class attribute, as flow.test.ts gives the fake DOM one.
  Object.defineProperty(FakeElement.prototype, "classList", {
    configurable: true,
    get(this: FakeElement) {
      const el = this;
      const list = () => (el.getAttribute("class") ?? "").split(" ").filter(Boolean);
      return {
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
  core.__installAsync(false);
  unstyle();
  delete (FakeElement.prototype as unknown as Record<string, unknown>)["classList"];
  installFakeDocument();
});
beforeEach(() => {
  installFakeDocument();
  body = new FakeElement("BODY");
  Object.assign(globalThis.document, {
    body,
    createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  });
});
afterEach(() => configureClientErrors({}));

/** What a server-compiled source's imports bind to, by specifier. */
const serverModules: Record<string, unknown> = {
  "@reactre/core/server": server,
  "@reactre/core/server/async": serverAsync,
  "@reactre/core/server/dynamic": serverDynamic,
  "@reactre/core/features/errors": {},
  // Unbundled, features/memo's core is the one the server's re-exports.
  "@reactre/core/features/memo": memoApi,
};
/** What a client-compiled source's imports bind to. */
const clientModules: Record<string, unknown> = {
  "@reactre/core": core,
  "@reactre/core/features/memo": memoApi,
  "@reactre/core/features/async": asyncApi,
  "@reactre/core/features/index": indexApi,
};

/** Run compiled module `js` (a body ending in `return { ... }`), its imports bound to `modules`. */
function load<T>(js: string, modules: Record<string, unknown>): T {
  const code = js
    .replace(/^(\s*)export /gm, "$1")
    .replace(/^import "[^"]*";/gm, "")
    .replace(/import \{([^}]*)\} from "(@reactre\/core[^"]*)";/g, (_, names: string, from: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr[${JSON.stringify(from)}].${a};`;
        })
        .join("\n"),
    );
  return new Function("rr", code)(modules) as T;
}

/** A TSX module body ending in `return { ... }`, compiled for the server and run. */
const ssr = <T>(src: string): T => load<T>(compileSource(src, "tsx", { server: true }), serverModules);
/** The same, compiled for the client. */
const csr = <T>(src: string): T => load<T>(compileSource(src), clientModules);

/** CSS text, normalized: `a:b;c:d`. */
const css = (s: string): string =>
  s
    .split(";")
    .map((d) => d.trim().replace(/\s*:\s*/, ":"))
    .filter(Boolean)
    .join(";");

/** The markup of `n`'s children: attributes sorted, styles normalized, comments only with `comments`. */
function dom(n: FakeNode, comments = false): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.namespaceURI === SVG ? c.tagName : c.tagName.toLowerCase();
      const attrs = new Map(c.attributes.map((a) => [a.name, a.value] as const));
      const style = (c as unknown as { style: { cssText: string } }).style.cssText || attrs.get("style");
      if (style) attrs.set("style", css(style));
      if (attrs.get("class") === "") attrs.delete("class");
      const list = [...attrs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => ` ${k}="${v}"`);
      out += `<${tag}${list.join("")}>${dom(c, comments)}</${tag}>`;
    } else if (c.nodeType === 8) {
      if (comments) out += `<!--${(c as unknown as { data: string }).data}-->`;
    } else out += (c as FakeText).data;
  }
  return out;
}

/** HTML parsed by the fake DOM, then written as `dom` writes it. */
function parsed(html: string, comments = false): string {
  const el = new FakeElement("DIV");
  el.innerHTML = html;
  return dom(el, comments);
}

/**
 * Render a source's `App` on the server and on the fake DOM: the two must write the same
 * markup. Returns the server's HTML.
 */
function same(src: string): string {
  const root = new FakeElement("DIV");
  body.appendChild(root);
  core.render(csr<{ App: () => unknown }>(src).App, root as unknown as Element);
  const html = server.renderToString(ssr<{ App: () => unknown }>(src).App);
  expect(parsed(html)).toBe(dom(root));
  // With the markers, the same page once they are taken out.
  expect(parsed(server.renderToString(ssr<{ App: () => unknown }>(src).App, { hydrate: true }))).toBe(dom(root));
  return html;
}

/** A Promise with its resolve and reject. */
function deferred<T>(): { p: Promise<T>; ok: (v: T) => void; no: (e: unknown) => void } {
  let ok!: (v: T) => void, no!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((ok = a), (no = b)));
  return { p, ok, no };
}

/** Let promise callbacks run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Read a stream to its end: its chunks, and the error it failed with. */
async function chunks(s: ReadableStream<Uint8Array>): Promise<{ parts: string[]; error: unknown }> {
  const parts: string[] = [],
    dec = new TextDecoder(),
    r = s.getReader();
  try {
    for (;;) {
      const x = await r.read();
      if (x.done) return { parts, error: undefined };
      parts.push(dec.decode(x.value));
    }
  } catch (error) {
    return { parts, error };
  }
}

// #endregion

// #region Server output against the client's

describe("server output is the client's DOM", () => {
  test("elements, text, attributes, classes and styles", () => {
    const html = same(`
      import { signal } from "@reactre/core";
      const [n] = signal(2);
      const [on] = signal(true);
      const cls = "c";
      const App = () => (
        <div id="main" class={n() > 1 ? "big" : "small"} data-n={n()} hidden={false} title={null}>
          <p>Hello {n()} & "you" {"<b>"}</p>
          <span class={{ a: true, b: on(), c: false }} />
          <span class={["x", "y"]} className="z" />
          <span class={[cls, { d: on() }]} />
          <span class={{ [cls]: true }} />
          <em style={{ color: "red", fontSize: n() + "px", margin: null, "--gap": 1 }} />
          <em style={"color: blue"} />
          <em style={n() > 5 ? "x" : undefined} />
          <button disabled={on()} aria-label={on() ? "on" : null} onClick={() => {}}>b</button>
          <label htmlFor="x" className={"l" + n()}>l</label>
          <svg viewBox="0 0 1 1"><circle class={"c" + n()} r={n()} /></svg>
          {null}{true}{n() > 1 && <i>and</i>}
        </div>
      );
      return { App };
    `);
    expect(html).toContain("<p>Hello 2 &amp; &quot;you&quot; &lt;b&gt;</p>");
    expect(html).toContain('class="a b"');
  });

  test("components, props, children, fragments and spread props", () => {
    same(`
      import { signal } from "@reactre/core";
      const [n] = signal(1);
      const Box = (props) => <section class={props.kind}>{props.title}: {props.children}</section>;
      const List = (props) => <>{props.children}<hr /></>;
      const Pair = () => <><b>{n()}</b>text</>;
      const p = { id: "s", class: "sp", style: { color: "red" }, onClick: () => {}, ref: () => {}, title: true, alt: false };
      const App = () => (
        <main>
          <Box kind="k" title={"t" + n()}>
            <i>child</i> and {n()}
          </Box>
          <List><u>u</u></List>
          <Pair />
          <img {...p} src={"/a" + n()} className="cn" htmlFor="f" />
          <div {...{ "data-x": n() }}>spread</div>
        </main>
      );
      return { App };
    `);
  });

  test("control flow: <For>, <Repeat>, <Show>, <Switch>, <Dynamic> and <Portal>", () => {
    const html = same(`
      import { Dynamic, For, Match, Portal, Repeat, Show, signal, Switch } from "@reactre/core";
      const [rows] = signal([{ id: 1, t: "a" }, { id: 2, t: "b" }]);
      const [none] = signal([]);
      const [n] = signal(2);
      const [user] = signal({ name: "ann" });
      const Greet = (props) => <b>hi {props.to}</b>;
      const App = () => (
        <main>
          <ul><For each={rows()} key={(r) => r.id}>{(r) => <li class={r.t}>{r.t}</li>}</For></ul>
          <ul><For each={none()} key={(r) => r} fallback={<li>empty</li>}>{(r) => <li>{r}</li>}</For></ul>
          <ul><For each={rows()} key={(r) => r.id} fallback={<li>empty</li>}>{(r) => <li>{r.id}</li>}</For><li>last</li></ul>
          <ol><Repeat count={n()} from={1}>{(i) => <li>{i}</li>}</Repeat></ol>
          <ol><Repeat count={0} fallback="no rows">{(i) => <li>{i}</li>}</Repeat></ol>
          <div>
            <Show when={n() > 1} fallback={<i>small</i>}>big</Show>
            <Show when={n() > 5} fallback={<i>small</i>}>big</Show>
            <Show when={user()}>{(u) => <b>{u().name}</b>}</Show>
            <Show when={user()} keyed>{(u) => <b>{u.name}</b>}</Show>
            <Show when={true}><i>always</i><b>{n()}</b></Show>
          </div>
          <div>
            <Switch fallback={<i>none</i>}>
              <Match when={n() === 1}>one</Match>
              <Match when={n() === 2}><b>two</b></Match>
            </Switch>
            <Switch fallback={<i>none</i>}>
              <Match when={n() === 9}>nine</Match>
            </Switch>
            <Switch>
              <Match when={user()} keyed>{(u) => <b>{u.name}</b>}</Match>
            </Switch>
          </div>
          <div>
            <Dynamic component="h2" class="t">title</Dynamic>
            <Dynamic component={n() > 1 ? "h3" : "h4"} id={"d" + n()}>sub</Dynamic>
            <Dynamic component={Greet} to="you" />
            <Dynamic component={n() > 5 ? Greet : null} to="no one" />
            <Dynamic component="input" value="v" />
          </div>
          <div><Portal><p>away</p></Portal>here</div>
        </main>
      );
      return { App };
    `);
    expect(html).toContain("<ul><li>empty</li></ul>");
    expect(html).not.toContain("away");
  });

  test("<For keyed={false}>, rows by position, and `keyed` written as the key", () => {
    const html = same(`
      import { For, signal } from "@reactre/core";
      const [items] = signal(["a", "b", "c"]);
      const App = () => (
        <div>
          <ul><For each={items()} keyed={false}>{(x, i) => <li class={x()}>{i}:{x()}</li>}</For></ul>
          <ul><For each={items()} keyed={false}>{(x) => <li>{x()}</li>}</For></ul>
          <ol><For each={[]} keyed={false} fallback={<li>none</li>}>{(x) => <li>{x()}</li>}</For></ol>
          <ol><For each={items()} keyed={(s) => s}>{(s) => <li>{s}</li>}</For></ol>
        </div>
      );
      return { App };
    `);
    expect(html).toContain('<li class="a">0:a</li>');
    expect(html).toContain("<ol><li>none</li></ol>");
  });

  test("a keyed element, and an expression that holds JSX", () => {
    same(`
      import { signal } from "@reactre/core";
      const [k] = signal(1);
      const [items] = signal(["a", "b"]);
      const App = () => (
        <div>
          <p key={k()}>keyed {k()}</p>
          <p key="still">plain</p>
          <ul>{items().map((i) => <li>{i}</li>)}</ul>
          {k() > 0 ? <b>yes</b> : "no"}
        </div>
      );
      return { App };
    `);
  });

  test("features/memo's lazy memo and unobserved signal render as the client renders them", async () => {
    let runs = 0;
    const counted = { count: () => runs++ };
    Object.assign(serverModules, { counted });
    Object.assign(clientModules, { counted });
    const src = `
      import { signal as base } from "@reactre/core";
      import { memo, signal } from "@reactre/core/features/memo";
      const { count } = rr.counted;
      const [n] = base(2);
      const doubled = memo(() => (count(), n() * 2), { lazy: true, equals: (a, b) => a === b });
      const [label] = signal("x", { unobserved: () => {} });
      const App = () => <p>{doubled()}{label()}</p>;
      return { App };
    `;
    // Both compiles call features/memo's reader-counting entries, which run on the server's core.
    expect(compileSource(src, "tsx", { server: true })).toContain("__observedMemo as __rrObsMemo");
    expect(same(src)).toBe("<p>4x</p>");
    // Lazy on the server too: nothing computed it before the render read it.
    runs = 0;
    const { App } = ssr<{ App: () => unknown }>(src);
    expect(runs).toBe(0);
    expect(server.renderToString(App)).toBe("<p>4x</p>");
    await tick();
  });
});

// #endregion

// #region What only the server writes

describe("what only the server writes", () => {
  test("properties are attributes, a textarea's value its text; handlers and refs are left out", () => {
    const { App } = ssr<{ App: () => unknown }>(`
      import { signal } from "@reactre/core";
      const [v] = signal("x<y");
      let el;
      const App = () => (
        <form onSubmit={() => {}} ref={el}>
          <input value={v()} checked={true} defaultValue="d" />
          <input type="checkbox" checked={v() === "no"} defaultChecked />
          <option selected={false} defaultSelected={true}>o</option>
          <video defaultMuted={false} />
          <textarea value={v()} />
          <textarea defaultValue="t">ignored</textarea>
        </form>
      );
      return { App };
    `);
    expect(server.renderToString(App)).toBe(
      '<form><input value="x&lt;y" checked value="d"><input type="checkbox" checked><option selected>o</option>' +
        "<video></video><textarea>x&lt;y</textarea><textarea>t</textarea></form>",
    );
  });

  test("hydration markers: around slots and lists, and between a text hole and the text beside it", () => {
    const { App } = ssr<{ App: () => unknown }>(`
      import { For, signal } from "@reactre/core";
      const [n] = signal(1);
      const C = () => <i>c</i>;
      const App = () => (
        <p>
          a {n()} b{n()}{n()}
          <C />
          <ul><For each={[1]} key={(x) => x}>{(x) => <li>{x}</li>}</For></ul>
          <b>{n()}</b>
        </p>
      );
      return { App };
    `);
    expect(server.renderToString(App, { hydrate: true })).toBe(
      "<p>a <!---->1<!----> b<!---->1<!---->1<!--[--><i>c</i><!--]--><ul><!--[--><li>1</li><!--]--></ul><b>1</b></p>",
    );
    expect(server.renderToString(App)).toBe("<p>a 1 b11<i>c</i><ul><li>1</li></ul><b>1</b></p>");
  });

  test("a list by index (keyed={false}) gives its rows an accessor of the item", () => {
    const { App } = ssr<{ App: () => unknown }>(`
      import { For } from "@reactre/core";
      const App = () => <ul><For each={["a", "b"]} keyed={false}>{(x, i) => <li>{i}:{x()}</li>}</For></ul>;
      return { App };
    `);
    expect(server.renderToString(App)).toBe("<ul><li>0:a</li><li>1:b</li></ul>");
  });

  test("a component, control flow and a fragment can stand alone", () => {
    const api = ssr<Record<string, () => unknown>>(`
      import { Dynamic, Portal, Show, signal } from "@reactre/core";
      const [n] = signal(1);
      const B = () => <b>{n()}</b>;
      const Comp = () => <B />;
      const Cond = () => <Show when={n()}>{n()}</Show>;
      const Away = () => <Portal mount={null}><p>x</p></Portal>;
      const Tag = () => <Dynamic component="em">e</Dynamic>;
      const Frag = () => <><i>a</i>{n()}</>;
      return { Comp, Cond, Away, Tag, Frag };
    `);
    expect(server.renderToString(api["Comp"]!)).toBe("<b>1</b>");
    expect(server.renderToString(api["Cond"]!)).toBe("1");
    expect(server.renderToString(api["Away"]!)).toBe("");
    expect(server.renderToString(api["Tag"]!)).toBe("<em>e</em>");
    expect(server.renderToString(api["Frag"]!)).toBe("<i>a</i>1");
    expect(server.renderToString(api["Frag"]!, { hydrate: true })).toBe("<i>a</i><!--[-->1<!--]-->");
  });

  test("effects do not run; memos compute when first read, and once", () => {
    const api = ssr<{ App: () => unknown; log: string[]; reads: () => number }>(`
      import { effect, memo as m, signal } from "@reactre/core";
      const log = [];
      let reads = 0;
      const [n] = signal(2);
      const double = m(() => (reads++, n() * 2));
      const unread = m(() => log.push("unread"));
      const App = () => {
        effect(() => log.push("effect"));
        return <p>{double()} {double()}</p>;
      };
      return { App, log, reads: () => reads };
    `);
    expect(api.reads()).toBe(0);
    expect(server.renderToString(api.App)).toBe("<p>4 4</p>");
    expect(api.reads()).toBe(1);
    expect(api.log).toEqual([]);
    expect(server.__ssrEffect(() => {}, {})).toBeUndefined();
  });

  test("a component's cleanups run when the render ends", () => {
    const api = ssr<{ App: () => unknown; log: string[] }>(`
      import { onCleanup } from "@reactre/core";
      const log = [];
      const App = () => {
        onCleanup(() => log.push("cleanup"));
        return <p>x</p>;
      };
      return { App, log };
    `);
    expect(server.renderToString(api.App)).toBe("<p>x</p>");
    expect(api.log).toEqual(["cleanup"]);
  });

  test("dynamic() from @reactre/core/features/dynamic, on the server", () => {
    const { dynamic } = serverDynamic;
    const [which, setWhich] = core.signal<unknown>("h1");
    const View = dynamic(() => which() as "h1");
    const app = () => View({ class: "v", children: "x" } as never);
    expect(server.renderToString(app)).toBe('<h1 class="v">x</h1>');
    expect(server.renderToString(app, { hydrate: true })).toBe('<!--[--><h1 class="v"><!--[-->x<!--]--></h1><!--]-->');
    setWhich(() => (p: { n: number }) => server.__ssr(["<b>", "</b>"], server.__ssrText(p.n, 0)));
    expect(server.renderToString(() => View({ n: 3 } as never))).toBe("<b>3</b>");
    setWhich(null);
    expect(server.renderToString(app)).toBe("");
  });
});

// #endregion

// #region Async data

describe("async data", () => {
  test("renderToString writes a <Loading>'s fallback while its children wait, and nothing for a read outside one", () => {
    const api = ssr<{ App: () => unknown }>(`
      import { Loading, memo } from "@reactre/core/features/async";
      const word = memo(() => new Promise(() => {}));
      const App = () => (
        <main>
          <Loading fallback={<i>wait</i>}><b>{word()}</b></Loading>
          <Loading fallback={<i>wait</i>}><b>ready</b></Loading>
          <p>{word()}</p>
        </main>
      );
      return { App };
    `);
    expect(server.renderToString(api.App)).toBe("<main><i>wait</i><b>ready</b><p></p></main>");
  });

  test("renderToStream: the shell with the fallbacks, then each boundary as it is ready, nested ones after", async () => {
    const a = deferred<string>(),
      b = deferred<string>(),
      c = deferred<string>();
    const ma = asyncApi.memo(() => a.p),
      mb = asyncApi.memo(() => b.p),
      mc = asyncApi.memo(() => c.p);
    const { Loading } = serverAsync;
    const app = () =>
      server.__ssr(
        ["<main>", "", "</main>"],
        Loading({
          fallback: "A…",
          get children() {
            return server.__ssr(
              ["<p>", "", "</p>"],
              server.__ssrLazy(() => server.__ssrText(ma(), 0)),
              Loading({
                fallback: "C…",
                get children() {
                  return server.__ssrLazy(() => server.__ssrText(mc(), 0));
                },
              }),
            );
          },
        }),
        Loading({
          fallback: server.__ssr(["<i>B…</i>"]),
          children: () => server.__ssrLazy(() => server.__ssrText(mb(), 0)),
        }),
      );
    const out = chunks(server.renderToStream(app, { nonce: 'n"1' }));
    await tick();
    b.ok("b");
    await tick();
    a.ok("a");
    await tick();
    c.ok("c");
    const { parts, error } = await out;
    expect(error).toBeUndefined();
    expect(parts[0]).toBe("<main><!--rr:b0-->A…<!--/rr:b0--><!--rr:b1--><i>B…</i><!--/rr:b1--></main>");
    expect(parts[1]).toStartWith('<script nonce="n&quot;1">self.$rr||');
    expect(parts[1]).toEndWith('<template id="rr:t1">b</template><script nonce="n&quot;1">$rr(1)</script>');
    expect(parts[2]).toBe(
      '<template id="rr:t0"><p>a<!--rr:b2-->C…<!--/rr:b2--></p></template><script nonce="n&quot;1">$rr(0)</script>',
    );
    expect(parts[3]).toBe('<template id="rr:t2">c</template><script nonce="n&quot;1">$rr(2)</script>');
    expect(parts.length).toBe(4);
  });

  test("renderToStream: a shell with nothing waiting is the whole page; one that reads a value outside every <Loading> waits for it", async () => {
    expect((await chunks(server.renderToStream(() => server.__ssr(["<p>x</p>"])))).parts).toEqual(["<p>x</p>"]);
    const d = deferred<string>();
    const m = asyncApi.memo(() => d.p);
    const out = chunks(
      server.renderToStream(() =>
        server.__ssr(
          ["<p>", "</p>"],
          server.__ssrLazy(() => server.__ssrText(m(), 0)),
        ),
      ),
    );
    await tick();
    d.ok("late");
    expect((await out).parts).toEqual(["<p>late</p>"]);
  });

  test("a cell that waits for one value and then another, and boundaries ready before the shell is sent", async () => {
    const top = deferred<string>(),
      first = deferred<string>(),
      second = deferred<string>();
    const mt = asyncApi.memo(() => top.p),
      m1 = asyncApi.memo(() => first.p),
      m2 = asyncApi.memo(() => second.p);
    const app = () =>
      server.__ssr(
        ["", "", ""],
        server.__ssrLazy(() => server.__ssrText(mt(), 0)),
        serverAsync.Loading({
          fallback: "…",
          children: () => server.__ssrLazy(() => server.__ssrText(m1() + m2(), 0)),
        }),
      );
    const out = chunks(server.renderToStream(app));
    const whole = server.renderToStringAsync(app);
    await tick();
    first.ok("1");
    await tick();
    second.ok("2");
    await tick();
    top.ok("t");
    expect((await out).parts).toEqual(["t12"]);
    expect(await whole).toBe("t12");
  });

  test("renderToStringAsync waits for every boundary, nested ones too", async () => {
    const a = deferred<string>(),
      b = deferred<string>();
    const ma = asyncApi.memo(() => a.p),
      mb = asyncApi.memo(() => b.p);
    const html = server.renderToStringAsync(() =>
      serverAsync.Loading({
        fallback: "…",
        children: () =>
          server.__ssr(
            ["<p>", "", "</p>"],
            server.__ssrLazy(() => server.__ssrText(ma(), 0)),
            serverAsync.Loading({ children: () => server.__ssrLazy(() => server.__ssrText(mb(), 0)) }),
          ),
      }),
    );
    await tick();
    a.ok("a");
    await tick();
    b.ok("b");
    expect(await html).toBe("<p>ab</p>");
  });

  test("a component that reads a value that is not ready waits in its <Loading>, and `lazy`'s does too", async () => {
    const d = deferred<string>();
    const m = asyncApi.memo(() => d.p);
    const Profile = () => server.__ssr(["<b>", "</b>"], server.__ssrText(m(), 0));
    const html = server.renderToStringAsync(() =>
      serverAsync.Loading({ fallback: "…", children: () => server.__ssrSlot(core.untrack(Profile)) }),
    );
    await tick();
    d.ok("ann");
    expect(await html).toBe("<b>ann</b>");
  });

  test("an error after the shell was sent: onError gets it and the stream errors; a later one is ignored", async () => {
    const d = deferred<string>(),
      e = deferred<string>();
    const m = asyncApi.memo(() => d.p),
      n = asyncApi.memo(() => e.p);
    const got: unknown[] = [];
    const bad = (v: string): string => {
      if (v === "bad") throw new Error("bad value");
      return v;
    };
    const out = chunks(
      server.renderToStream(
        () =>
          serverAsync.Loading({
            fallback: "…",
            children: () =>
              server.__ssr(
                ["", "", ""],
                server.__ssrLazy(() => server.__ssrText(bad(m()), 0)),
                server.__ssrLazy(() => server.__ssrText(bad(n()), 0)),
              ),
          }),
        { onError: (err) => got.push(err) },
      ),
    );
    await tick();
    d.ok("bad");
    await tick();
    e.ok("bad");
    const { parts, error } = await out;
    expect(parts).toEqual(["<!--rr:b0-->…<!--/rr:b0-->"]);
    expect((error as Error).message).toBe("bad value");
    expect(got.length).toBe(1);
  });

  test("an error after the shell that an onError of features/errors takes: the render still fails, as nothing shows it", async () => {
    const d = deferred<string>();
    const m = asyncApi.memo(() => d.p);
    const taken: unknown[] = [];
    configureClientErrors({ onError: (err) => taken.push(err) });
    const html = server.renderToStringAsync(() =>
      serverAsync.Loading({
        children: () =>
          server.__ssrLazy(() => {
            if (m() === "bad") throw new Error("taken");
            return "";
          }),
      }),
    );
    await tick();
    d.ok("bad");
    expect(html).rejects.toThrow("taken");
    await tick();
    expect(taken.length).toBe(1);
  });

  test("cancelling a stream stops the render", async () => {
    const d = deferred<string>();
    const m = asyncApi.memo(() => d.p);
    const log: string[] = [];
    const s = server.renderToStream(() => {
      core.onCleanup(() => log.push("cleanup"));
      return serverAsync.Loading({ fallback: "…", children: () => server.__ssrLazy(() => server.__ssrText(m(), 0)) });
    });
    const r = s.getReader();
    expect(new TextDecoder().decode((await r.read()).value)).toBe("<!--rr:b0-->…<!--/rr:b0-->");
    await r.cancel();
    expect(log).toEqual(["cleanup"]);
    d.ok("late");
    await tick();
  });

  test("async memos of the server's memo, and server markup that waits made outside a render", async () => {
    const d = deferred<string>();
    const word = server.__ssrMemo(() => d.p);
    const html = server.renderToStringAsync(() =>
      serverAsync.Loading({ children: () => server.__ssrLazy(() => server.__ssrText(word(), 0)) }),
    );
    await tick();
    d.ok("w");
    expect(await html).toBe("w");
    // Read after it settled, the memo is its value: core's `memo` is typed as synchronous.
    expect(word() as unknown).toBe("w");
    const n = asyncApi.memo(() => new Promise<string>(() => {}));
    expect(() => server.__ssrLazy(() => n())).toThrow("made outside a render");
    expect(() => server.__ssrLoading({})).toThrow("outside a render");
  });
});

// #endregion

// #region Errors and the runtime's edges

describe("errors", () => {
  test("what the app throws while it renders is thrown to the caller, and a stream errors with it", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    expect(() => server.renderToString(boom)).toThrow("boom");
    expect(() => server.renderToString(() => server.__frag([boom]))).toThrow("boom");
    expect(() => server.renderToString(() => server.__ssrLazy(boom))).toThrow("boom");
    expect(((await chunks(server.renderToStream(boom))).error as Error).message).toBe("boom");
    expect(server.renderToStringAsync(boom)).rejects.toThrow("boom");
  });
});

describe("the runtime's helpers", () => {
  test("escape, attributes, classes and styles", () => {
    expect(server.escape(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d'");
    expect(server.escape("plain")).toBe("plain");
    expect(server.__ssrAttr(null, "a") + server.__ssrAttr(false, "a")).toBe("");
    expect(server.__ssrAttr(true, "a") + server.__ssrAttr(0, "b") + server.__ssrAttr('"', "c")).toBe(
      ' a b="0" c="&quot;"',
    );
    expect(server.__ssrClass(null) + server.__ssrClass("")).toBe("");
    expect(server.__ssrClass(false)).toBe(' class="false"');
    expect(server.__ssrStyle(null) + server.__ssrStyle({}) + server.__ssrStyle({ a: null, b: false })).toBe("");
    expect(server.__ssrStyle({ fontSize: 2, "--x": "y" })).toBe(' style="font-size:2;--x:y"');
    expect(server.__ssrStyle("a:b")).toBe(' style="a:b"');
    expect(server.__ssrClasses("", [["a", 0]])).toBe("");
    expect(
      server.__ssrClasses("a b", [
        ["a", 0],
        ["c", 1],
        ["c", 1],
        ["d", ""],
      ]),
    ).toBe(' class="b c"');
    expect(
      server.__ssrAttrs({
        className: "x",
        class: "y",
        htmlFor: "f",
        style: { color: "red" },
        onClick: () => {},
        ref: {},
        key: 1,
        children: "c",
        hidden: true,
        title: null,
      }),
    ).toBe(' class="y" for="f" style="color:red" hidden');
    expect(server.__ssrAttrs(null)).toBe("");
    expect(server.__ssrText(null, 3)).toBe("");
    expect(server.__ssrText("<", 3)).toBe("&lt;");
  });

  test("slots take what __insert takes, and elements built at runtime", () => {
    const html = (v: unknown) => server.renderToString(() => v);
    expect(html(server.__ssrSlot([1, null, [true, "<", server.__ssr(["<b>x</b>"])], false, undefined]))).toBe(
      "1&lt;<b>x</b>",
    );
    expect(html(server.__ssrInsert(["a", 2]))).toBe("a2");
    expect(html(server.__ssrElement("br", { id: "b" }))).toBe('<br id="b">');
    expect(html(server.__ssrElement("p", { children: [server.__ssr(["<i></i>"]), "t"] }))).toBe("<p><i></i>t</p>");
    expect(html(server.__ssrElement("p", {}))).toBe("<p></p>");
    expect(
      html(
        server.__ssrFor(
          null,
          () => "x",
          () => "empty",
          false,
        ),
      ),
    ).toBe("empty");
    expect(html(server.__ssrFor(undefined, () => "x", undefined, false))).toBe("");
    expect(html(server.__ssrRepeat(2, undefined, (i) => i, undefined))).toBe("01");
    expect(server.renderToString(() => server.__frag(["a", () => "b", () => server.__ssr(["<i></i>"])]))).toBe(
      "ab<i></i>",
    );
    expect(() => server.__frag([() => "b"])).toThrow("made outside a render");
    expect(new server.Html(["x"]).p).toEqual(["x"]);
    expect(server.isServer).toBe(true);
  });

  test("the browser's @reactre/core/server: isServer is false, and the render functions throw", () => {
    expect(browser.isServer).toBe(false);
    expect(() => browser.renderToString(() => null)).toThrow("not in a browser bundle");
    expect(() => browser.renderToStream(() => null)).toThrow("not in a browser bundle");
    expect(() => browser.renderToStringAsync(() => null)).toThrow("not in a browser bundle");
  });
});

// #endregion

// #region Names, values, effects and <Errored>, as plans/solid-parity.md's bugs found them

/** Names a markup injection tries, none of them one tag or attribute name. */
const INJECTIONS = [
  "x><script>alert(1)</script",
  "x/><img src=x onerror=alert(1)",
  'a"b',
  "a'b",
  "a b",
  "a\tb",
  "a\nb",
  "a=b",
  "a/b",
  "a<b",
  "a\u0000b",
  "a\u007fb",
  "a\u0085b",
  "",
];

describe("the names the server writes", () => {
  test("a spread's key that is not one attribute name is left out, whatever its value", () => {
    for (const k of INJECTIONS)
      for (const v of ["v", true, 0, { a: 1 }, ["a"]])
        expect(server.__ssrAttrs({ [k]: v, "data-ok": "1" })).toBe(' data-ok="1"');
    // The names an element takes: data, aria, namespaced, custom, non-ASCII.
    expect(server.__ssrAttrs({ "data-x": 1, "aria-label": "l", "xlink:href": "#a", "x.y": "", é: "e" })).toBe(
      ' data-x="1" aria-label="l" xlink:href="#a" x.y="" é="e"',
    );
    // Compiled: the spread the port's test writes, through the server compile.
    const api = ssr<{ App: () => unknown }>(`
      const props = { ${INJECTIONS.map((k, i) => `${JSON.stringify(k)}: ${i % 2 === 0 ? `"v"` : "true"}`).join(", ")}, "data-ok": "1" };
      const App = () => <div {...props} title="t" />;
      return { App };
    `);
    expect(server.renderToString(api.App)).toBe('<div data-ok="1" title="t"></div>');
  });

  test("a spread's handlers and inline handler attributes are left out, in any case and whatever their value", () => {
    const h = (): void => {};
    expect(
      server.__ssrAttrs({
        onclick: "alert(1)",
        ONCLICK: "x",
        OnFocus: "y",
        onerror: "z",
        onError: "w",
        onClick: h,
        onload: h,
        onpointerdown: "p",
        ononline: "o",
        onCustom: h,
        title: "t",
      }),
    ).toBe(' title="t"');
    // Another key that starts with on is an attribute like any other.
    expect(server.__ssrAttrs({ one: "1", online: "2", on: "3", onx: "4" })).toBe(' one="1" online="2" on="3" onx="4"');
    // Compiled, onto an element and a custom element.
    const api = ssr<{ App: () => unknown }>(`
      const props = { onclick: "alert(1)", ONCLICK: "x", onError: "e", onClick: () => {}, one: "1", online: "2", "data-ok": "1" };
      const App = () => <div><div {...props} /><my-el {...props} /></div>;
      return { App };
    `);
    expect(server.renderToString(api.App)).toBe(
      '<div><div one="1" online="2" data-ok="1"></div><my-el one="1" online="2" data-ok="1"></my-el></div>',
    );
  });

  test("a tag that is not one element name throws, on every render: __ssrElement, <Dynamic> and dynamic()", () => {
    for (const tag of [...INJECTIONS, "1a", "-a", "é", "div x"]) {
      expect(() => server.__ssrElement(tag, {})).toThrow(`reactre: "${tag}" is not a valid tag name`);
      // dynamic() renders nothing for "", as for every falsy value.
      if (tag === "") continue;
      const View = serverDynamic.dynamic(() => tag as "div");
      for (let i = 0; i < 2; i++)
        expect(() => server.renderToString(() => View({} as never))).toThrow("is not a valid tag name");
    }
    for (const tag of [1, {}, Symbol("s")])
      expect(() => server.__ssrElement(tag as never, {})).toThrow("is not a valid tag name");
    const api = ssr<{ App: () => unknown; setTag: (t: string) => void }>(`
      import { Dynamic, signal } from "@reactre/core";
      const [tag, setTag] = signal("div x><script>alert(1)</script");
      const App = () => <Dynamic component={tag()} />;
      return { App, setTag };
    `);
    for (let i = 0; i < 2; i++) expect(() => server.renderToString(api.App)).toThrow("is not a valid tag name");
    api.setTag("my-widget");
    expect(server.renderToString(api.App)).toBe("<my-widget></my-widget>");
    expect(server.renderToString(() => server.__ssrElement("foreignObject", {}))).toBe(
      "<foreignObject></foreignObject>",
    );
    expect(server.renderToString(() => server.__ssrElement("Input", { a: "b" }))).toBe('<Input a="b"></Input>');
  });

  test("values and text are escaped in every path: attributes, spreads, styles, classes, children", () => {
    const bad = `"><script>alert(1)</script>&`;
    const esc = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;";
    expect(server.__ssrAttr(bad, "title")).toBe(` title="${esc}"`);
    expect(server.__ssrClass(bad)).toBe(` class="${esc}"`);
    expect(server.__ssrClasses(bad, [[`<${bad}`, 1]])).toBe(` class="${esc} &lt;${esc}"`);
    // A style object's keys and values, and a style string.
    expect(server.__ssrStyle({ [bad]: bad })).toBe(` style="${esc}:${esc}"`);
    expect(server.__ssrStyle(bad)).toBe(` style="${esc}"`);
    // A spread's values: a string, a class, a style object, a boolean's name alone.
    expect(server.__ssrAttrs({ title: bad, className: bad, style: { color: bad }, hidden: true })).toBe(
      ` title="${esc}" class="${esc}" style="color:${esc}" hidden`,
    );
    expect(server.__ssrText(bad, 0)).toBe(esc);
    expect(server.renderToString(() => server.__ssrElement("p", { title: bad, children: [bad, [bad]] }))).toBe(
      `<p title="${esc}">${esc}${esc}</p>`,
    );
    expect(server.renderToString(() => server.__ssrSlot([bad, 1, null]))).toBe(`${esc}1`);
    // Compiled, with every kind of hole, each value from an expression.
    const api = ssr<{ App: () => unknown }>(`
      const bad = ${JSON.stringify(bad)};
      const App = () => (
        <div title={bad} class={bad} style={{ color: bad }} hidden={true}>
          {bad}
          <p class={{ [bad]: true }} {...{ "data-x": bad }}>{[bad]}</p>
          <i class={["a", { [bad]: bad }]} />
          <textarea value={bad} />
        </div>
      );
      return { App };
    `);
    expect(server.renderToString(api.App)).toBe(
      `<div title="${esc}" class="${esc}" style="color:${esc}" hidden>${esc}` +
        `<p class="${esc}" data-x="${esc}">${esc}</p><i class="a ${esc}"></i><textarea>${esc}</textarea></div>`,
    );
  });
});

describe("effects on the server", () => {
  test("@reactre/core/server's effect does not run, however the app reaches it", () => {
    const log: string[] = [];
    expect(server.effect).toBe(server.__ssrEffect);
    server.renderToString(() => {
      server.effect(() => log.push("effect"));
      return "x";
    });
    expect(log).toEqual([]);
  });

  test("reaction computes, once, and never applies; onSettled and errors' effect never run", async () => {
    const log: string[] = [];
    const [n, setN] = core.signal(1);
    const App = () => {
      serverReaction.reaction(
        () => (log.push(`compute ${n()}`), n()),
        (v) => void log.push(`apply ${v}`),
      );
      serverTiming.onSettled(() => void log.push("settled"));
      serverErrors.effect(() => void log.push("effect"), { error: () => log.push("error") });
      return "x";
    };
    expect(server.renderToString(App)).toBe("x");
    expect(await server.renderToStringAsync(App)).toBe("x");
    const s = await chunks(server.renderToStream(App));
    expect(s.parts.join("")).toBe("x");
    await tick();
    setN(2);
    expect(log).toEqual(["compute 1", "compute 1", "compute 1"]);
    // The rest of each module is the client's.
    expect(serverTiming.flush).toBe(timing.flush);
    expect(serverErrors.Errored).toBe(Errored);
  });

  test("bind computes, given its last value, and never applies; autorun and onFlush never run", async () => {
    const log: string[] = [];
    const [n, setN] = core.signal(1);
    const App = () => {
      serverEffects.bind(
        (prev: number | undefined) => (log.push(`compute ${prev} ${n()}`), n()),
        (v) => void log.push(`apply ${v}`),
        { defer: true },
      );
      serverEffects.autorun(() => void log.push("autorun"));
      serverEffects.onFlush(() => void log.push("flush"));
      return "x";
    };
    expect(server.renderToString(App)).toBe("x");
    await tick();
    setN(2);
    expect(log).toEqual(["compute undefined 1"]);
  });
});

describe("<Errored> and async data", () => {
  test("a cell that disposes one that waits and shows other content: the boundary sends the new content", async () => {
    const d = deferred<string>();
    const m = asyncApi.memo(() => d.p);
    const [other, setOther] = core.signal(false);
    const app = () =>
      serverAsync.Loading({
        fallback: "…",
        children: () => server.__frag([() => (other() ? "other" : server.__frag([() => m()]))]),
      });
    const stream = chunks(server.renderToStream(app));
    const whole = server.renderToStringAsync(app);
    await tick();
    setOther(true);
    expect(templates((await stream).parts.join(""))).toEqual(["other"]);
    expect(await whole).toBe("other");
  });
});

/** The content of each boundary a stream sent, in order. */
const templates = (html: string): string[] =>
  [...html.matchAll(/<template id="rr:t\d+">([\s\S]*?)<\/template>/g)].map((x) => x[1]!);

describe("in a server build", () => {
  /** Where the bundles are written: a temporary folder the coverage run leaves out (bunfig.toml). */
  let out: string;
  let built = 0;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "reactre-plugin-core-ssr-"));
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  /** What a module built by `build` exports: its own, and @reactre/core/server's render functions. */
  interface Built {
    App: () => unknown;
    renderToString(app: () => unknown): string;
    renderToStream(app: () => unknown): ReadableStream<Uint8Array>;
    renderToStringAsync(app: () => unknown): Promise<string>;
    [k: string]: unknown;
  }

  /** The TSX module `src`, built as a server build of an app is (the compiler's Bun plugin), and loaded. */
  async function build(src: string): Promise<Built> {
    const entry = new URL("./ssr-entry.virtual.js", import.meta.url).pathname;
    const code =
      src + '\nexport { renderToString, renderToStream, renderToStringAsync } from "@reactre/core/server";\n';
    const r = await Bun.build({
      entrypoints: ["reactre-core:entry"],
      target: "bun",
      plugins: [
        {
          name: "entry",
          setup(b) {
            b.onResolve({ filter: /^reactre-core:entry$/ }, () => ({ path: entry }));
            b.onLoad({ filter: /ssr-entry\.virtual\.js$/ }, () => ({
              contents: compileSource(code, "tsx", { server: true }),
              loader: "js",
            }));
          },
        },
        reactreCompiler({ server: true, wholeProgram: false }),
      ],
    });
    if (!r.success) throw new AggregateError(r.logs, "the server build failed");
    const file = join(out, `m${built++}.js`);
    await Bun.write(file, await r.outputs[0]!.text());
    return (await import(file)) as Built;
  }

  test("no effect of the app or of a feature module runs, however it is imported; computations do", async () => {
    const m = await build(`
      import * as core from "@reactre/core";
      import { effect } from "@reactre/core";
      import * as errors from "@reactre/core/features/errors";
      import { effect as guarded } from "@reactre/core/features/errors";
      import { reaction } from "@reactre/core/features/reaction";
      import { onSettled } from "@reactre/core/features/timing";
      import { autorun, bind, onFlush } from "@reactre/core/features/effects";
      import { map } from "@reactre/core/features/lists";
      import { createStore, createProjection } from "@reactre/core/features/store";
      import { memo, resolve } from "@reactre/core/features/async";
      export const log = [];
      const [store] = createStore({ n: 2 });
      export function App() {
        bind(() => (log.push("bind"), 1), () => log.push("bind's apply"));
        autorun(() => log.push("autorun"));
        onFlush(() => log.push("onFlush"));
        const tens = map(() => [1, 2], (x) => x * 10);
        const data = memo(() => new Promise((ok) => setTimeout(() => ok("data"), 1)));
        const doubled = createProjection((d) => { d.n = store.n * 2; }, { n: 0 });
        effect(() => log.push("effect"));
        core.effect(() => log.push("namespace effect"));
        guarded(() => log.push("errors' effect"), { error: () => log.push("error") });
        errors.effect(() => log.push("errors' namespace effect"));
        reaction(() => (log.push("compute"), 1), () => log.push("apply"));
        onSettled(() => log.push("settled"));
        resolve(() => data()).then((v) => log.push("resolved " + v));
        return <p>{doubled.n} {data()} {tens().join(",")}</p>;
      }
    `);
    expect(await m.renderToStringAsync(m.App)).toBe("<p>4 data 10,20</p>");
    await tick();
    expect(m["log"]).toEqual(["bind", "compute", "resolved data"]);
  });

  /** An app whose data rejects, under `<Errored>` in `<Loading>`, when `reject` is called. */
  const REJECTS = `
    import { Loading, memo } from "@reactre/core/features/async";
    import { Errored } from "@reactre/core/features/errors";
    let no;
    const p = new Promise((_, r) => (no = r));
    export const reject = () => no(new Error("<boom>"));
    const Data = () => {
      const data = memo(() => p);
      return <p>{data()}</p>;
    };
    export const App = () => (
      <div>
        <Loading fallback="…">
          <Errored fallback={(e) => <span>caught {e.message}</span>}><Data /></Errored>
        </Loading>
      </div>
    );
  `;

  test("an async rejection under <Errored> shows its fallback: renderToStream and renderToStringAsync", async () => {
    const a = await build(REJECTS);
    const s = chunks(a.renderToStream(a.App));
    await tick();
    (a["reject"] as () => void)();
    const { parts, error } = await s;
    expect(error).toBeUndefined();
    expect(parts[0]).toBe("<div><!--rr:b0-->…<!--/rr:b0--></div>");
    expect(templates(parts.join(""))).toEqual(["<span>caught &lt;boom&gt;</span>"]);
    const b = await build(REJECTS);
    const html = b.renderToStringAsync(b.App);
    await tick();
    (b["reject"] as () => void)();
    expect(await html).toBe("<div><span>caught &lt;boom&gt;</span></div>");
  });

  test("renderToString: a rejection it cannot wait for shows <Loading>'s fallback, one already known <Errored>'s", async () => {
    const a = await build(REJECTS);
    expect(a.renderToString(a.App)).toBe("<div>…</div>");
    const b = await build(`
      import { Loading, memo } from "@reactre/core/features/async";
      import { Errored } from "@reactre/core/features/errors";
      const data = memo(() => Promise.reject(new Error("known")));
      export const settle = () => { try { data(); } catch {} return new Promise((r) => setTimeout(r, 0)); };
      export const App = () => (
        <Loading fallback="…">
          <Errored fallback={(e) => <span>caught {e.message}</span>}><p>{data()}</p></Errored>
        </Loading>
      );
    `);
    await (b["settle"] as () => Promise<void>)();
    expect(b.renderToString(b.App)).toBe("<span>caught known</span>");
  });

  test("an <Errored> fallback that itself waits: the boundary sends it once it is ready", async () => {
    const m = await build(`
      import { Loading, memo } from "@reactre/core/features/async";
      import { Errored } from "@reactre/core/features/errors";
      const data = memo(async () => { await new Promise((r) => setTimeout(r, 1)); throw new Error("fail"); });
      const Help = () => {
        const text = memo(() => new Promise((ok) => setTimeout(() => ok("help"), 5)));
        return <b>{text()}</b>;
      };
      export const App = () => (
        <Loading fallback="…">
          <Errored fallback={<Help />}><p>{data()}</p></Errored>
        </Loading>
      );
    `);
    const { parts, error } = await chunks(m.renderToStream(m.App));
    expect(error).toBeUndefined();
    expect(templates(parts.join(""))).toEqual(["<b>help</b>"]);
    expect(await m.renderToStringAsync(m.App)).toBe("<b>help</b>");
  });

  test("without <Errored>, an async rejection fails the render", async () => {
    const m = await build(`
      import { Loading, memo } from "@reactre/core/features/async";
      const data = memo(async () => { await new Promise((r) => setTimeout(r, 1)); throw new Error("fail"); });
      export const App = () => <Loading fallback="…"><p>{data()}</p></Loading>;
    `);
    expect(m.renderToStringAsync(m.App)).rejects.toThrow("fail");
    expect(((await chunks(m.renderToStream(m.App))).error as Error).message).toBe("fail");
  });
});

// #endregion
