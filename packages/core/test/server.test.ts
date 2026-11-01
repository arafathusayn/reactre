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

import { compileSource } from "@reactre/compiler";
import { FakeElement, type FakeNode, FakeText, installFakeDocument, withStyles } from "@reactre/testdom";

import * as asyncApi from "../src/features/async.ts";
import { __hooks } from "../src/features/async.ts";
import { configureClientErrors } from "../src/features/errors.ts";
import * as indexApi from "../src/features/index.ts";
import * as memoApi from "../src/features/memo.ts";
import * as core from "../src/index.ts";
import * as browser from "../src/server.browser.ts";
import * as server from "../src/server.ts";
import * as serverAsync from "../src/server/async.ts";
import * as serverDynamic from "../src/server/dynamic.ts";

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
