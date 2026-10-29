// @reactre/compat/server against React's own server renderer (react-dom@19.3.1, production builds).
//
// Each test builds one tree twice, once from React and once from compat (so hooks, contexts and
// lazy components come from the library that renders them), renders it with both servers and
// expects the same HTML: renderToString, renderToStaticMarkup and renderToReadableStream (read
// once all of it is ready), plus renderToPipeableStream where the test says so. Errors are
// compared by message, and each of compat's entries throws the message React's build for it
// throws (raw: minified codes from the browser builds, full text from the others). What React's
// stable build cannot render (browser() tokens) is checked against the HTML React writes for the
// same boundary when it errors.

import { describe, expect, spyOn, test } from "bun:test";

import * as Compat from "../src/core.ts";
import * as Browser from "../src/server.browser.ts";
import BrowserDefault from "../src/server.browser.ts";
import * as Edge from "../src/server.edge.ts";
import EdgeDefault from "../src/server.edge.ts";
import * as Server from "../src/server.ts";
import ServerDefault from "../src/server.ts";

// biome-ignore lint: both libraries are used through one untyped interface.
type Any = any;

// React's production builds: NODE_ENV is read when the modules load. (React has no types here.)
const load = (specifier: string): Promise<Any> => import(specifier);
const prevEnv = process.env["NODE_ENV"];
process.env["NODE_ENV"] = "production";
const React: Any = await load("react");
const ReactDOM: Any = await load("react-dom");
const ReactServer: Any = await load("react-dom/server.browser");
const ReactNodeServer: Any = await load("react-dom/server.node");
// What react-dom/server resolves to under Bun.
const ReactBunServer: Any = await load("react-dom/server.bun");
const ReactEdgeServer: Any = await load("react-dom/server.edge");
if (prevEnv === undefined) delete process.env["NODE_ENV"];
else process.env["NODE_ENV"] = prevEnv;

type Lib = Any;
type Make = (L: Lib) => Any;

/** The library with react-dom's functions (preload and the rest) for `L`. */
const dom = (L: Lib): Any => (L === React ? ReactDOM : L);
type Options = Record<string, Any>;

const quiet = { onError: () => {} };

/** A ReadableStream's bytes as text. */
const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

/** The whole HTML of renderToReadableStream, once all of it is ready. */
async function streamAll(server: Any, el: Any, options?: Options): Promise<string> {
  const stream = await server.renderToReadableStream(el, options);
  await stream.allReady;
  return text(stream);
}

/** The HTML renderToPipeableStream writes, piped when the shell (or all) is ready. */
function pipeAll(server: Any, el: Any, options?: Options, onAll = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const writable = {
      write: (c: Uint8Array) => (chunks.push(c), true),
      end: () => resolve(Buffer.concat(chunks).toString()),
      on: () => writable,
      destroy: (e: unknown) => reject(e),
    };
    const pipe = (): void => void s.pipe(writable);
    const s = server.renderToPipeableStream(el, {
      ...options,
      ...(onAll ? { onAllReady: pipe } : { onShellReady: pipe }),
      onShellError: reject,
    });
  });
}

/** Render with both servers through every entry; expects one HTML. Returns React's renderToString. */
async function same(make: Make, options?: Options, pipe = false): Promise<string> {
  const expected = ReactServer.renderToString(make(React), options);
  expect(Server.renderToString(make(Compat), options)).toBe(expected);
  expect(Server.renderToStaticMarkup(make(Compat), options)).toBe(
    ReactServer.renderToStaticMarkup(make(React), options),
  );
  expect(await streamAll(Server, make(Compat), options)).toBe(await streamAll(ReactServer, make(React), options));
  if (pipe)
    expect(await pipeAll(Server, make(Compat), options)).toBe(await pipeAll(ReactNodeServer, make(React), options));
  return expected;
}

/** The streams only (renderToString cannot wait for Suspense). */
async function sameStream(make: Make, options?: Options): Promise<string> {
  const expected = await streamAll(ReactServer, make(React), options);
  expect(await streamAll(Server, make(Compat), options)).toBe(expected);
  return expected;
}

// React's production builds throw minified errors; compat throws the full messages. These are
// React's messages for the codes the tests meet (react.dev/errors), to compare the two.
const messages: Record<string, string> = {
  "31": "Objects are not valid as a React child (found: %s). If you meant to render a collection of children, use an array instead.",
  "60": "Can only set one of `children` or `props.dangerouslySetInnerHTML`.",
  "61": "`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.",
  "62": "The `style` prop expects a mapping from style properties to values, not a string. For example, style={{marginRight: spacing + 'em'}} when using JSX.",
  "65": "Invalid tag: %s",
  "91": "`dangerouslySetInnerHTML` does not make sense on <textarea>.",
  "92": "If you supply `defaultValue` on a <textarea>, do not pass children.",
  "93": "<textarea> can only have at most one child.",
  "130":
    "Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: %s.%s",
  "257":
    "Portals are not currently supported by the server renderer. Render them conditionally so that they only appear on the client render.",
  "301": "Too many re-renders. React limits the number of renders to prevent an infinite loop.",
  "343": "ReactDOMServer does not yet support scope components.",
  "399": "%s is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
  "400": "menuitems cannot have `children` nor `dangerouslySetInnerHTML`.",
  "407": "Missing getServerSnapshot, which is required for server-rendered content. Will revert to client rendering.",
  "426":
    "A component suspended while responding to synchronous input. This will cause the UI to be replaced with a loading indicator. To fix, updates that suspend should be wrapped with startTransition.",
  "432": "The render was aborted by the server without a reason.",
  "433": "React currently only supports piping to one writable stream.",
  "530": "The render was aborted by the server with a promise.",
  "545": "The %s tag may only be rendered once.",
};

/** A minified React error's full message (unknown codes stay as they are). */
function full(message: string): string {
  const m = /^Minified React error #(\d+); visit https:\/\/react\.dev\/errors\/\d+(\?\S*)? for/.exec(message);
  const template = m ? messages[m[1]!] : undefined;
  if (template === undefined) return message;
  const args = new URLSearchParams(m![2] ?? "").getAll("args[]");
  let i = 0;
  return template.replace(/%s/g, () => args[i++] ?? "");
}

/** What a call throws, as its (full) message. */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return full(e instanceof Error ? e.message : String(e));
  }
  return "(nothing thrown)";
}

/** What a call throws, as its message, untranslated. */
function raw(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "(nothing thrown)";
}

/** The message renderToReadableStream rejects with, untranslated. */
async function rejected(server: Any, el: Any): Promise<string> {
  try {
    await server.renderToReadableStream(el, quiet);
  } catch (e) {
    return (e as Error).message;
  }
  return "(resolved)";
}

/**
 * Compat's server entries, each with React's build it stands for: @reactre/compat/server is
 * react-dom/server.node, /server.browser is react-dom/server.browser, and /server.edge is
 * react-dom/server.edge and react-dom/server.bun (whose renderToString is React's browser build's).
 */
const builds: [name: string, compat: Any, react: Any][] = [
  ["node", Server, ReactNodeServer],
  ["browser", Browser, ReactServer],
  ["edge", Edge, ReactEdgeServer],
  ["bun", Edge, ReactBunServer],
];

/**
 * Both libraries throw the same message from renderToString, renderToStaticMarkup and the stream,
 * through each entry: the very message React's build for the entry throws. Returns the full one.
 */
async function sameError(make: Make): Promise<string> {
  for (const [name, compat, react] of builds) {
    const expected = [
      raw(() => react.renderToString(make(React))),
      raw(() => react.renderToStaticMarkup(make(React))),
      await rejected(react, make(React)),
    ];
    const actual = [
      raw(() => compat.renderToString(make(Compat))),
      raw(() => compat.renderToStaticMarkup(make(Compat))),
      await rejected(compat, make(Compat)),
    ];
    expect({ name, actual }).toEqual({ name, actual: expected });
  }
  return raw(() => ReactNodeServer.renderToString(make(React)));
}

/** A promise that resolves to `value` after `ms`, as a thenable both servers wait on. */
const later = <T>(value: T, ms = 5): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

describe("React's production build", () => {
  test("is the reference", () => {
    // Development elements carry _store; production ones do not.
    expect("_store" in React.createElement("div")).toBe(false);
    expect(ReactServer.version).toBe("19.3.1");
  });
});

describe("errors", () => {
  // React's builds differ: its browser builds (react-dom/server.browser, react-dom/static.browser)
  // throw minified codes, its Node build full messages, and its edge and Bun builds full messages
  // from the streams but codes from renderToString, which they take from the browser build. Each of
  // compat's entries throws as React's build for it does, its errors from compat's hooks included.
  const minified = (code: number, ...args: string[]): string =>
    "Minified React error #" +
    code +
    "; visit https://react.dev/errors/" +
    code +
    args.map((a, i) => (i === 0 ? "?" : "&") + "args[]=" + encodeURIComponent(a)).join("") +
    " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

  test("are those of React's build for each entry, hooks' errors included", async () => {
    const cases: Make[] = [
      (L) => {
        function Use() {
          L.use(5);
          return null;
        }
        return L.createElement(Use);
      },
      (L) => {
        function Early() {
          L.useEffectEvent(() => 1)();
          return null;
        }
        return L.createElement(Early);
      },
      (L) => {
        function Loop() {
          const [n, set] = L.useState(0);
          set(n + 1);
          return null;
        }
        return L.createElement(Loop);
      },
      // A pass after a render-phase update calls a hook the first did not (#312).
      (L) => {
        function More() {
          const [n, set] = L.useState(0);
          if (n === 0) set(1);
          else L.useState(2);
          return null;
        }
        return L.createElement(More);
      },
      (L) => L.createElement("div", { style: "color: red" }),
      (L) => L.createElement("div", null, { x: 1 }),
      (L) => L.createElement("div", null, L.createElement(undefined)),
    ];
    for (const make of cases) {
      const node = raw(() => ReactNodeServer.renderToString(make(React)));
      expect(node).not.toStartWith("Minified");
      expect(node).not.toBe("(nothing thrown)");
      expect(raw(() => ReactServer.renderToString(make(React)))).toStartWith("Minified React error #");
      await sameError(make);
    }
  });

  test("a render that suspends outside a boundary in renderToString", () => {
    const make: Make = (L) => {
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement("div", null, L.createElement(Never));
    };
    for (const [name, compat, react] of builds) {
      const expected = [
        raw(() => react.renderToString(make(React))),
        raw(() => react.renderToStaticMarkup(make(React))),
      ];
      const actual = [
        raw(() => compat.renderToString(make(Compat))),
        raw(() => compat.renderToStaticMarkup(make(Compat))),
      ];
      expect({ name, actual }).toEqual({ name, actual: expected });
    }
    expect(raw(() => Browser.renderToString(make(Compat)))).toBe(minified(426));
  });

  test("aborts without a reason, and with a promise", async () => {
    const make: Make = (L) => {
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Never)));
    };
    /** The errors a stream reports when it is cancelled with no reason, or its signal aborts with `reason`. */
    const read = async (server: Any, L: Lib, reason?: unknown): Promise<string[]> => {
      const controller = new AbortController();
      const errors: string[] = [];
      const stream = await server.renderToReadableStream(make(L), {
        signal: controller.signal,
        onError: (e: Any) => void errors.push(e.message),
      });
      if (reason === undefined) {
        const reader = stream.getReader();
        await reader.read();
        await reader.cancel();
        await later(null, 2);
      } else {
        setTimeout(() => controller.abort(reason), 2);
        await text(stream);
      }
      return errors;
    };
    for (const [name, compat, react] of builds) {
      for (const reason of [undefined, Promise.resolve()]) {
        const expected = await read(react, React, reason);
        expect(expected.length).toBe(1);
        expect({ name, actual: await read(compat, Compat, reason) }).toEqual({ name, actual: expected });
      }
    }
    expect(await read(Browser, Compat)).toEqual([minified(432)]);
    // renderToPipeableStream's abort(), as React's Node build; compat's browser entry minifies it.
    const pipeAbort = (server: Any, L: Lib): Promise<string> =>
      new Promise((resolve) => {
        const s = server.renderToPipeableStream(make(L), { onError: (e: Any) => resolve(e.message) });
        s.abort();
      });
    expect(await pipeAbort(Server, Compat)).toBe(await pipeAbort(ReactNodeServer, React));
    expect(await pipeAbort(Browser, Compat)).toBe(minified(432));
  });

  test("piping twice, as React's Node build; compat's browser entry minifies it", async () => {
    const pipeTwice = (server: Any, L: Lib): Promise<string> =>
      new Promise((resolve) => {
        const writable = { write: () => true, end: () => {}, on: () => writable };
        const s = server.renderToPipeableStream(L.createElement("p", null, "x"), {
          onShellReady() {
            s.pipe(writable);
            resolve(raw(() => s.pipe(writable)));
          },
        });
      });
    expect(await pipeTwice(Server, Compat)).toBe(await pipeTwice(ReactNodeServer, React));
    expect(await pipeTwice(Browser, Compat)).toBe(minified(433));
  });

  test("browser(): the bailout and the fatal error, minified by the browser entry", async () => {
    const reasons = (server: Any): Promise<string[]> => {
      const out: string[] = [];
      const Client = (): Any => Compat.use((Compat as Any).browser("why"));
      const el = Compat.createElement(Compat.Suspense, { fallback: "fb" }, Compat.createElement(Client));
      return streamAll(server, el, { onBrowserBailout: (e: Error) => void out.push(e.message) }).then(() => out);
    };
    expect(await reasons(Browser)).toEqual([minified(603)]);
    expect(await reasons(Edge)).toEqual(["Browser-only rendering was requested by `browser()`."]);
    const fatal = (server: Any): string =>
      raw(() => server.renderToStaticMarkup(Compat.createElement(() => Compat.use((Compat as Any).browser()))));
    expect(fatal(Browser)).toBe(minified(604));
    expect(fatal(Edge)).toBe(minified(604));
    expect(fatal(Server)).toStartWith("The server render could not complete");
    // An abort with a token: its bailout too.
    const aborted = async (server: Any): Promise<string[]> => {
      const out: string[] = [];
      const controller = new AbortController();
      const Never = (): Any => Compat.use(new Promise(() => {}));
      const stream = await server.renderToReadableStream(
        Compat.createElement(Compat.Suspense, { fallback: "f" }, Compat.createElement(Never)),
        { signal: controller.signal, onBrowserBailout: (e: Error) => void out.push(e.message) },
      );
      controller.abort((Compat as Any).browser("aborted"));
      await text(stream);
      return out;
    };
    expect(await aborted(Browser)).toEqual([minified(603)]);
    expect(await aborted(Server)).toEqual(["Browser-only rendering was requested by `browser()`."]);
  });

  test("a render inside a component takes its own entry's errors", () => {
    // The outer render is the browser entry's; the inner one, started while it renders, the Node one's.
    let inner = "";
    const Outer = (): Any => {
      inner = raw(() => Server.renderToString(Compat.createElement("div", { style: "x" })));
      return Compat.createElement("div", { style: "x" });
    };
    expect(raw(() => Browser.renderToString(Compat.createElement(Outer)))).toBe(minified(62));
    expect(inner).toStartWith("The `style` prop expects");
    // And the other way round.
    const Inner = (): Any => {
      inner = raw(() => Browser.renderToString(Compat.createElement("div", { style: "x" })));
      return Compat.createElement("div", { style: "x" });
    };
    expect(raw(() => Server.renderToString(Compat.createElement(Inner)))).toStartWith("The `style` prop expects");
    expect(inner).toBe(minified(62));
  });
});

describe("entry", () => {
  test("exports React's server API, and a default object with it", () => {
    for (const k of ["renderToString", "renderToStaticMarkup", "renderToReadableStream", "resume"])
      expect(typeof ReactServer[k]).toBe("function");
    for (const k of [
      "renderToString",
      "renderToStaticMarkup",
      "renderToReadableStream",
      "renderToPipeableStream",
      "resume",
      "resumeToPipeableStream",
      "prerender",
      "prerenderToNodeStream",
      "resumeAndPrerender",
      "resumeAndPrerenderToNodeStream",
    ]) {
      expect(typeof (Server as Any)[k]).toBe("function");
      expect((ServerDefault as Any)[k]).toBe((Server as Any)[k]);
      // The browser and edge entries export the same API, so any import resolves through them.
      for (const [entry, fallback] of [
        [Browser, BrowserDefault],
        [Edge, EdgeDefault],
      ]) {
        expect(typeof (entry as Any)[k]).toBe("function");
        expect((fallback as Any)[k]).toBe((entry as Any)[k]);
      }
    }
    expect(Server.version).toBe(Compat.version);
    expect(Browser.version).toBe(Compat.version);
    expect(Edge.version).toBe(Compat.version);
    expect((BrowserDefault as Any).version).toBe(Compat.version);
    expect((EdgeDefault as Any).version).toBe(Compat.version);
    // The edge entry differs from the Node one only in renderToString and renderToStaticMarkup.
    expect(Edge.renderToReadableStream).toBe(Server.renderToReadableStream);
    expect(Edge.renderToString).not.toBe(Server.renderToString);
  });
});

describe("text and elements", () => {
  test("text, numbers and bigints, with separators between adjacent texts", async () => {
    expect(
      await same((L) => L.createElement("div", null, "a", "b", 1, 2n, "", null, false, true, undefined, "c")),
    ).toBe("<div>a<!-- -->b<!-- -->1<!-- -->2<!-- -->c</div>");
    await same(() => "top");
    await same(() => 42);
    await same(() => null);
    await same(() => ["a", "b"]);
    await same((L) => L.createElement(L.Fragment, null, "a", L.createElement("b", null, "x"), "c"));
  });

  test("escaping of text and attribute values", async () => {
    await same((L) =>
      L.createElement("div", { title: `"a" & 'b' <c> d`, "data-x": "<>" }, `<script>&"'`, "plain", "x>y"),
    );
  });

  test("attributes: aliases, booleans, numbers, URLs, events and unknown props", async () => {
    await same((L) =>
      L.createElement(
        "div",
        {
          className: "c",
          htmlFor: "f",
          tabIndex: 0,
          role: "r",
          dir: "ltr",
          hidden: true,
          inert: false,
          draggable: false,
          spellCheck: true,
          contentEditable: "true",
          "aria-hidden": true,
          "data-on": false,
          onClick: () => {},
          onclick: "x",
          myProp: "kept",
          fn: () => {},
          sym: Symbol("s"),
          bool: true,
          "bad name": "x",
          suppressHydrationWarning: true,
          suppressContentEditableWarning: true,
          defaultValue: "dv",
          defaultChecked: true,
          innerHTML: "no",
          autoFocus: true,
          autoPlay: true,
          multiple: true,
          muted: true,
          capture: true,
          download: "file",
          rows: 2,
          cols: 0,
          span: "x",
          size: 3,
          start: 4,
          rowSpan: "n",
          acceptCharset: "utf-8",
          httpEquiv: "x",
          crossOrigin: "anonymous",
          itemScope: true,
          ref: () => {},
          key: "k",
        },
        "x",
      ),
    );
    await same((L) => L.createElement("a", { href: "" }, "empty href kept on a"));
    await same((L) => L.createElement("img", { src: "", alt: "" }));
    await same((L) => L.createElement("a", { href: "javascript:alert(1)" }, "blocked"));
    await same((L) => L.createElement("form", { action: " javascript:void 0" }, "f"));
    await same((L) => L.createElement("button", { formAction: "/x", formMethod: "post" }, "b"));
    await same((L) => L.createElement("object", { data: "/d", width: 1 }, L.createElement("param", { name: "p" })));
    await same((L) => L.createElement("object", { data: "" }));
    await same((L) => L.createElement("a", { download: false, capture: "user" }, "x"));
    await same((L) => L.createElement("a", { download: () => {}, capture: Symbol() }, "x"));
    await same((L) => L.createElement("td", { rowSpan: 2, start: () => {}, cols: () => {} }, "x"));
    await same((L) =>
      L.createElement("a", { href: () => {}, src: true, action: null, title: true, dir: Symbol() }, "x"),
    );
    await same((L) =>
      L.createElement("p", { value: () => {}, draggable: true, hidden: "h", contentEditable: Symbol() }),
    );
  });

  test("svg and xlink names", async () => {
    await same((L) =>
      L.createElement(
        "svg",
        { viewBox: "0 0 1 1", xmlnsXlink: "http://www.w3.org/1999/xlink" },
        L.createElement("use", {
          xlinkHref: "#a",
          xlinkActuate: "a",
          xlinkArcrole: "b",
          xlinkRole: "c",
          xlinkShow: "d",
          xlinkTitle: "e",
          xlinkType: "f",
          xmlBase: "g",
          xmlLang: "h",
          xmlSpace: "i",
          strokeWidth: 2,
          fillOpacity: 0.5,
          clipPath: "url(#c)",
          focusable: false,
          externalResourcesRequired: true,
        }),
        L.createElement("path", { d: "M0", fillRule: "evenodd" }),
        L.createElement("foreignObject", null, L.createElement("div", null, "html")),
        L.createElement("title", null, "svg title stays"),
      ),
    );
    await same((L) => L.createElement("use", { xlinkHref: true }));
    await same((L) => L.createElement("math", null, L.createElement("mi", null, "x")));
  });

  test("styles: names, units, custom properties and empty values", async () => {
    await same((L) =>
      L.createElement("div", {
        style: {
          color: "red",
          marginTop: 10,
          lineHeight: 1.5,
          opacity: 0,
          zIndex: 2,
          flex: 1,
          width: 0,
          msTransform: "x",
          WebkitTransition: "y",
          "--custom-prop": " 3px ",
          background: null,
          border: "",
          display: true,
          fontSize: " 12px ",
          content: '"<a>"',
        },
      }),
    );
    await same((L) => L.createElement("div", { style: {} }));
    await same((L) => L.createElement("div", { style: { a: null } }));
  });

  test("void elements, inner HTML and their errors", async () => {
    await same((L) =>
      L.createElement(
        "div",
        null,
        L.createElement("br"),
        L.createElement("hr", { className: "x" }),
        L.createElement("input", { type: "text" }),
        L.createElement("img", { src: "/a.png", alt: "a" }),
        L.createElement("wbr"),
        L.createElement("area"),
        L.createElement("base", { href: "/" }),
        L.createElement("col"),
        L.createElement("embed"),
        L.createElement("keygen"),
        L.createElement("source", { src: "/s" }),
        L.createElement("track"),
        L.createElement("menuitem", { label: "m" }),
        L.createElement("span", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }),
        L.createElement("span", { dangerouslySetInnerHTML: { __html: null } }),
      ),
    );
    await sameError((L) => L.createElement("br", null, "x"));
    await sameError((L) => L.createElement("img", { dangerouslySetInnerHTML: { __html: "" } }));
    await sameError((L) => L.createElement("input", { children: "x" }));
    await sameError((L) => L.createElement("link", { rel: "icon", href: "/i", children: "x" }));
    await sameError((L) => L.createElement("menuitem", null, "x"));
    await sameError((L) => L.createElement("div", { dangerouslySetInnerHTML: { __html: "" } }, "x"));
    await sameError((L) => L.createElement("div", { dangerouslySetInnerHTML: "<b>" }));
    await sameError((L) => L.createElement("div", { style: "color: red" }));
    await sameError((L) => L.createElement("bad tag"));
    await sameError((L) => L.createElement("meta", { name: "a", content: "b", children: "x" }));
  });

  test("pre and listing keep a leading newline", async () => {
    await same((L) => L.createElement("pre", null, "\nline"));
    await same((L) => L.createElement("pre", null, "line"));
    await same((L) => L.createElement("listing", { dangerouslySetInnerHTML: { __html: "\nraw" } }));
    await same((L) => L.createElement("pre", { dangerouslySetInnerHTML: { __html: "raw" } }));
    await same((L) => L.createElement("pre", { dangerouslySetInnerHTML: { __html: undefined } }));
    await same((L) => L.createElement("pre", null, L.createElement("b", null, "x")));
    await sameError((L) => L.createElement("pre", { dangerouslySetInnerHTML: { __html: "x" } }, "y"));
    await sameError((L) => L.createElement("pre", { dangerouslySetInnerHTML: {} }));
  });

  test("custom elements", async () => {
    await same((L) =>
      L.createElement("my-el", {
        className: "c",
        style: { color: "red" },
        on: true,
        off: false,
        obj: { a: 1 },
        num: 3,
        fn: () => {},
        ref: () => {},
        suppressHydrationWarning: true,
        "bad name": 1,
        dangerouslySetInnerHTML: { __html: "<i>x</i>" },
      }),
    );
    await same((L) => L.createElement("my-el", null, "text", L.createElement("b", null, "x")));
  });

  test("form controls: select, option, textarea, input", async () => {
    await same((L) =>
      L.createElement(
        "select",
        { value: "b", onChange: () => {} },
        L.createElement("option", { value: "a" }, "A"),
        L.createElement("option", { value: "b" }, "B"),
        L.createElement("option", null, "c"),
        L.createElement("optgroup", { label: "g" }, L.createElement("option", { value: "c" }, "C")),
      ),
    );
    await same((L) =>
      L.createElement(
        "select",
        { multiple: true, defaultValue: ["a", "c"] },
        L.createElement("option", { value: "a" }, "A"),
        L.createElement("option", { value: "b" }, "B"),
        L.createElement("option", null, "c"),
      ),
    );
    await same((L) =>
      L.createElement("select", { dangerouslySetInnerHTML: { __html: "<option>x</option>" }, id: "s" }),
    );
    await same((L) =>
      L.createElement(
        "select",
        null,
        L.createElement("option", { selected: true, value: "x" }, "X"),
        L.createElement("option", { dangerouslySetInnerHTML: { __html: "y" } }),
        L.createElement("option", { value: "z" }, "a", 1, null),
      ),
    );
    await same((L) => L.createElement("select", { value: "1" }, L.createElement("option", null, "1")));
    await same((L) => L.createElement("textarea", { value: "\nhi <b>", onChange: () => {}, rows: 3 }));
    await same((L) => L.createElement("textarea", { defaultValue: "dv" }));
    await same((L) => L.createElement("textarea", null, "child"));
    await same((L) => L.createElement("textarea", null, ["one"]));
    await same((L) => L.createElement("textarea"));
    await sameError((L) => L.createElement("textarea", { value: "v" }, "child"));
    await sameError((L) => L.createElement("textarea", null, "a", "b"));
    await sameError((L) => L.createElement("textarea", { dangerouslySetInnerHTML: { __html: "" } }));
    await same((L) =>
      L.createElement(
        "div",
        null,
        L.createElement("input", { value: "v", checked: true, onChange: () => {}, type: "checkbox", name: "n" }),
        L.createElement("input", { defaultValue: "d", defaultChecked: false, type: "radio" }),
        L.createElement("input", { checked: false, value: 0, readOnly: true }),
        L.createElement("input", { formAction: "/go", formEncType: "e", formMethod: "post", formTarget: "_blank" }),
      ),
    );
  });

  test("form actions as functions", async () => {
    const action = (): void => {};
    await same((L) =>
      L.createElement(
        "div",
        null,
        L.createElement("form", { action, method: "post" }, L.createElement("button", null, "go")),
        L.createElement("button", { formAction: action, name: "b" }, "b"),
        L.createElement("input", { type: "submit", formAction: action, formTarget: "t" }),
      ),
    );
    await same(
      (L) =>
        L.createElement(
          "html",
          null,
          L.createElement("head"),
          L.createElement("body", null, L.createElement("form", { action }, "f")),
        ),
      { bootstrapScriptContent: "go()" },
    );
    await same((L) =>
      L.createElement("form", {
        action: "/a",
        encType: "multipart/form-data",
        target: "t",
        dangerouslySetInnerHTML: { __html: "x" },
      }),
    );
  });

  test("server actions' own form fields ($$FORM_ACTION)", async () => {
    const withFields = (data: FormData | null): Any => {
      const fn = (): void => {};
      (fn as Any).$$FORM_ACTION = (name: string) => ({
        name,
        action: "/act",
        encType: "multipart/form-data",
        method: "POST",
        target: "_self",
        data,
      });
      return fn;
    };
    const data = new FormData();
    data.append("a", "1");
    await same((L) =>
      L.createElement(
        "div",
        null,
        L.createElement("form", { action: withFields(data) }, "f"),
        L.createElement("button", { formAction: withFields(data) }, "b"),
        L.createElement("input", { formAction: withFields(null) }),
        L.createElement("form", { action: withFields(null) }, "g"),
      ),
    );
    // A field that is a file cannot be written: the action falls back to the replaying runtime.
    const file = new FormData();
    file.append("f", new Blob(["x"]));
    await same((L) => L.createElement("form", { action: withFields(file) }, "f"), quiet);
    // An action whose $$FORM_ACTION throws is treated as a plain function; one that suspends suspends.
    const throwing = (): void => {};
    (throwing as Any).$$FORM_ACTION = () => {
      throw new Error("no");
    };
    await same((L) => L.createElement("form", { action: throwing }, "f"));
    const empty = (): void => {};
    (empty as Any).$$FORM_ACTION = () => ({ name: "n", action: "", data: null });
    await same((L) => L.createElement("form", { action: empty }, "f"));
    await same((L) => L.createElement("button", { formAction: empty }, "b"));
  });
});

describe("hoistables and resources", () => {
  test("title, meta and link go to the head; svg, noscript and itemProp keep them in place", async () => {
    await same((L) =>
      L.createElement(
        "div",
        null,
        "t",
        L.createElement("title", null, "Hi ", "there"),
        L.createElement("title", null, ["Only"]),
        L.createElement("title", null, 3),
        L.createElement("title", { dangerouslySetInnerHTML: { __html: "x" } }),
        L.createElement("meta", { name: "description", content: "d" }),
        L.createElement("meta", { charSet: "utf-8" }),
        L.createElement("meta", { name: "viewport", content: "width=device-width" }),
        L.createElement("meta", { itemProp: "p", content: "c" }),
        L.createElement("link", { rel: "icon", href: "/favicon.ico" }),
        L.createElement("link", { rel: "icon", href: "" }),
        L.createElement("link", { rel: "icon", href: "/x", onLoad: () => {} }),
        L.createElement("link", { itemProp: "url", href: "/u" }),
        L.createElement(
          "noscript",
          null,
          L.createElement("title", null, "ns"),
          L.createElement("link", { rel: "a", href: "/n" }),
        ),
        L.createElement("svg", null, L.createElement("title", null, "s"), L.createElement("meta", { name: "m" })),
        "u",
      ),
    );
  });

  test("a full document: doctype, head, body and the preamble order", async () => {
    const make: Make = (L) =>
      L.createElement(
        "html",
        { lang: "en" },
        L.createElement(
          "head",
          null,
          L.createElement("meta", { charSet: "utf-8" }),
          L.createElement("title", null, "Doc"),
          L.createElement("link", { rel: "stylesheet", href: "/a.css", precedence: "default" }),
          L.createElement("script", { async: true, src: "/a.js" }),
          L.createElement("style", { href: "s1", precedence: "default" }, "body{color:red}"),
        ),
        L.createElement(
          "body",
          { className: "b" },
          L.createElement("img", { src: "/hero.png", fetchPriority: "high" }),
          L.createElement("p", null, "content"),
          L.createElement("link", { rel: "stylesheet", href: "/b.css", precedence: "high" }),
          L.createElement("link", { rel: "stylesheet", href: "/a.css", precedence: "default" }),
          L.createElement("script", { async: true, src: "/m.js", type: "module" }),
          L.createElement("script", { async: true, src: "/a.js" }),
          L.createElement("style", { href: "s1", precedence: "default" }, "dup"),
          L.createElement("style", { href: "s2", precedence: "default" }, ["only"]),
          L.createElement("style", { href: "s3", precedence: "low", dangerouslySetInnerHTML: { __html: "x{}" } }),
          L.createElement("style", { href: "s4", precedence: "low", nonce: "n" }, () => {}),
          L.createElement("style", null, "inline</style>"),
          L.createElement("style", { href: "", precedence: "x" }, "plain"),
          L.createElement("style", null, ["a", "b"]),
          L.createElement("script", null, "var a = '</script>';"),
          L.createElement("script", { src: "/sync.js" }),
          L.createElement("script", { async: true, src: "/err.js", onError: () => {} }),
          L.createElement("script", { dangerouslySetInnerHTML: { __html: "1" } }),
          L.createElement("link", { rel: "stylesheet", href: "/plain.css" }),
          L.createElement("link", { rel: "stylesheet", href: "/load.css", precedence: "x", onLoad: () => {} }),
        ),
      );
    await same(make, undefined, true);
    await same(make, {
      identifierPrefix: "p-",
      nonce: "abc",
      bootstrapScripts: ["/boot.js"],
      bootstrapModules: ["/mod.js"],
    });
    await same(make, {
      nonce: { script: "s", style: "t" },
      bootstrapScripts: [{ src: "/b.js", integrity: "sha", crossOrigin: "use-credentials" }],
      bootstrapModules: [{ src: "/m.js", crossOrigin: "anonymous" }, { src: "/n.js" }],
      bootstrapScriptContent: "start()</script>",
      importMap: { imports: { a: "/a.js" } },
    });
    await same(make, { nonce: { style: "t" } });
  });

  test("html, head and body nested in other elements, and rendered twice", async () => {
    await same((L) =>
      L.createElement("div", null, L.createElement("body", null, "x"), L.createElement("head", null, "h")),
    );
    await same((L) => L.createElement("html", null, L.createElement("body", null, "only body")));
    await same((L) => L.createElement("head", null, L.createElement("title", null, "t")));
    await same((L) => L.createElement("body", null, "b"));
    await sameError((L) => L.createElement("html", null, L.createElement("head"), L.createElement("head")));
    await sameError((L) => L.createElement(L.Fragment, null, L.createElement("body"), L.createElement("body")));
    await sameError((L) => L.createElement(L.Fragment, null, L.createElement("html"), L.createElement("html")));
  });

  test("resource hints called while rendering go to the head, in React's order", async () => {
    const make: Make = (L) => {
      const D = dom(L);
      function Hints(): Any {
        D.prefetchDNS("https://dns.example");
        D.prefetchDNS("https://dns.example");
        D.prefetchDNS("");
        D.prefetchDNS(3);
        D.preconnect("https://a.example");
        D.preconnect("https://a.example", { crossOrigin: "anonymous" });
        D.preconnect("https://a.example", { crossOrigin: "use-credentials" });
        D.preconnect("https://a.example", { crossOrigin: "use-credentials" });
        D.preconnect("https://b.example", {});
        D.preconnect("");
        D.preconnect(3);
        D.preload("/font.woff2", { as: "font", type: "font/woff2" });
        D.preload("/font.woff2", { as: "font" });
        D.preload("/hero.png", { as: "image", fetchPriority: "high" });
        D.preload("/a.png", { as: "image" });
        D.preload("/a.png", { as: "image" });
        D.preload("/x.png", { as: "image", imageSrcSet: "/x1.png 1x, /x2.png 2x", imageSizes: "50vw" });
        D.preload("/s.css", { as: "style", crossOrigin: "use-credentials", integrity: "sha-s" });
        D.preload("/s.css", { as: "style" });
        D.preload("/plain.css", { as: "style", media: "print" });
        D.preload("/p.js", { as: "script", integrity: "sha-p", referrerPolicy: "no-referrer", nonce: "n" });
        D.preload("/p.js", { as: "script" });
        D.preload("/q.js", { as: "script" });
        D.preload("/q2.js", { as: "script", crossOrigin: "use-credentials" });
        D.preloadModule("/m2.js", { integrity: "sha-m2" });
        D.preloadModule("/m3.js");
        D.preload("/data.json", { as: "fetch", crossOrigin: "" });
        D.preload("/data.json", { as: "fetch" });
        D.preload("/track.vtt", { as: "track" });
        D.preload("", { as: "image" });
        D.preload("/x", { as: "" });
        D.preload("/x", {});
        D.preload("/x");
        D.preloadModule("/m.js");
        D.preloadModule("/m.js", { as: "script" });
        D.preloadModule("/n.js", { crossOrigin: "use-credentials", integrity: "sha-n" });
        D.preloadModule("/w.js", { as: "worker", nonce: "n" });
        D.preloadModule("/w.js", { as: "worker" });
        D.preloadModule("/w2.js", { as: "worker" });
        D.preloadModule("");
        D.preloadModule(3);
        D.preinit("/s.css", { as: "style", precedence: "high" });
        D.preinit("/t.css", { as: "style", fetchPriority: "low" });
        D.preinit("/t.css", { as: "style" });
        D.preinit("/u.css", { as: "style", precedence: "high", integrity: "sha-u", crossOrigin: "x" });
        D.preinit("/p.js", { as: "script" });
        D.preinit("/r.js", { as: "script", nonce: "n", crossOrigin: "use-credentials", fetchPriority: "high" });
        D.preinit("/r.js", { as: "script" });
        D.preinit("/x", { as: "image" });
        D.preinit("", { as: "style" });
        D.preinit("/x");
        D.preinitModule("/n.js");
        D.preinitModule("/o.js", { integrity: "sha-o", crossOrigin: "" });
        D.preinitModule("/o.js");
        D.preinitModule("/w3.js", { as: "worker" });
        D.preinitModule("/v.js", { as: "script" });
        D.preinitModule("/z.js", "bad");
        D.preinitModule("");
        return L.createElement("p", null, "hinted");
      }
      return L.createElement(
        "div",
        null,
        L.createElement("link", { rel: "stylesheet", href: "/plain.css", precedence: "default" }),
        L.createElement("script", { async: true, src: "/q.js" }),
        L.createElement("script", { async: true, src: "/m.js", type: "module" }),
        L.createElement(Hints),
        L.createElement("link", { rel: "stylesheet", href: "/s.css", precedence: "high" }),
        L.createElement("script", { async: true, src: "/n.js", type: "module" }),
        L.createElement("script", { async: true, src: "/q2.js" }),
        L.createElement("script", { async: true, src: "/m2.js", type: "module" }),
        L.createElement("script", { async: true, src: "/m3.js", type: "module" }),
      );
    };
    await same(make, undefined, true);
    await same(make, { nonce: "abc" });
  });

  test("resource hints in a document, from a class, and from content that streams in later", async () => {
    const make: Make = (L) => {
      const D = dom(L);
      class Klass extends L.Component {
        render(): Any {
          D.preload("/class.css", { as: "style" });
          D.preinit("/class.js", { as: "script" });
          return "class";
        }
      }
      let p: Any;
      function Late(): Any {
        L.use((p ??= later("late")));
        D.preconnect("https://late.example");
        D.preload("/late.png", { as: "image" });
        D.preload("/late.woff", { as: "font" });
        D.preload("/late.css", { as: "style" });
        D.preinit("/late.css", { as: "style", precedence: "default" });
        D.preinit("/late2.css", { as: "style", precedence: "default" });
        D.preinit("/early2.css", { as: "style", precedence: "default" });
        D.preinit("/late.js", { as: "script" });
        D.preinitModule("/late.mjs");
        D.preloadModule("/late-m.js");
        return L.createElement("span", null, "late");
      }
      function Early(): Any {
        D.preload("/early.css", { as: "style" });
        D.preload("/early2.css", { as: "style", integrity: "sha-e" });
        return "early";
      }
      return L.createElement(
        "html",
        null,
        L.createElement("head", null, L.createElement(Early)),
        L.createElement(
          "body",
          null,
          L.createElement(Klass),
          L.createElement("link", { rel: "stylesheet", href: "/early.css", precedence: "default" }),
          L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Late)),
        ),
      );
    };
    await sameStream(make);
    expect(await pipeAll(Server, make(Compat))).toBe(await pipeAll(ReactNodeServer, make(React)));
    expect(await pipeAll(Server, make(Compat), undefined, true)).toBe(
      await pipeAll(ReactNodeServer, make(React), undefined, true),
    );
    expect(Server.renderToString(make(Compat))).toBe(ReactServer.renderToString(make(React)));
  });

  test("onHeaders: early hints as a Link header, the rest as links in the HTML", async () => {
    // What each server gives onHeaders (a Headers object for streams, a plain object for pipes),
    // then the HTML.
    const run = async (server: Any, L: Lib, options: Options, pipe: Any): Promise<string> => {
      const seen: string[] = [];
      const errors: string[] = [];
      const onHeaders = (h: Any): void => {
        seen.push(JSON.stringify(h instanceof Headers ? Object.fromEntries(h.entries()) : h));
        if (options["throws"]) throw new Error("onHeaders threw");
      };
      const all = {
        ...options,
        onHeaders,
        onError: (e: Any, info: Any) => void errors.push(e.message + Object.keys(info)),
      };
      const html = pipe ? await pipeAll(pipe, make(L), all, true) : await streamAll(server, make(L), all);
      return [...seen, ...errors, html].join("\n");
    };
    let shellDelay = 0;
    const make: Make = (L) => {
      const D = dom(L);
      let p: Any;
      // Suspends the shell, after Shell has hinted.
      const Wait = (): Any => (shellDelay ? L.use((p ??= later("waited", shellDelay))) : null);
      function Shell(): Any {
        D.prefetchDNS("https://dns.example");
        D.preconnect("https://a.example/<x>", { crossOrigin: "use-credentials" });
        D.preconnect("https://b.example");
        D.preload("/f\n.woff2", { as: "font", type: 'font/"woff2";,' });
        D.preload("/hero.png", { as: "image", fetchPriority: "high" });
        D.preload("/set.png", { as: "image", fetchPriority: "high", imageSrcSet: "/s1.png 1x" });
        D.preload("/plain.png", { as: "image" });
        D.preload("/script.js", { as: "script" });
        D.preinit("/a.css", { as: "style", precedence: "high", crossOrigin: "anonymous", integrity: "sha" });
        return L.createElement(
          "div",
          null,
          L.createElement("img", { src: "/img.png", fetchPriority: "high", sizes: "1px", nonce: "n" }),
          L.createElement("img", { src: "/img2.png" }),
          L.createElement("img", { srcSet: "/img3.png 2x" }),
          L.createElement("link", { rel: "stylesheet", href: "/b.css", precedence: "high", media: "print" }),
          L.createElement("link", { rel: "stylesheet", href: "/c.css", precedence: "low" }),
          L.createElement("link", { rel: "stylesheet", href: "/d.css", precedence: "low", integrity: "i" }),
          L.createElement("p", null, "x"),
          L.createElement(Wait),
        );
      }
      return L.createElement(Shell);
    };
    const both = async (options: Options): Promise<void> => {
      expect(await run(Server, Compat, options, null)).toBe(await run(ReactServer, React, options, null));
      expect(await run(null, Compat, options, Server)).toBe(await run(null, React, options, ReactNodeServer));
    };
    await both({});
    await both({ maxHeadersLength: 120 });
    await both({ maxHeadersLength: 0 });
    await both({ throws: true });
    // A shell still rendering when the first work ends: its stylesheets join the header.
    shellDelay = 5;
    await both({});
    await both({ maxHeadersLength: 600 });
    await both({ maxHeadersLength: 650 });
    shellDelay = 0;
    // Nothing to hint: an empty header set.
    const empty = async (server: Any): Promise<string> => {
      let seen = "";
      await streamAll(server, Compat.createElement("p"), {
        onHeaders: (h: Any) => void (seen = JSON.stringify(Object.fromEntries(h.entries()))),
      });
      return seen;
    };
    expect(await empty(Server)).toBe(await empty(ReactServer));
  });

  test("onHeaders: many high-priority images, and preloads too long for any header", async () => {
    const run = async (server: Any, L: Lib): Promise<string> => {
      let seen = "";
      const html = await streamAll(
        server,
        L.createElement(
          "div",
          null,
          Array.from({ length: 40 }, (_, i) =>
            L.createElement("img", {
              key: i,
              src: `/image-number-${i}.png`,
              fetchPriority: i % 2 ? "high" : undefined,
            }),
          ),
        ),
        { onHeaders: (h: Any) => void (seen = h.get("Link")), maxHeadersLength: 100000 },
      );
      return seen + "\n" + html;
    };
    expect(await run(Server, Compat)).toBe(await run(ReactServer, React));
  });

  test("image preloads: the first ten, high priority ones, srcset, and those left out", async () => {
    await same((L) =>
      L.createElement(
        "div",
        null,
        Array.from({ length: 12 }, (_, i) => L.createElement("img", { key: i, src: `/i${i}.png` })),
        L.createElement("img", { src: "/i11.png", fetchPriority: "high" }),
        L.createElement("img", { src: "/i0.png" }),
        L.createElement("img", { srcSet: "/a.png 1x, /b.png 2x", sizes: "100vw", crossOrigin: "use-credentials" }),
        L.createElement("img", { src: "/c.png", crossOrigin: "" }),
        L.createElement("img", { src: "/lazy.png", loading: "lazy" }),
        L.createElement("img", { src: "/low.png", fetchPriority: "low" }),
        L.createElement("img", { src: "data:image/png;base64,AA" }),
        L.createElement("img", { srcSet: "DATA:x" }),
        L.createElement("img", { src: 3 }),
        L.createElement("img", { srcSet: 3 }),
        L.createElement("img", {}),
        L.createElement("picture", null, L.createElement("img", { src: "/p.png" })),
        L.createElement("noscript", null, L.createElement("img", { src: "/n.png" })),
        L.createElement("img", { src: "/i13.png" }),
      ),
    );
  });
});

describe("components", () => {
  test("function components, memo, forwardRef, lazy and context", async () => {
    const make: Make = (L) => {
      const Ctx = L.createContext("default");
      const Hello = ({ name }: Any): Any => L.createElement("b", null, "Hello, ", name);
      const Memo = L.memo(Hello);
      const Fwd = L.forwardRef((props: Any, ref: Any) =>
        L.createElement("i", { "data-ref": ref === null ? "null" : typeof ref }, props.children),
      );
      const Read = (): Any => L.createElement("u", null, L.useContext(Ctx));
      const Lazy = L.lazy(() => ({ then: (r: Any) => r({ default: Read }) }));
      return L.createElement(
        "div",
        null,
        L.createElement(Hello, { name: "a" }),
        L.createElement(Memo, { name: "b" }),
        L.createElement(Fwd, { ref: () => {} }, "fwd"),
        L.createElement(Fwd, null, "no ref"),
        L.createElement(Read),
        L.createElement(
          Ctx.Provider ?? Ctx,
          { value: "outer" },
          L.createElement(Read),
          L.createElement(
            Ctx,
            { value: "inner" },
            L.createElement(Read),
            L.createElement(Ctx.Consumer, null, (v: string) => v + "!"),
          ),
          L.createElement(Read),
          Ctx,
        ),
        L.createElement(Read),
        L.createElement(L.Suspense, { fallback: "..." }, L.createElement(Lazy)),
      );
    };
    await sameStream(make);
  });

  test("lazy nodes and elements of a lazy memo", async () => {
    const make: Make = (L) => {
      const Item = L.memo(({ x }: Any) => L.createElement("li", null, x));
      const lazyType = { $$typeof: Symbol.for("react.lazy"), _payload: null, _init: () => Item };
      const lazyNode = { $$typeof: Symbol.for("react.lazy"), _payload: "node", _init: (p: string) => p };
      return L.createElement("ul", null, L.createElement(lazyType, { x: 1 }), lazyNode);
    };
    await same(make);
  });

  test("context values are restored after the render", async () => {
    const Ctx = Compat.createContext("default");
    Server.renderToString(Compat.createElement(Ctx, { value: "x" }, "y"));
    expect((Ctx as Any)._currentValue).toBe("default");
    // Also when the render throws midway.
    const Boom = (): never => {
      throw new Error("boom");
    };
    expect(() => Server.renderToString(Compat.createElement(Ctx, { value: "x" }, Compat.createElement(Boom)))).toThrow(
      "boom",
    );
    expect((Ctx as Any)._currentValue).toBe("default");
  });

  test("context switches between tasks of different depths", async () => {
    const make: Make = (L) => {
      const A = L.createContext("a0");
      const B = L.createContext("b0");
      const C = L.createContext("c0");
      const cache = new Map<string, Any>();
      const Wait = ({ id, ms }: Any): Any => {
        let p = cache.get(id);
        if (!p) cache.set(id, (p = later(id, ms)));
        const v = L.use(p);
        return L.createElement("i", null, v, L.useContext(A), L.useContext(B), L.useContext(C));
      };
      return L.createElement(
        A,
        { value: "a1" },
        L.createElement(
          B,
          { value: "b1" },
          L.createElement(
            C,
            { value: "c1" },
            L.createElement(L.Suspense, { fallback: "f1" }, L.createElement(Wait, { id: "deep", ms: 4 })),
          ),
          L.createElement(L.Suspense, { fallback: "f2" }, L.createElement(Wait, { id: "mid", ms: 2 })),
        ),
        L.createElement(
          C,
          { value: "c2" },
          L.createElement(
            A,
            { value: "a2" },
            L.createElement(
              B,
              { value: "b2" },
              L.createElement(L.Suspense, { fallback: "f3" }, L.createElement(Wait, { id: "other", ms: 3 })),
            ),
          ),
        ),
        L.createElement(L.Suspense, { fallback: "f4" }, L.createElement(Wait, { id: "top", ms: 1 })),
      );
    };
    await sameStream(make);
  });

  test("class components: constructor, defaultProps, contextType, getDerivedStateFromProps, will-mount", async () => {
    const make: Make = (L) => {
      const Ctx = L.createContext("ctx");
      class Plain extends L.Component {
        render(): Any {
          return L.createElement(
            "p",
            null,
            String(this.state),
            this.props.a,
            this.context === undefined ? "u" : typeof this.context,
          );
        }
      }
      class WithState extends L.Component {
        static defaultProps = { a: "default-a", b: "default-b" };
        static contextType = Ctx;
        state: Any = { n: 1 };
        UNSAFE_componentWillMount(): void {
          this.setState({ n: 2 });
          this.setState((s: Any, p: Any) => ({ n: s.n + 1, p: p.a }));
          this.setState(null);
        }
        render(): Any {
          this.setState({ n: 100 });
          return L.createElement("p", null, this.state.n, this.state.p, this.props.b, this.context);
        }
      }
      class Both extends L.Component {
        componentWillMount(): void {
          this.setState({ a: 1 });
        }
        UNSAFE_componentWillMount(): void {
          this.setState({ b: 2 });
          this.forceUpdate();
        }
        render(): Any {
          return L.createElement("p", null, JSON.stringify(this.state));
        }
      }
      class Replace extends L.Component {
        constructor(props: Any) {
          super(props);
          this.state = { a: 1 };
        }
        UNSAFE_componentWillMount(): void {
          this.state = { replaced: true };
        }
        render(): Any {
          return L.createElement("p", null, JSON.stringify(this.state));
        }
      }
      class ReplaceThenSet extends L.Component {
        state: Any = { a: 1 };
        UNSAFE_componentWillMount(): void {
          this.state = { r: 1 };
          this.setState({ s: 2 });
          this.setState(() => null);
          this.setState({ t: 3 });
        }
        render(): Any {
          return L.createElement("p", null, JSON.stringify(this.state));
        }
      }
      class Derived extends L.Component {
        state = { base: 1 };
        static getDerivedStateFromProps(props: Any, state: Any): Any {
          return props.skip ? null : { derived: props.v, had: state.base };
        }
        UNSAFE_componentWillMount(): void {
          this.setState({ never: true });
        }
        render(): Any {
          return L.createElement("p", null, JSON.stringify(this.state));
        }
      }
      class Snapshot extends L.Component {
        getSnapshotBeforeUpdate(): null {
          return null;
        }
        UNSAFE_componentWillMount(): void {
          this.setState({ never: true });
        }
        render(): Any {
          return L.createElement("p", null, String(this.state));
        }
      }
      class NoState extends L.Component {
        state = undefined;
        static getDerivedStateFromProps(): Any {
          return { d: 1 };
        }
        render(): Any {
          return L.createElement("p", null, JSON.stringify(this.state));
        }
      }
      class Pure extends L.PureComponent {
        render(): Any {
          return L.createElement("p", null, "pure ", this.props.ref === undefined ? "no ref" : "ref");
        }
      }
      return L.createElement(
        Ctx,
        { value: "provided" },
        L.createElement(Plain, { a: "A" }),
        L.createElement(WithState, { a: undefined }),
        L.createElement(Both),
        L.createElement(Replace),
        L.createElement(ReplaceThenSet),
        L.createElement(Derived, { v: "x" }),
        L.createElement(Derived, { skip: true }),
        L.createElement(Snapshot),
        L.createElement(NoState),
        L.createElement(Pure, { ref: () => {} }),
      );
    };
    await same(make);
  });

  test("invalid element types and children", async () => {
    await sameError((L) => L.createElement("div", null, L.createElement(undefined)));
    await sameError((L) => L.createElement("div", null, L.createElement(null)));
    await sameError((L) => L.createElement("div", null, L.createElement({})));
    await sameError((L) => L.createElement("div", null, L.createElement(42)));
    await sameError(() => ({ a: 1, b: 2 }));
    await sameError(() => new Map());
    await sameError((L) =>
      L.createElement("div", null, L.createPortal?.("x", { nodeType: 1 }) ?? { $$typeof: Symbol.for("react.portal") }),
    );
    await sameError((L) => L.createElement(Symbol.for("react.scope")));
  });

  test("Fragment, StrictMode, Profiler, iterables and context objects as children", async () => {
    await same((L) =>
      L.createElement(
        L.StrictMode,
        null,
        L.createElement(L.Profiler, { id: "p", onRender: () => {} }, "a", "b"),
        L.createElement(Symbol.for("react.legacy_hidden"), null, "hidden?"),
        new Set(["s1", "s2"]),
        new Set(),
        {
          [Symbol.iterator]: () => null,
          then: undefined,
          $$typeof: Symbol.for("react.context"),
          _currentValue: "ctx-as-child",
          // React's renderToString reads the second value.
          _currentValue2: "ctx-as-child",
        },
        (function* () {
          yield "g1";
          yield L.createElement("b", { key: "x" }, "g2");
        })(),
      ),
    );
  });

  test("Activity: visible content between markers, hidden content not rendered", async () => {
    await same((L) =>
      L.createElement(
        "div",
        null,
        "a",
        L.createElement(L.Activity, { mode: "visible" }, "b", "c"),
        L.createElement(L.Activity, { mode: "hidden" }, "never"),
        "d",
      ),
    );
  });

  test("text next to suspended work and the segments it spawns", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Wait = (): Any => L.use((p ??= later("w", 2)));
      return L.createElement(
        "div",
        null,
        "a",
        L.createElement(Wait),
        "b",
        L.createElement(L.Suspense, { fallback: "f" }, "c", L.createElement(Wait), "d"),
        L.createElement("span", null, "e", L.createElement(Wait)),
      );
    };
    await sameStream(make);
    expect(thrown(() => Server.renderToString(make(Compat)))).toBe(
      thrown(() => ReactServer.renderToString(make(React))),
    );
  });
});

describe("hooks", () => {
  test("state, reducers, refs, memos, callbacks, effects and transitions render their initial values", async () => {
    const make: Make = (L) => {
      const Counter = (): Any => {
        const [n, setN] = L.useState(1);
        const [m] = L.useState(() => 2);
        const [r, dispatch] = L.useReducer((s: number, a: number) => s + a, 10);
        const [lazyR] = L.useReducer(
          (s: number) => s,
          5,
          (x: number) => x * 2,
        );
        const ref = L.useRef("ref");
        const memo = L.useMemo(() => n + m, [n, m]);
        const cb = L.useCallback(() => n, [n]);
        const [pending, start] = L.useTransition();
        const deferred = L.useDeferredValue("deferred");
        const deferredInitial = L.useDeferredValue("final", "initial");
        const [optimistic] = L.useOptimistic("opt");
        const [actionState, formAction, isPending] = L.useActionState((s: number) => s + 1, 7);
        const event = L.useEffectEvent(() => n);
        L.useEffect(() => {
          throw new Error("effects never run on the server");
        });
        L.useLayoutEffect(() => {
          throw new Error("layout effects never run on the server");
        });
        L.useInsertionEffect(() => {
          throw new Error("insertion effects never run on the server");
        });
        L.useImperativeHandle(ref, () => "handle");
        L.useDebugValue("debug");
        (void setN, dispatch, cb, start, formAction, event);
        return L.createElement(
          "p",
          null,
          [
            n,
            m,
            r,
            lazyR,
            ref.current,
            memo,
            String(pending),
            deferred,
            deferredInitial,
            optimistic,
            actionState,
            String(isPending),
          ].join(","),
        );
      };
      return L.createElement("div", null, L.createElement(Counter), L.createElement(Counter));
    };
    await same(make);
  });

  test("setState during render re-renders the component; elsewhere it does nothing", async () => {
    const make: Make = (L) => {
      let setOuter: Any = null;
      const Child = (): Any => {
        setOuter?.(99);
        return "child";
      };
      const Loop = (): Any => {
        const [n, setN] = L.useState(0);
        const [, dispatch] = L.useReducer((s: number) => s + 1, 0);
        setOuter = setN;
        if (n < 3) setN(n + 1);
        void dispatch;
        return L.createElement("p", null, n, L.createElement(Child));
      };
      return L.createElement(Loop);
    };
    await same(make);
    await sameError((L) => {
      const Forever = (): Any => {
        const [n, setN] = L.useState(0);
        setN(n + 1);
        return n;
      };
      return L.createElement(Forever);
    });
  });

  test("useId: React's server ids, by place in the tree, with and without a prefix", async () => {
    const make: Make = (L) => {
      const Id = (): Any => {
        const a = L.useId();
        const b = L.useId();
        return L.createElement("label", { htmlFor: a, id: b }, a);
      };
      const Plain = ({ children }: Any): Any => L.createElement("div", null, children);
      const Nested = (): Any => {
        const id = L.useId();
        return L.createElement("section", { id }, L.createElement(Id), [
          L.createElement(Id, { key: 1 }),
          L.createElement(Id, { key: 2 }),
        ]);
      };
      return L.createElement(
        "main",
        null,
        L.createElement(Id),
        L.createElement(Plain, null, L.createElement(Id), L.createElement(Id)),
        L.createElement(Nested),
        Array.from({ length: 40 }, (_, i) => L.createElement(Plain, { key: i }, L.createElement(Id))),
        L.createElement(L.Suspense, { fallback: null }, L.createElement(Id)),
      );
    };
    await same(make);
    await same(make, { identifierPrefix: "app-" });
  });

  test("useId deep enough to overflow React's 30-bit tree ids", async () => {
    const make: Make = (L) => {
      const Id = (): Any => L.createElement("i", null, L.useId());
      let node: Any = L.createElement(Id);
      for (let depth = 0; depth < 20; depth++)
        node = [
          L.createElement("b", { key: "a" }, "x"),
          L.createElement("b", { key: "b" }, "y"),
          L.createElement("s", { key: "c" }, node),
        ];
      return L.createElement("div", null, node);
    };
    await same(make);
  });

  test("useSyncExternalStore reads the server snapshot; without one it throws", async () => {
    const subscribe = (): (() => void) => () => {};
    const make: Make = (L) => {
      const Store = (): Any => {
        const v = L.useSyncExternalStore(
          subscribe,
          () => "client",
          () => "server",
        );
        return L.createElement("p", null, v);
      };
      return L.createElement(Store);
    };
    await same(make);
    const missing: Make = (L) => {
      const Store = (): Any => L.useSyncExternalStore(subscribe, () => "client");
      return L.createElement(L.Suspense, { fallback: "fb" }, L.createElement(Store));
    };
    await same(missing, quiet);
    await sameError((L) => {
      const Store = (): Any => L.useSyncExternalStore(subscribe, () => "client");
      return L.createElement(Store);
    });
  });

  test("useSyncExternalStoreWithSelector selects from the server snapshot", () => {
    const subscribe = (): (() => void) => () => {};
    const Store = (): Any =>
      Compat.useSyncExternalStoreWithSelector(
        subscribe,
        () => ({ v: "client" }),
        () => ({ v: "server" }),
        (s: Any) => s.v,
      );
    expect(Server.renderToString(Compat.createElement(Store))).toBe("server");
    const NoServer = (): Any =>
      Compat.useSyncExternalStoreWithSelector(
        subscribe,
        () => ({ v: "client" }),
        null,
        (s: Any) => s.v,
      );
    expect(() => Server.renderToString(Compat.createElement(NoServer))).toThrow("Missing getServerSnapshot");
  });

  test("a hook's client path is unchanged after a server render", () => {
    // The server's state is per render: a client root in the same realm is unaffected.
    const Id = (): Any => Compat.useId();
    expect(Server.renderToString(Compat.createElement(Id))).toBe("_R_0_");
    expect(Server.renderToString(Compat.createElement(Id))).toBe("_R_0_");
  });

  test("use: context and resolved promises", async () => {
    const make: Make = (L) => {
      const Ctx = L.createContext("c");
      const done = Promise.resolve("resolved");
      (done as Any).status = "fulfilled";
      (done as Any).value = "resolved";
      const Use = (): Any => L.createElement("p", null, L.use(Ctx), L.use(done));
      return L.createElement(Ctx, { value: "v" }, L.createElement(Use));
    };
    await same(make);
  });
});

describe("Suspense", () => {
  test("content that completes renders inline, between markers", async () => {
    await same(
      (L) => L.createElement("div", null, L.createElement(L.Suspense, { fallback: "loading" }, "a", "b")),
      undefined,
      true,
    );
    await same((L) => L.createElement(L.Suspense, null, L.createElement(L.Suspense, { fallback: "x" }, "nested")));
  });

  test("renderToString leaves suspended content to the client; renderToStaticMarkup too", async () => {
    const make: Make = (L) => {
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: L.createElement("i", null, "loading") }, L.createElement(Never)),
        L.createElement(L.Suspense, { fallback: "f2" }, "done"),
      );
    };
    expect(Server.renderToString(make(Compat))).toBe(ReactServer.renderToString(make(React)));
    expect(Server.renderToStaticMarkup(make(Compat))).toBe(ReactServer.renderToStaticMarkup(make(React)));
  });

  test("suspending outside any boundary throws from renderToString", () => {
    const make: Make = (L) => {
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement("div", null, L.createElement(Never));
    };
    expect(thrown(() => Server.renderToString(make(Compat)))).toBe(
      thrown(() => ReactServer.renderToString(make(React))),
    );
    expect(thrown(() => Server.renderToStaticMarkup(make(Compat)))).toBe(
      thrown(() => ReactServer.renderToStaticMarkup(make(React))),
    );
  });

  test("an error inside a boundary renders its fallback, for the client to retry", async () => {
    const make: Make = (L) => {
      const Boom = (): never => {
        throw new Error("boom");
      };
      return L.createElement(
        "div",
        null,
        L.createElement(
          L.Suspense,
          { fallback: L.createElement("b", null, "fallback") },
          "before",
          L.createElement(Boom),
        ),
      );
    };
    await same(make, quiet, true);
    await same(make, { onError: () => "digest-1" });
    await same(make, { onError: () => "" });
    await same(make, { onError: () => 42 });
  });

  test("unstable_externalRuntimeSrc changes nothing, as React's production build ignores it", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Late = (): Any => L.use((p ??= later("late")));
      return L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Late)));
    };
    const options = { unstable_externalRuntimeSrc: "/runtime.js" };
    expect(await streamAll(Server, make(Compat), options)).toBe(await streamAll(ReactServer, make(React), options));
    expect(await pipeAll(Server, make(Compat), options)).toBe(await pipeAll(ReactNodeServer, make(React), options));
    expect(await streamAll(Server, make(Compat), options)).toBe(await streamAll(Server, make(Compat)));
  });

  test("the default onError logs to the console", async () => {
    const make: Make = (L) => {
      const Boom = (): never => {
        throw new Error("logged");
      };
      return L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Boom));
    };
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await sameStream(make);
      expect(spy).toHaveBeenCalledTimes(2);
      expect((spy.mock.calls[1]![0] as Error).message).toBe("logged");
    } finally {
      spy.mockRestore();
    }
  });

  test("an error outside any boundary fails the render", async () => {
    await sameError((L) => {
      const Boom = (): never => {
        throw new Error("shell");
      };
      return L.createElement("div", null, L.createElement(Boom));
    });
  });

  test("streaming: the shell first, then each boundary's content and the script that reveals it", async () => {
    const make: Make = (L) => {
      const cache = new Map<string, Any>();
      const Wait = ({ id, ms, children }: Any): Any => {
        let p = cache.get(id);
        if (!p) cache.set(id, (p = later(id, ms)));
        return L.createElement("span", null, L.use(p), children);
      };
      return L.createElement(
        "div",
        null,
        L.createElement("h1", null, "shell"),
        L.createElement(
          L.Suspense,
          { fallback: L.createElement("p", null, "loading one") },
          L.createElement(Wait, { id: "one", ms: 2 }),
          L.createElement(L.Suspense, { fallback: "inner" }, L.createElement(Wait, { id: "two", ms: 8 })),
          L.createElement(Wait, { id: "three", ms: 4 }, L.createElement(Wait, { id: "four", ms: 6 })),
        ),
        L.createElement(
          "table",
          null,
          L.createElement(
            "tbody",
            null,
            L.createElement(
              L.Suspense,
              { fallback: null },
              L.createElement("tr", null, L.createElement("td", null, L.createElement(Wait, { id: "td", ms: 3 }))),
            ),
          ),
        ),
        L.createElement(
          "svg",
          null,
          L.createElement(
            L.Suspense,
            { fallback: null },
            L.createElement("g", null, L.createElement(Wait, { id: "g", ms: 3 })),
          ),
        ),
        L.createElement(
          "math",
          null,
          L.createElement(L.Suspense, { fallback: null }, L.createElement(Wait, { id: "m", ms: 3 })),
        ),
        L.createElement(
          "table",
          null,
          L.createElement(
            L.Suspense,
            { fallback: null },
            L.createElement("tbody", null, L.createElement(Wait, { id: "tb", ms: 3 })),
          ),
        ),
        L.createElement(
          "table",
          null,
          L.createElement(
            "tbody",
            null,
            L.createElement(
              "tr",
              null,
              L.createElement(
                L.Suspense,
                { fallback: null },
                L.createElement("td", null, L.createElement(Wait, { id: "tr", ms: 3 })),
              ),
            ),
          ),
        ),
        L.createElement(
          "table",
          null,
          L.createElement(
            "colgroup",
            null,
            L.createElement(L.Suspense, { fallback: null }, L.createElement(Wait, { id: "col", ms: 3 })),
          ),
        ),
      );
    };
    // Read as it streams: the shell flushes before the promises resolve.
    const read = async (server: Any, L: Lib, options?: Options): Promise<string> =>
      text(await server.renderToReadableStream(make(L), options));
    const expected = await read(ReactServer, React);
    expect(expected).toContain("$RC");
    expect(expected).toContain("$RS");
    expect(await read(Server, Compat)).toBe(expected);
    expect(await read(Server, Compat, { identifierPrefix: "x", nonce: "n" })).toBe(
      await read(ReactServer, React, { identifierPrefix: "x", nonce: "n" }),
    );
    expect(await pipeAll(Server, make(Compat))).toBe(await pipeAll(ReactNodeServer, make(React)));
    await sameStream(make);
  });

  test("streaming: a boundary that errors after the shell is rendered on the client", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Fail = (): Any => L.use((p ??= new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 3))));
      return L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: "f1" }, L.createElement(Fail)),
        L.createElement(L.Suspense, { fallback: "f2" }, L.createElement(Fail)),
      );
    };
    const read = async (server: Any, L: Lib, options?: Options): Promise<string> =>
      text(await server.renderToReadableStream(make(L), options));
    expect(await read(Server, Compat, quiet)).toBe(await read(ReactServer, React, quiet));
    const digest = { onError: () => "d<ig>\u2028" };
    expect(await read(Server, Compat, digest)).toBe(await read(ReactServer, React, digest));
  });

  test("streaming: large boundaries are outlined after the shell", async () => {
    const make: Make = (L) =>
      L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: "small" }, "x".repeat(400)),
        L.createElement(L.Suspense, { fallback: "big" }, "y".repeat(600)),
        L.createElement(
          L.Suspense,
          { fallback: "big2" },
          L.createElement("p", null, "\u00E9\u4E2D\u{1F600}".repeat(150)),
        ),
      );
    await same(make);
    await same(make, { progressiveChunkSize: 100 });
    await sameStream(make, { progressiveChunkSize: 100000 });
  });

  test("streaming: stylesheets a boundary needs are preloaded and inserted before it shows", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Wait = ({ children }: Any): Any => (L.use((p ??= later("x", 3))), children);
      return L.createElement(
        "html",
        null,
        L.createElement("head"),
        L.createElement(
          "body",
          null,
          L.createElement("link", { rel: "stylesheet", href: "/shell.css", precedence: "default" }),
          L.createElement(
            L.Suspense,
            { fallback: "loading" },
            L.createElement(
              Wait,
              null,
              L.createElement("link", {
                rel: "stylesheet",
                href: "/late.css?a=1&b=<>\u2028\u2029",
                precedence: "default",
                src: "/s",
                innerHTML: "x",
                suppressContentEditableWarning: true,
                suppressHydrationWarning: true,
                ref: () => {},
                crossOrigin: "anonymous",
                media: "print",
                "data-x": "y",
                className: "c",
                hidden: true,
                onLoad: undefined,
                style: { color: "red" },
                fn: () => {},
                "bad name": "z",
                integrity: "sha",
              }),
              L.createElement("link", { rel: "stylesheet", href: "/shell.css", precedence: "default" }),
              L.createElement("link", { rel: "stylesheet", href: "/hidden.css", precedence: "x", hidden: false }),
              L.createElement("style", { href: "late-style", precedence: "default" }, ".a{}"),
              L.createElement("style", { href: "late-style2", precedence: "other" }, ".b{}"),
              L.createElement("p", null, "content"),
              L.createElement("img", { src: "/late.png" }),
              L.createElement("meta", { name: "late" }),
            ),
          ),
          L.createElement(
            L.Suspense,
            { fallback: "loading 2" },
            L.createElement(
              Wait,
              null,
              L.createElement("link", {
                rel: "stylesheet",
                href: "/late.css?a=1&b=<>\u2028\u2029",
                precedence: "default",
              }),
              "again",
            ),
          ),
        ),
      );
    };
    const read = async (server: Any, L: Lib): Promise<string> => text(await server.renderToReadableStream(make(L)));
    const expected = await read(ReactServer, React);
    expect(expected).toContain("$RR");
    expect(await read(Server, Compat)).toBe(expected);
    await sameStream(make);
  });

  test("a stylesheet in a completed boundary keeps it out of the shell's inline content", async () => {
    await same((L) =>
      L.createElement(
        "div",
        null,
        L.createElement(
          L.Suspense,
          { fallback: "f" },
          L.createElement("link", { rel: "stylesheet", href: "/x.css", precedence: "p" }),
          "after",
        ),
        L.createElement(
          L.Suspense,
          { fallback: "f" },
          "t",
          L.createElement("link", { rel: "stylesheet", href: "/x.css", precedence: "p" }),
          "u",
        ),
        L.createElement("span", null, "t", L.createElement("script", { async: true, src: "/q.js" }), "u"),
        L.createElement("span", null, "t", L.createElement("style", { href: "h", precedence: "p" }, "x"), "u"),
        L.createElement("span", null, "t", L.createElement("meta", { name: "n" }), "u"),
        L.createElement("span", null, "t", L.createElement("link", { rel: "icon", href: "/i" }), "u"),
      ),
    );
  });

  test("fallbacks drop hoistable titles and metas", async () => {
    const make: Make = (L) => {
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement(
        L.Suspense,
        {
          fallback: L.createElement(
            "div",
            null,
            L.createElement("title", null, "fallback title"),
            L.createElement("meta", { name: "m" }),
            L.createElement("link", { rel: "icon", href: "/f" }),
            "fb",
          ),
        },
        L.createElement(Never),
      );
    };
    expect(Server.renderToString(make(Compat))).toBe(ReactServer.renderToString(make(React)));
  });

  test("a document whose body is inside a boundary", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Wait = ({ children }: Any): Any => (L.use((p ??= later("x", 2))), children);
      return L.createElement(
        "html",
        null,
        L.createElement(
          L.Suspense,
          { fallback: L.createElement("body", null, "loading body") },
          L.createElement("head", null, L.createElement("title", null, "t")),
          L.createElement(Wait, null, L.createElement("body", null, "body")),
        ),
      );
    };
    await sameStream(make);
    const fails: Make = (L) => {
      const Boom = (): never => {
        throw new Error("x");
      };
      return L.createElement(
        "html",
        null,
        L.createElement(
          L.Suspense,
          { fallback: L.createElement("body", null, "fallback body") },
          L.createElement(Boom),
        ),
      );
    };
    await sameStream(fails, quiet);
    const done: Make = (L) =>
      L.createElement(
        "html",
        null,
        L.createElement(L.Suspense, { fallback: "x" }, L.createElement("head"), L.createElement("body", null, "b")),
      );
    await same(done);
  });

  test("a shell with suspended children and no boundary waits for them", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Wait = (): Any => L.use((p ??= later("late shell", 2)));
      return L.createElement(
        "div",
        null,
        "a",
        L.createElement(Wait),
        L.createElement("b", null, L.createElement(Wait)),
      );
    };
    await sameStream(make);
    expect(await pipeAll(Server, make(Compat))).toBe(await pipeAll(ReactNodeServer, make(React)));
  });
});

describe("SuspenseList and ViewTransition", () => {
  const SuspenseList = Symbol.for("react.suspense_list");

  test("SuspenseList rows in each reveal order", async () => {
    for (const revealOrder of [
      undefined,
      "forwards",
      "backwards",
      "unstable_legacy-backwards",
      "together",
      "independent",
    ]) {
      const make: Make = (L) => {
        const cache = new Map<string, Any>();
        const Wait = ({ id, ms }: Any): Any => {
          let p = cache.get(id);
          if (!p) cache.set(id, (p = later(id, ms)));
          return L.createElement("i", null, L.use(p));
        };
        return L.createElement(
          "div",
          null,
          L.createElement(
            SuspenseList,
            { revealOrder, tail: "visible" },
            L.createElement(L.Suspense, { fallback: "f1" }, L.createElement(Wait, { id: "a", ms: 4 })),
            L.createElement(L.Suspense, { fallback: "f2" }, L.createElement(Wait, { id: "b", ms: 1 })),
            "text row",
            L.createElement(L.Suspense, { fallback: "f3" }, "sync"),
          ),
        );
      };
      const read = async (server: Any, L: Lib): Promise<string> => text(await server.renderToReadableStream(make(L)));
      expect(await read(Server, Compat)).toBe(await read(ReactServer, React));
      await sameStream(make);
      expect(Server.renderToString(make(Compat))).toBe(ReactServer.renderToString(make(React)));
    }
  });

  test("SuspenseList of iterables, single children and nested lists", async () => {
    await same((L) =>
      L.createElement(
        SuspenseList,
        { revealOrder: "forwards" },
        L.createElement(SuspenseList, { revealOrder: "together" }, L.createElement(L.Suspense, null, "x")),
      ),
    );
    await same((L) =>
      L.createElement(
        SuspenseList,
        { revealOrder: "forwards" },
        new Set([L.createElement(L.Suspense, { key: 1 }, "a"), L.createElement(L.Suspense, { key: 2 }, "b")]),
      ),
    );
    await same((L) => L.createElement(SuspenseList, { revealOrder: "forwards" }, new Set()));
    await same((L) =>
      L.createElement(
        SuspenseList,
        { revealOrder: "forwards" },
        {
          [Symbol.iterator]: () => null,
          $$typeof: Symbol.for("react.context"),
          _currentValue: "c",
          _currentValue2: "c",
        },
      ),
    );
    await same((L) =>
      L.createElement(
        SuspenseList,
        { revealOrder: "backwards" },
        L.createElement(
          SuspenseList,
          { revealOrder: "together" },
          L.createElement(L.Suspense, null, "x"),
          L.createElement(L.Suspense, null, "y"),
        ),
        "z",
      ),
    );
  });

  test("SuspenseList rows with errors and nested together lists while streaming", async () => {
    const make: Make = (L) => {
      const cache = new Map<string, Any>();
      const Wait = ({ id, ms, fail }: Any): Any => {
        let p = cache.get(id);
        if (!p)
          cache.set(id, (p = new Promise((res, rej) => setTimeout(() => (fail ? rej(new Error(id)) : res(id)), ms))));
        return L.createElement("i", null, L.use(p));
      };
      return L.createElement(
        SuspenseList,
        { revealOrder: "forwards" },
        L.createElement(L.Suspense, { fallback: "f1" }, L.createElement(Wait, { id: "a", ms: 3, fail: true })),
        L.createElement(
          SuspenseList,
          { revealOrder: "together" },
          L.createElement(L.Suspense, { fallback: "t1" }, L.createElement(Wait, { id: "b", ms: 1 })),
          L.createElement(L.Suspense, { fallback: "t2" }, L.createElement(Wait, { id: "c", ms: 5 })),
        ),
        L.createElement(L.Suspense, { fallback: "f3" }, L.createElement(Wait, { id: "d", ms: 2 })),
      );
    };
    const read = async (server: Any, L: Lib): Promise<string> =>
      text(await server.renderToReadableStream(make(L), quiet));
    expect(await read(Server, Compat)).toBe(await read(ReactServer, React));
    await sameStream(make, quiet);
  });

  test("ViewTransition: names and classes on the elements under it, in streams", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Wait = ({ children }: Any): Any => (L.use((p ??= later("x", 2))), children);
      return L.createElement(
        "div",
        null,
        L.createElement(L.ViewTransition, null, L.createElement("p", null, "auto")),
        L.createElement(
          L.ViewTransition,
          { name: "hero", default: "slide", enter: { default: "in" }, exit: "auto", share: "morph", update: "none" },
          L.createElement("img", { src: "/h.png" }),
          L.createElement("p", null, "two"),
          L.createElement("input"),
          L.createElement("br"),
        ),
        L.createElement(
          L.ViewTransition,
          { name: "outer" },
          L.createElement(L.ViewTransition, { update: "u" }, L.createElement("span", null, "inner")),
        ),
        L.createElement(
          L.Suspense,
          { fallback: L.createElement(L.ViewTransition, { name: "fb" }, L.createElement("i", null, "loading")) },
          L.createElement(
            L.ViewTransition,
            { name: "content", enter: "e" },
            L.createElement(Wait, null, L.createElement("b", null, "late")),
          ),
        ),
        L.createElement(
          L.ViewTransition,
          { update: "x" },
          L.createElement(
            L.Suspense,
            { fallback: L.createElement("i", null, "f") },
            L.createElement(Wait, null, L.createElement("u", null, "u")),
          ),
        ),
        L.createElement(L.ViewTransition, { name: "auto" }, L.createElement("q", null, "q")),
        L.createElement(
          L.ViewTransition,
          { default: { default: "d" }, update: "auto", enter: "auto", exit: "auto" },
          L.createElement("select", { value: "a" }, L.createElement("option", { value: "a" }, "a")),
          L.createElement("textarea", { defaultValue: "t" }),
          L.createElement("button", null, "b"),
          L.createElement("form", null, "f"),
          L.createElement("object", null, "o"),
          L.createElement("a", null, "a"),
          L.createElement("menuitem"),
          L.createElement("pre", null, "p"),
          L.createElement("my-el", null, "c"),
          L.createElement("meta", { itemProp: "m" }),
        ),
      );
    };
    await same(make);
    const read = async (server: Any, L: Lib): Promise<string> => text(await server.renderToReadableStream(make(L)));
    expect(await read(Server, Compat)).toBe(await read(ReactServer, React));
    await same((L) =>
      L.createElement("html", null, L.createElement(L.ViewTransition, null, L.createElement("body", null, "b"))),
    );
  });
});

describe("aborting", () => {
  test("an abort signal leaves pending boundaries to the client", async () => {
    const make: Make = (L) => {
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement(
        "div",
        null,
        "shell",
        L.createElement(L.Suspense, { fallback: "f1" }, L.createElement(Never)),
        L.createElement(L.Suspense, { fallback: "f2" }, L.createElement("p", null, L.createElement(Never))),
      );
    };
    const read = async (server: Any, L: Lib, reason?: unknown): Promise<string> => {
      const controller = new AbortController();
      const errors: string[] = [];
      const stream = await server.renderToReadableStream(make(L), {
        signal: controller.signal,
        onError: (e: Any) => void errors.push(full(e?.message ?? String(e))),
      });
      setTimeout(() => controller.abort(reason), 3);
      const out = await text(stream);
      return out + "\n" + errors.join("|");
    };
    expect(await read(Server, Compat)).toBe(await read(ReactServer, React));
    expect(await read(Server, Compat, "why")).toBe(await read(ReactServer, React, "why"));
    expect(await read(Server, Compat, Promise.resolve())).toBe(await read(ReactServer, React, Promise.resolve()));
  });

  test("a signal aborted before the render fails the shell", async () => {
    const reject = async (server: Any, L: Lib): Promise<string> => {
      const Never = (): Any => L.use(new Promise(() => {}));
      try {
        await server.renderToReadableStream(L.createElement(Never), { signal: AbortSignal.abort("early"), ...quiet });
      } catch (e) {
        return String(e);
      }
      return "(resolved)";
    };
    expect(await reject(Server, Compat)).toBe(await reject(ReactServer, React));
  });

  test("cancelling the stream aborts the render", async () => {
    const run = async (server: Any, L: Lib): Promise<string[]> => {
      const Never = (): Any => L.use(new Promise(() => {}));
      const errors: string[] = [];
      const stream = await server.renderToReadableStream(
        L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Never))),
        { onError: (e: Any) => void errors.push(String(e)) },
      );
      const reader = stream.getReader();
      await reader.read();
      await reader.cancel("stop");
      await later(null, 2);
      return errors;
    };
    expect(await run(Server, Compat)).toEqual(await run(ReactServer, React));
  });

  test("renderToPipeableStream: abort, its callbacks and piping twice", async () => {
    const make: Make = (L) => {
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Never)));
    };
    const run = (server: Any, L: Lib): Promise<string> =>
      new Promise((resolve) => {
        const chunks: Uint8Array[] = [];
        const events: string[] = [];
        const writable = {
          write: (c: Uint8Array) => (chunks.push(c), true),
          end: () => resolve(Buffer.concat(chunks).toString() + "\n" + events.join(",")),
          on: (event: string) => (events.push("on:" + event), writable),
          flush: () => events.push("flush"),
        };
        const s = server.renderToPipeableStream(make(L), {
          onShellReady() {
            events.push("shell");
            s.pipe(writable);
            events.push(thrown(() => s.pipe(writable)));
            setTimeout(() => s.abort(), 2);
          },
          onAllReady: () => events.push("all"),
          onError: (e: Any) => void events.push("error:" + full(e.message)),
        });
      });
    expect(await run(Server, Compat)).toBe(await run(ReactNodeServer, React));
  });

  test("renderToPipeableStream: the shell's error, and the destination's events", async () => {
    const shellError = (server: Any, L: Lib): Promise<string> =>
      new Promise((resolve) => {
        const Boom = (): never => {
          throw new Error("shell boom");
        };
        server.renderToPipeableStream(L.createElement(Boom), {
          onShellError: (e: Any) => resolve("shell error: " + e.message),
          onError: () => {},
        });
      });
    expect(await shellError(Server, Compat)).toBe(await shellError(ReactNodeServer, React));

    // A writable that closes early aborts the render; its error does too; a drain flushes again.
    for (const event of ["close", "error", "drain"]) {
      const run = (server: Any, L: Lib): Promise<string> =>
        new Promise((resolve) => {
          const Never = (): Any => L.use(new Promise(() => {}));
          const listeners = new Map<string, () => void>();
          const events: string[] = [];
          const chunks: Uint8Array[] = [];
          const writable = {
            write: (c: Uint8Array) => (chunks.push(c), true),
            end: () => events.push("end"),
            destroy: () => events.push("destroy"),
            on: (name: string, fn: () => void) => (listeners.set(name, fn), writable),
          };
          const s = server.renderToPipeableStream(
            L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Never))),
            {
              onShellReady() {
                s.pipe(writable);
                listeners.get(event)!();
                if (event === "drain") setTimeout(() => s.abort("done"), 2);
                setTimeout(() => resolve(Buffer.concat(chunks).toString() + "|" + events.join(",")), 10);
              },
              onError: (e: Any) => void events.push(full(e?.message ?? String(e))),
            },
          );
        });
      expect(await run(Server, Compat)).toBe(await run(ReactNodeServer, React));
    }
  });

  test("renderToPipeableStream: a fatal error after piping destroys the destination", async () => {
    const run = (server: Any, L: Lib): Promise<string> =>
      new Promise((resolve) => {
        let p: Any;
        const Late = (): Any => {
          L.use((p ??= later("x", 2)));
          throw new Error("late shell error");
        };
        const writable = {
          write: () => true,
          end: () => resolve("ended"),
          destroy: (e: Any) => resolve("destroyed: " + e.message),
          on: () => writable,
        };
        const s = server.renderToPipeableStream(L.createElement("div", null, L.createElement(Late)), {
          onError: () => {},
          onShellError: () => {},
        });
        s.pipe(writable);
      });
    expect(await run(Server, Compat)).toBe(await run(ReactNodeServer, React));
  });

  test("a writable without destroy is ended on a fatal error", async () => {
    const result = await new Promise<string>((resolve) => {
      let p: Any;
      const Late = (): Any => {
        Compat.use((p ??= later("x", 2)));
        throw new Error("late");
      };
      const writable = { write: () => true, end: () => resolve("ended"), on: () => writable };
      Server.renderToPipeableStream(Compat.createElement(Late), { onError: () => {} }).pipe(writable);
    });
    expect(result).toBe("ended");
  });
});

describe("browser()", () => {
  test("inside a boundary, its fallback renders and the client renders the content", async () => {
    const bailouts: unknown[] = [];
    const errors: unknown[] = [];
    const make = (reason?: unknown): Any => {
      const Client = (): Any => Compat.use((Compat as Any).browser(reason));
      return Compat.createElement(
        "div",
        null,
        Compat.createElement(Compat.Suspense, { fallback: "fb" }, Compat.createElement(Client)),
      );
    };
    const options = {
      onBrowserBailout: (e: unknown) => void bailouts.push(e),
      onError: (e: unknown) => void errors.push(e),
    };
    // The HTML React writes for a boundary whose content errors, with no digest.
    const boundaryHTML = ReactServer.renderToString(
      React.createElement(
        "div",
        null,
        React.createElement(
          React.Suspense,
          { fallback: "fb" },
          React.createElement(() => {
            throw new Error("x");
          }),
        ),
      ),
      { onError: () => {} },
    );
    // A bailout's digest is empty, so the template has an empty data-dgst (React's own handling).
    expect(Server.renderToString(make(), options as Any)).toBe(
      boundaryHTML.replace("<template>", '<template data-dgst="">'),
    );
    const boundaryStream = await streamAll(
      ReactServer,
      React.createElement(
        "div",
        null,
        React.createElement(
          React.Suspense,
          { fallback: "fb" },
          React.createElement(() => {
            throw new Error("x");
          }),
        ),
      ),
      { onError: () => {} },
    );
    expect(await streamAll(Server, make("because"), options)).toBe(
      boundaryStream.replace("<template>", '<template data-dgst="">'),
    );
    // renderToString takes no callbacks, as React's; the stream reports the bailout.
    expect(errors).toEqual([]);
    expect(bailouts.length).toBe(1);
    expect((bailouts[0] as Error).message).toBe("Browser-only rendering was requested by `browser()`.");
    expect((bailouts[0] as Error).cause).toBe("because");
    // The reason can be a function, called once; one that throws gives a fixed reason.
    bailouts.length = 0;
    await streamAll(
      Server,
      make(() => "lazy reason"),
      options,
    );
    await streamAll(
      Server,
      make(() => {
        throw new Error("no");
      }),
      options,
    );
    expect((bailouts[0] as Error).cause).toBe("lazy reason");
    expect((bailouts[1] as Error).cause).toBe(
      "The reason for browser-only rendering could not be determined because its initializer threw.",
    );
    // Without onBrowserBailout nothing is logged.
    Server.renderToString(make());
  });

  test("outside any boundary, the render fails with an error that names the cause", async () => {
    const Client = (): Any => Compat.use((Compat as Any).browser("why"));
    const err = (() => {
      try {
        Server.renderToString(Compat.createElement(Client));
      } catch (e) {
        return e as Error;
      }
    })()!;
    expect(err.message).toBe(
      "The server render could not complete because client rendering was requested outside a Suspense boundary. See this error's cause for additional details.",
    );
    expect(err.cause).toBe("why");
    expect(err.stack).toContain("The server render could not complete");
    const noCause = (() => {
      try {
        Server.renderToString(Compat.createElement(() => Compat.use((Compat as Any).browser())));
      } catch (e) {
        return e as Error;
      }
    })()!;
    expect("cause" in noCause).toBe(false);
    await expect(Server.renderToReadableStream(Compat.createElement(Client), { onError: () => {} })).rejects.toThrow(
      "client rendering was requested outside a Suspense boundary",
    );
  });

  test("aborting with a browser() token renders pending boundaries on the client", async () => {
    const Never = (): Any => Compat.use(new Promise(() => {}));
    const controller = new AbortController();
    const bailouts: unknown[] = [];
    const stream = await Server.renderToReadableStream(
      Compat.createElement(
        "div",
        null,
        Compat.createElement(Compat.Suspense, { fallback: "f" }, Compat.createElement(Never)),
      ),
      { signal: controller.signal, onBrowserBailout: (e) => void bailouts.push(e) },
    );
    controller.abort((Compat as Any).browser("aborted"));
    const out = await text(stream);
    expect(out).toContain('$RX("B:0","")');
    expect((bailouts[0] as Error).cause).toBe("aborted");
  });

  test("an error without a stack still clones", () => {
    const Client = (): Any => {
      const token = (Compat as Any).browser();
      try {
        Compat.use(token);
      } catch (e) {
        (e as Any).stack = undefined;
        throw e;
      }
      return null;
    };
    expect(() => Server.renderToString(Compat.createElement(Client))).toThrow(
      "client rendering was requested outside a Suspense boundary",
    );
    const OneLine = (): Any => {
      try {
        Compat.use((Compat as Any).browser());
      } catch (e) {
        (e as Error).stack = "Error: one line";
        throw e;
      }
      return null;
    };
    expect(() => Server.renderToString(Compat.createElement(OneLine))).toThrow("outside a Suspense boundary");
  });
});

describe("stack overflows", () => {
  // React renders the rest of a tree that overflowed the stack in a new task, from a fresh stack.
  // A component that throws the overflow error once stands in for a deep tree (V8's message).
  const overflowOnce = (L: Lib, out: Any): Any => {
    let calls = 0;
    return (): Any => {
      if (calls++ === 0) throw new RangeError("Maximum call stack size exceeded");
      return out(L);
    };
  };

  test("under an element: a task of its own", async () => {
    const make: Make = (L) => {
      const Overflow = overflowOnce(L, () => "ok");
      return L.createElement("div", null, "a", L.createElement(Overflow), "b");
    };
    await same(make);
  });

  test("in a task's own node: the task again, from where it overflowed", async () => {
    const make: Make = (L) => {
      const Overflow = overflowOnce(L, (L: Lib) => L.createElement("p", null, "ok"));
      const Root = (): Any => L.createElement(Overflow);
      return L.createElement(Root);
    };
    await same(make);
  });
});

describe("fatal errors", () => {
  test("an error while flushing fails the stream", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Wait = ({ children }: Any): Any => (L.use((p ??= later("x", 2))), children);
      return L.createElement(
        "div",
        null,
        L.createElement(
          L.Suspense,
          { fallback: "f" },
          L.createElement(
            Wait,
            null,
            L.createElement("link", { rel: "stylesheet", href: "/s.css", precedence: "p", children: "x" }),
          ),
        ),
      );
    };
    const run = async (server: Any, L: Lib): Promise<string> => {
      const errors: string[] = [];
      try {
        const s = await server.renderToReadableStream(make(L), {
          onError: (e: Any) => void errors.push(full(e.message)),
        });
        return (await text(s)) + "|" + errors.join(",");
      } catch (e) {
        return "rejected: " + full((e as Error).message) + "|" + errors.join(",");
      }
    };
    expect(await run(Server, Compat)).toBe(await run(ReactServer, React));
  });

  test("a fatal error after the shell errors the stream", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Late = (): Any => {
        L.use((p ??= later("x", 2)));
        throw new Error("late");
      };
      return L.createElement("div", null, L.createElement(Late));
    };
    const run = async (server: Any, L: Lib): Promise<string> => {
      try {
        const s = await server.renderToReadableStream(make(L), quiet);
        return await text(s);
      } catch (e) {
        return "rejected: " + (e as Error).message;
      }
    };
    expect(await run(Server, Compat)).toBe(await run(ReactServer, React));
  });

  test("a stream read after a fatal error errors", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Late = (): Any => {
        L.use((p ??= later("x", 2)));
        throw new Error("late");
      };
      return L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: "f" }, "ok"),
        L.createElement("p", null, L.createElement(Late)),
      );
    };
    const run = async (server: Any, L: Lib): Promise<string> => {
      const s = await new Promise<Any>((resolve, reject) => {
        const req = server.renderToPipeableStream(make(L), {
          onError: () => {},
          onShellError: reject,
          onShellReady: () => resolve(req),
        });
        void req;
      }).catch((e) => e);
      return (s as Error).message;
    };
    expect(await run(Server, Compat)).toBe(await run(ReactNodeServer, React));
  });
});

describe("more of React's paths", () => {
  test("elements: children of a, button and form; option and custom element props; thead; nested html", async () => {
    await same((L) =>
      L.createElement(
        "div",
        null,
        L.createElement("a", { href: "/x" }, L.createElement("b", null, "x")),
        L.createElement(
          "button",
          { className: "c", formEncType: "e", formTarget: "t" },
          L.createElement("b", null, "b"),
        ),
        L.createElement("button", { dangerouslySetInnerHTML: { __html: "<i>b</i>" } }),
        L.createElement("form", { id: "f", noValidate: true }, L.createElement("b", null, "f")),
        L.createElement("select", null, L.createElement("option", { value: "a", className: "c", label: "l" }, "A")),
        L.createElement("my-el", { suppressContentEditableWarning: true }, "c"),
        L.createElement(
          "table",
          null,
          L.createElement("thead", null, L.createElement("tr", null, L.createElement("th", null, "h"))),
        ),
        L.createElement("html", null, "nested html"),
      ),
    );
  });

  test("an import map without a nonce, and a root namespace of svg or MathML", async () => {
    await same((L) => L.createElement("html", null, L.createElement("body", null, "b")), {
      importMap: { imports: {} },
    });
    await sameStream((L) => L.createElement("g", null, L.createElement("title", null, "t")), {
      namespaceURI: "http://www.w3.org/2000/svg",
    });
    await sameStream((L) => L.createElement("mi", null, "x"), { namespaceURI: "http://www.w3.org/1998/Math/MathML" });
  });

  test("a view transition whose default class is auto", async () => {
    await same((L) =>
      L.createElement(L.ViewTransition, { default: "auto", update: "auto" }, L.createElement("p", null, "x")),
    );
  });

  test("a thenable as a child: fulfilled, rejected, settling at once, or pending", async () => {
    const make: Make = (L) => {
      const fulfilled = { status: "fulfilled", value: "done", then() {} };
      const sync = { then: (ok: Any) => ok("sync") };
      const tracked: Any = {
        status: "custom",
        then: (ok: Any) => setTimeout(() => ((tracked.status = "fulfilled"), (tracked.value = "x"), ok()), 1),
      };
      let pending: Any;
      const Pending = (): Any => (pending ??= later("later", 2));
      return L.createElement(
        "div",
        null,
        fulfilled,
        sync,
        L.createElement(L.Suspense, { fallback: "t" }, tracked),
        L.createElement(L.Suspense, { fallback: "p" }, L.createElement("i", null, L.createElement(Pending))),
      );
    };
    await sameStream(make);
    const rejected: Make = (L) =>
      L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: "r" }, { status: "rejected", reason: new Error("no"), then() {} }),
        L.createElement(L.Suspense, { fallback: "s" }, { then: (_: Any, fail: Any) => fail(new Error("sync no")) }),
      );
    await same(rejected, quiet);
  });

  test("aborting from inside a render", async () => {
    // Inside a boundary's content, and in a task retried after a promise settles.
    const make = (L: Lib, controller: AbortController): Any => {
      let p: Any;
      const AbortNow = (): Any => (controller.abort("now"), "x");
      const AbortLater = (): Any => (L.use((p ??= later("y", 2))), controller.abort("later"), "y");
      return L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: "f1" }, L.createElement(AbortNow)),
        L.createElement(L.Suspense, { fallback: "f2" }, L.createElement(AbortLater)),
      );
    };
    for (const later of [false, true]) {
      const run = async (server: Any, L: Lib): Promise<string> => {
        const controller = new AbortController();
        const errors: string[] = [];
        const tree = later
          ? L.createElement(
              "div",
              null,
              L.createElement(L.Suspense, { fallback: "f" }, make(L, controller).props.children[1]),
            )
          : make(L, controller);
        try {
          const stream = await server.renderToReadableStream(tree, {
            signal: controller.signal,
            onError: (e: Any) => void errors.push(full(String(e?.message ?? e))),
          });
          return (await text(stream)) + "|" + errors.join(",");
        } catch (e) {
          return "rejected: " + String(e) + "|" + errors.join(",");
        }
      };
      expect(await run(Server, Compat)).toBe(await run(ReactServer, React));
    }
  });

  test("SuspenseList: a backwards row that throws, and nested lists with pending rows", async () => {
    const SuspenseList = Symbol.for("react.suspense_list");
    await same((L) => {
      const Boom = (): never => {
        throw new Error("row");
      };
      return L.createElement(
        L.Suspense,
        { fallback: "list failed" },
        L.createElement(SuspenseList, { revealOrder: "backwards" }, [
          L.createElement("b", { key: 1 }, "a"),
          L.createElement(Boom, { key: 2 }),
        ]),
      );
    }, quiet);
    const nested: Make = (L) => {
      const cache = new Map<string, Any>();
      const Wait = ({ id, ms }: Any): Any => {
        let p = cache.get(id);
        if (!p) cache.set(id, (p = later(id, ms)));
        return L.createElement("i", null, L.use(p));
      };
      return L.createElement(
        SuspenseList,
        { revealOrder: "forwards" },
        L.createElement(
          SuspenseList,
          { revealOrder: "forwards" },
          L.createElement(L.Suspense, { fallback: "a" }, L.createElement(Wait, { id: "a", ms: 3 })),
          L.createElement(L.Suspense, { fallback: "b" }, L.createElement(Wait, { id: "b", ms: 1 })),
        ),
        L.createElement(L.Suspense, { fallback: "c" }, L.createElement(Wait, { id: "c", ms: 2 })),
      );
    };
    const read = async (server: Any, L: Lib): Promise<string> => text(await server.renderToReadableStream(nested(L)));
    expect(await read(Server, Compat)).toBe(await read(ReactServer, React));
    // A one-row backwards list as a boundary's whole content: the row's segment stands in for it.
    await same((L) =>
      L.createElement(
        L.Suspense,
        { fallback: "f" },
        L.createElement(SuspenseList, { revealOrder: "backwards" }, [L.createElement("b", { key: 1 }, "row")]),
      ),
    );
  });

  test("SuspenseList rows of large boundaries, outlined", async () => {
    const SuspenseList = Symbol.for("react.suspense_list");
    const make: Make = (L) => {
      let p: Any;
      const Wait = ({ children }: Any): Any => (L.use((p ??= later("x", 2))), children);
      // In a div: a boundary at the document's top is never outlined (it may hold the preamble).
      return L.createElement(
        "div",
        null,
        L.createElement(
          SuspenseList,
          { revealOrder: "forwards" },
          L.createElement(L.Suspense, { fallback: "a" }, "x".repeat(600)),
          L.createElement(L.Suspense, { fallback: "b" }, L.createElement(Wait, null, "y".repeat(600))),
          L.createElement(L.Suspense, { fallback: "c" }, "z".repeat(100)),
        ),
      );
    };
    // allReady waits for the outlined rows to flush, as React's does: read the stream instead.
    expect(Server.renderToString(make(Compat))).toBe(ReactServer.renderToString(make(React)));
    const read = async (server: Any, L: Lib): Promise<string> => text(await server.renderToReadableStream(make(L)));
    expect(await read(Server, Compat)).toBe(await read(ReactServer, React));
  });

  test("a fallback that suspends is dropped once its content completes", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Never = (): Any => L.use(new Promise(() => {}));
      const Wait = (): Any => L.use((p ??= later("content", 2)));
      return L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: L.createElement(Never) }, L.createElement(Wait)),
      );
    };
    await sameStream(make);
  });

  test("aborting while a nested boundary's fallback waits too", async () => {
    const run = async (server: Any, L: Lib): Promise<string> => {
      const Never = (): Any => L.use(new Promise(() => {}));
      const controller = new AbortController();
      const errors: string[] = [];
      const tree = L.createElement(
        "div",
        null,
        L.createElement(
          L.Suspense,
          { fallback: "outer" },
          L.createElement(L.Suspense, { fallback: L.createElement(Never) }, L.createElement(Never)),
        ),
      );
      const stream = await server.renderToReadableStream(tree, {
        signal: controller.signal,
        onError: (e: Any) => void errors.push(String(e)),
      });
      setTimeout(() => controller.abort("stop"), 2);
      return (await text(stream)) + "|" + errors.join(",");
    };
    expect(await run(Server, Compat)).toBe(await run(ReactServer, React));
  });

  test("styles in a pending boundary's fallback go with the boundary around it", async () => {
    const make: Make = (L) => {
      const cache = new Map<string, Any>();
      const Wait = ({ id, ms, children }: Any): Any => {
        let p = cache.get(id);
        if (!p) cache.set(id, (p = later(id, ms)));
        return (L.use(p), children);
      };
      return L.createElement(
        "div",
        null,
        L.createElement(
          L.Suspense,
          { fallback: "outer" },
          L.createElement(
            Wait,
            { id: "outer", ms: 2 },
            L.createElement(
              L.Suspense,
              {
                fallback: L.createElement(
                  "i",
                  null,
                  L.createElement("link", { rel: "stylesheet", href: "/fb.css", precedence: "p" }),
                  L.createElement("style", { href: "fb-style", precedence: "p" }, ".fb{}"),
                  "inner fallback",
                ),
              },
              L.createElement(Wait, { id: "inner", ms: 6 }, "inner"),
            ),
          ),
        ),
      );
    };
    const read = async (server: Any, L: Lib): Promise<string> => text(await server.renderToReadableStream(make(L)));
    expect(await read(Server, Compat)).toBe(await read(ReactServer, React));
  });

  test("an onError that throws while the render aborts fails it", async () => {
    const run = async (server: Any, L: Lib): Promise<string> => {
      const Never = (): Any => L.use(new Promise(() => {}));
      const controller = new AbortController();
      let calls = 0;
      try {
        const stream = await server.renderToReadableStream(
          L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Never))),
          {
            signal: controller.signal,
            onError: () => {
              if (calls++ === 0) throw new Error("onError threw");
            },
          },
        );
        stream.allReady.catch(() => {});
        setTimeout(() => controller.abort("stop"), 2);
        return await text(stream);
      } catch (e) {
        return "errored: " + (e as Error).message;
      }
    };
    expect(await run(Server, Compat)).toBe(await run(ReactServer, React));
  });

  test("an error while flushing the shell fails the stream", async () => {
    const make: Make = (L) =>
      L.createElement(
        "div",
        null,
        L.createElement("link", { rel: "stylesheet", href: "/s.css", precedence: "p", children: "x" }),
      );
    const run = async (server: Any, L: Lib): Promise<string> => {
      try {
        return await text(await server.renderToReadableStream(make(L), quiet));
      } catch (e) {
        return "errored: " + full((e as Error).message);
      }
    };
    expect(await run(Server, Compat)).toBe(await run(ReactServer, React));
  });

  test("a promise that settles before the render opens", async () => {
    const make: Make = (L) => {
      let p: Any;
      const Soon = (): Any => L.createElement("i", null, L.use((p ??= Promise.resolve("soon"))));
      return L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Soon)));
    };
    await sameStream(make);
  });

  test("without setImmediate, work is scheduled with setTimeout", async () => {
    const saved = globalThis.setImmediate;
    (globalThis as Any).setImmediate = undefined;
    try {
      expect(await streamAll(Server, Compat.createElement("p", null, "x"))).toBe("<p>x</p>");
    } finally {
      globalThis.setImmediate = saved;
    }
  });
});

describe("component stacks", () => {
  // React's production stacks read each component's frame from a native stack: a component is
  // called without props (a class is constructed) so it throws, and the frame it threw from is
  // its line. Both libraries call the same functions, so the frames are the same.
  const SuspenseList = Symbol.for("react.suspense_list");

  /** Each onError call: the message, the info's keys and its componentStack. */
  async function errorInfos(server: Any, el: Any, options?: Options): Promise<string[]> {
    const seen: string[] = [];
    const onError = (e: Any, info: Any): void =>
      void seen.push([full(String(e?.message ?? e)), Object.keys(info).join(), info.componentStack].join(" | "));
    try {
      const stream = await server.renderToReadableStream(el, { ...options, onError });
      await stream.allReady;
      await text(stream);
    } catch (e) {
      seen.push("rejected: " + full(String((e as Error)?.message ?? e)));
    }
    return seen;
  }
  const sameInfos = async (make: Make, options?: Options): Promise<string[]> => {
    const expected = await errorInfos(ReactServer, make(React), options);
    expect(await errorInfos(Server, make(Compat), options)).toEqual(expected);
    return expected;
  };

  test("onError's componentStack names each component, host element and boundary, innermost first", async () => {
    const make: Make = (L) => {
      const Boom = (): never => {
        throw new Error("boom");
      };
      function Mid(): Any {
        L.useState(1);
        return L.createElement("section", null, L.createElement(Boom));
      }
      class Implicit extends L.Component {
        render(): Any {
          return L.createElement(Mid);
        }
      }
      class Explicit extends L.Component {
        constructor(props: Any) {
          super(props);
          this.state = {};
        }
        render(): Any {
          return L.createElement(Implicit);
        }
      }
      const Memo = L.memo(function Inner() {
        return L.createElement(Explicit);
      });
      const Ref = L.forwardRef(function Fw(_: Any, __: Any) {
        return L.createElement(Memo);
      });
      const Lazy = L.lazy(() => ({ then: (r: Any) => r({ default: Ref }) }));
      const Ctx = L.createContext(0);
      // A function without a name: its frame is "<anonymous>", which its displayName replaces.
      const Anonymous = ((): Any =>
        function (p: Any) {
          return p.child;
        })();
      Anonymous.displayName = "Shown";
      return L.createElement(
        "div",
        null,
        L.createElement(
          L.Suspense,
          { fallback: "f" },
          L.createElement(
            SuspenseList,
            null,
            L.createElement(Ctx, { value: 1 }, L.createElement(Anonymous, { child: L.createElement(Lazy) })),
          ),
        ),
      );
    };
    const [info] = await sameInfos(make);
    expect(info).toContain("boom | componentStack | \n    at Boom (");
    expect(info).toContain("\n    at section (<anonymous>)\n    at Mid (");
    expect(info).toContain("\n    at Suspense (<anonymous>)\n    at div (<anonymous>)");
  });

  test("types without a frame of their own: memo of forwardRef, failed lazy, invalid objects, ViewTransition", async () => {
    await sameInfos((L) => {
      const Boom = (): never => {
        throw new Error("boom");
      };
      const MemoRef = L.memo(L.forwardRef((_: Any, __: Any) => L.createElement(Boom)));
      return L.createElement(
        L.Suspense,
        { fallback: "f" },
        L.createElement(Symbol.for("react.view_transition"), null, L.createElement(MemoRef)),
      );
    });
    await sameInfos((L) => {
      const Failed = L.lazy(() => ({ then: (_: Any, reject: Any) => reject(new Error("load failed")) }));
      return L.createElement(L.Suspense, { fallback: "f" }, L.createElement("p", null, L.createElement(Failed)));
    });
    await sameInfos((L) =>
      L.createElement(
        L.Suspense,
        { fallback: "f" },
        L.createElement({ name: "Info", env: "Server" } as Any),
        L.createElement(L.Suspense, null, L.createElement({ name: "Plain" } as Any)),
      ),
    );
  });

  test("the stack of a fallback, of content that suspended first, and of a fatal error", async () => {
    await sameInfos((L) => {
      const Boom = (): never => {
        throw new Error("in fallback");
      };
      const Never = (): Any => L.use(new Promise(() => {}));
      return L.createElement(
        L.Suspense,
        { fallback: L.createElement("p", null, L.createElement(Boom)) },
        L.createElement(Never),
      );
    });
    await sameInfos((L) => {
      let p: Any;
      const Late = (): never => {
        L.use((p ??= later("x")));
        throw new Error("after suspending");
      };
      return L.createElement(L.Suspense, { fallback: "f" }, L.createElement("b", null, L.createElement(Late)));
    });
    // Called without props, as the probe calls it, Gate's first hook is use() of a promise that is
    // not settled: React's server throws there (its #460), so the frame is that line.
    await sameInfos((L) => {
      const ready = Object.assign(Promise.resolve("v"), { status: "fulfilled", value: "v" });
      const Gate = (p: Any): never => {
        L.use(p.data ?? new Promise(() => {}));
        throw new Error("gated");
      };
      return L.createElement("i", null, L.createElement(Gate, { data: ready }));
    });
    await sameInfos((L) => {
      const Boom = (): never => {
        throw new Error("fatal");
      };
      return L.createElement("main", null, L.createElement(Boom));
    });
  });

  test("a root that is not an element gives no componentStack; aborted tasks give theirs", async () => {
    await sameInfos(() => [
      (() => {
        throw new Error("never rendered");
      }) as Any,
    ]);
    const make: Make = (L) => {
      // A hook first: called outside a render, React's use() throws and compat's reads the promise.
      function Never(): Any {
        L.useState(0);
        return L.use(new Promise(() => {}));
      }
      return L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: "f" }, L.createElement("i", null, L.createElement(Never))),
      );
    };
    const run = async (server: Any, L: Lib): Promise<string[]> => {
      const controller = new AbortController();
      setTimeout(() => controller.abort("stop"), 3);
      return errorInfos(server, make(L), { signal: controller.signal });
    };
    expect(await run(Server, Compat)).toEqual(await run(ReactServer, React));
  });

  test("short native stacks, and a stack that cannot be generated", async () => {
    const limit = Error.stackTraceLimit;
    // One frame: neither stack reaches the frame both start from, so each component is named.
    Error.stackTraceLimit = 1;
    try {
      await sameInfos((L) => {
        const Boom = (): never => {
          throw new Error("short");
        };
        function Mid(): Any {
          L.useState(0);
          return L.createElement(Boom);
        }
        return L.createElement(L.Suspense, null, L.createElement(Mid));
      });
    } finally {
      Error.stackTraceLimit = limit;
    }
    const first = (lines: string[]): string[] => lines.map((l) => l.split("\n").slice(0, 2).join("\n"));
    const make: Make = (L) => {
      const Odd = (): Any => null;
      Object.defineProperty(Odd, "prototype", {
        get() {
          throw new Error("no prototype");
        },
      });
      return L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Odd));
    };
    expect(first(await errorInfos(Server, make(Compat)))).toEqual(first(await errorInfos(ReactServer, make(React))));
  });

  test("renderToPipeableStream passes the same stacks", async () => {
    const make: Make = (L) => {
      function Boom(): never {
        L.useRef(null);
        throw new Error("piped");
      }
      return L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Boom)));
    };
    const run = (server: Any, L: Lib): Promise<string[]> =>
      new Promise((resolve) => {
        const seen: string[] = [];
        const writable = { write: () => true, end: () => resolve(seen), on: () => writable };
        server
          .renderToPipeableStream(make(L), {
            onError: (e: Any, info: Any) => void seen.push(e.message + info.componentStack),
          })
          .pipe(writable);
      });
    expect(await run(Server, Compat)).toEqual(await run(ReactNodeServer, React));
  });
});

describe("stream chunks and backpressure", () => {
  /** A chunk as the test sees it: its type and its text. */
  const show = (c: Any): string =>
    (typeof c === "string" ? "s:" : "b:") + (typeof c === "string" ? c : new TextDecoder().decode(c));

  // Long text, text that crosses views with multibyte characters, attributes, inner HTML, and
  // content that streams in later, with the scripts that put it in place. The later content
  // waits for `open()`, called once the shell is out, so both servers flush the same way.
  let open: () => void = () => {};
  // React's browser build enqueues its view transition script, a shared constant, as it is, and a
  // byte stream takes over (detaches) what it is given, so the readable test leaves it out.
  let transition = true;
  const make: Make = (L) => {
    const p = new Promise<void>((resolve) => (open = resolve));
    const Late = ({ n }: Any): Any => {
      L.use(p);
      return L.createElement("section", { title: "é".repeat(700 + n) }, "ü".repeat(1500), "x".repeat(4100));
    };
    return L.createElement(
      "div",
      null,
      "a".repeat(1300),
      "é".repeat(2000),
      L.createElement("p", { "data-long": "y".repeat(5000) }, "short"),
      L.createElement("div", { dangerouslySetInnerHTML: { __html: "<b>" + "z".repeat(9000) + "</b>" } }),
      Array.from({ length: 2000 }, (_, i) => L.createElement("i", { key: i }, i)),
      Array.from({ length: 12 }, (_, i) => L.createElement("u", { key: i }, "é".repeat(600 + i))),
      L.createElement(
        transition ? Symbol.for("react.view_transition") : L.Fragment,
        null,
        L.createElement(L.Suspense, { fallback: "f1" }, L.createElement(Late, { n: 1 })),
      ),
      L.createElement(L.Suspense, { fallback: "f2" }, L.createElement(Late, { n: 2 })),
      L.createElement(L.Suspense, { fallback: "f3" }, L.createElement("b", null, L.createElement(Late, { n: 3 }))),
    );
  };

  test("renderToPipeableStream writes React's Node build's chunks: 4096-byte views and long strings", async () => {
    const writes = (server: Any, L: Lib): Promise<string[]> =>
      new Promise((resolve) => {
        const seen: string[] = [];
        const writable = {
          write: (c: Any) => (seen.push(show(c)), true),
          end: () => resolve(seen),
          flush: () => void seen.push("flush"),
          on: () => writable,
        };
        const s = server.renderToPipeableStream(make(L), {
          onShellReady() {
            s.pipe(writable);
            open();
          },
        });
      });
    const expected = await writes(ReactNodeServer, React);
    expect(expected.length).toBeGreaterThan(10);
    expect(await writes(Server, Compat)).toEqual(expected);
  });

  test("renderToReadableStream enqueues React's browser build's chunks: 2048-byte views and long pieces", async () => {
    const chunks = async (server: Any, L: Lib): Promise<string[]> => {
      const stream = await server.renderToReadableStream(make(L));
      const seen: string[] = [];
      const reader = stream.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        seen.push(show(r.value));
        open();
      }
      return seen;
    };
    transition = false;
    const expected = await chunks(ReactServer, React);
    expect(expected.length).toBeGreaterThan(10);
    expect(await chunks(Server, Compat)).toEqual(expected);
    transition = true;
  });

  test("renderToPipeableStream stops writing when the writable is full, until it drains", async () => {
    // Boundaries that complete together, and errored ones, each a script: a full writable stops
    // the flush after the one that filled it.
    const many: Make = (L) => {
      let p: Any, q: Any;
      const Late = ({ n }: Any): Any => {
        L.use((p ??= later(null, 5)));
        if (n % 3 === 0) throw new Error("boom " + n);
        return L.createElement("p", null, String(n).repeat(3000));
      };
      // A boundary whose first part completes before its second: its part streams in alone.
      const Later = (): Any => L.use((q ??= later("last", 30)));
      return L.createElement(
        "div",
        null,
        Array.from({ length: 6 }, (_, n) =>
          L.createElement(L.Suspense, { key: n, fallback: "f" + n }, L.createElement(Late, { n })),
        ),
        L.createElement(
          L.Suspense,
          { fallback: "partial" },
          L.createElement("p", null, L.createElement(Late, { n: 7 })),
          L.createElement("p", null, L.createElement(Late, { n: 8 })),
          L.createElement(Later),
        ),
      );
    };
    const run = (server: Any, L: Lib, full: (i: number) => boolean): Promise<string[]> =>
      new Promise((resolve) => {
        const seen: string[] = [];
        let drain: () => void = () => {};
        let i = 0,
          ended = false;
        const writable = {
          write: (c: Any): boolean => {
            seen.push(show(c));
            if (!full(i++)) return true;
            seen.push("full");
            setTimeout(() => ended || (seen.push("drain"), drain()), 2);
            return false;
          },
          end: () => ((ended = true), resolve(seen)),
          on: (name: string, fn: () => void) => (name === "drain" && (drain = fn), writable),
        };
        const s = server.renderToPipeableStream(many(L), {
          onShellReady: () => s.pipe(writable),
          onError: () => {},
        });
      });
    for (const full of [() => true, (i: number) => i % 2 === 1, (i: number) => i === 3]) {
      const expected = await run(ReactNodeServer, React, full);
      expect(expected).toContain("drain");
      expect(await run(Server, Compat, full)).toEqual(expected);
    }
  });

  test("piping before the work starts gives onHeaders what is hinted by then", async () => {
    const run = (server: Any, L: Lib): Promise<string> =>
      new Promise((resolve) => {
        const seen: string[] = [];
        const writable = { write: () => true, end: () => resolve(seen.join("|")), on: () => writable };
        function Hints(): Any {
          dom(L).preconnect("https://late.example");
          return "x";
        }
        server
          .renderToPipeableStream(L.createElement(Hints), { onHeaders: (h: Any) => void seen.push(JSON.stringify(h)) })
          .pipe(writable);
      });
    expect(await run(Server, Compat)).toBe(await run(ReactNodeServer, React));
  });
});

describe("replaying promises", () => {
  // A promise made during render: React keeps the ones a component used before it suspended and,
  // when it renders again, reads them in place of the new ones it makes at the same positions.
  /** A promise that resolves to `value` soon; past `limit` tries, a settled thenable, so a render that never replays still ends. */
  const fresh = (value: Any, tries: { n: number }, limit = 4): Any =>
    tries.n++ < limit
      ? new Promise((resolve) => setTimeout(() => resolve(value + "@" + tries.n), 2))
      : { status: "fulfilled", value: "gave up", then() {} };

  test("a promise made during render is replayed when the component renders again", async () => {
    await sameStream((L) => {
      const tries = { n: 0 };
      const One = (): Any => L.createElement("b", null, L.use(fresh("one", tries)));
      return L.createElement("div", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(One)));
    });
  });

  test("each position keeps its promise: two in a row, a cached one between, and a re-render pass", async () => {
    await sameStream((L) => {
      const a = { n: 0 },
        b = { n: 0 };
      let cached: Any;
      function Two(): Any {
        const first = L.use(fresh("first", a));
        const mid = L.use((cached ??= later("cached", 4)));
        const second = L.use(fresh("second", b));
        return L.createElement("p", null, [first, mid, second].join(" "));
      }
      function Again(): Any {
        // Set during render: the component runs again in the same render, from the first promise.
        const [n, setN] = L.useState(0);
        if (n < 2) setN(n + 1);
        const c = { n: 0 };
        return L.createElement("i", null, n + ":" + L.use(n < 2 ? fresh("again", c) : fresh("again", c)));
      }
      return L.createElement(
        "div",
        null,
        L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Two)),
        L.createElement(L.Suspense, { fallback: "g" }, L.createElement(Again)),
      );
    });
  });

  test("the shell's own promises, and a lazy component's, which is not replayed", async () => {
    await sameStream((L) => {
      const tries = { n: 0 };
      const Shell = (): Any => L.createElement("main", null, L.use(fresh("shell", tries)));
      const Lazy = L.lazy(() => later({ default: () => "lazy" }, 3));
      return L.createElement(L.Fragment, null, L.createElement(Shell), L.createElement(Lazy));
    });
  });
});

describe("formState and server actions", () => {
  // A server action as React's server sees one: $$FORM_ACTION gives the form's fields, bind
  // returns another action, and $$IS_SIGNATURE_EQUAL says whether a postback came from it.
  function serverAction(ref: string): Any {
    const fields = (prefix: string, bound: Any[]): Any => {
      const data = new FormData();
      data.append("bound", JSON.stringify(bound));
      return { name: prefix, action: "", encType: "multipart/form-data", method: "POST", target: undefined, data };
    };
    const act: Any = (prev: Any) => prev;
    act.$$FORM_ACTION = (prefix: string) => fields(prefix, []);
    act.$$IS_SIGNATURE_EQUAL = (r: Any, bound: Any) => r === ref && bound === null;
    act.bind = (_this: Any, ...bound: Any[]) => {
      const b: Any = (...rest: Any[]) => act(...bound, ...rest);
      b.$$FORM_ACTION = (prefix: string) => fields(prefix, bound);
      return b;
    };
    return act;
  }
  // A tree whose forms sit under every kind of element, so their key paths take every step.
  const tree =
    (suspend = false) =>
    (L: Lib): Any => {
      // Each library waits on a promise of its own, so both renders suspend.
      const wait = suspend ? later("go", 1) : undefined;
      const act = serverAction("ref");
      function Form({ label }: Any): Any {
        const [state, formAction, pending] = L.useActionState(act, 0);
        const [plain, plainAction] = L.useActionState((s: Any) => s, "plain");
        // Calling them on the server runs the actions, as React's server hook does.
        if (label === "a") (formAction("payload"), plainAction("payload"));
        return L.createElement("form", { action: formAction }, [label, state, plain, pending].join(":"));
      }
      function Late({ label }: Any): Any {
        if (wait !== undefined) L.use(wait);
        return L.createElement(Form, { label });
      }
      function Plain(): Any {
        const [s] = L.useActionState((x: Any) => x, "only plain");
        return s;
      }
      const Ref = L.forwardRef(function Named({ label }: Any, _ref: Any): Any {
        const [state, formAction] = L.useActionState(act, "perm", "/permalink");
        return L.createElement("form", { action: formAction }, label + ":" + state);
      });
      const Anonymous = L.forwardRef((_p: Any, _r: Any) => L.createElement(Form, { label: "anon" }));
      const Memo = L.memo(Form);
      const NamedMemo = L.memo(Form);
      NamedMemo.displayName = "Shown";
      const Ctx = L.createContext(0);
      Ctx.displayName = "Ctx";
      const Bare = L.createContext(0);
      const Lazy = L.lazy(() => later({ default: Form }, 30));
      class Cls extends L.Component {
        render(): Any {
          return L.createElement(Form, { label: "class" });
        }
      }
      return L.createElement(
        "div",
        null,
        [L.createElement(Form, { key: "a", label: "a" }), L.createElement(Memo, { key: 2, label: "b" })],
        L.createElement(NamedMemo, { label: "c" }),
        L.createElement(
          L.Suspense,
          { fallback: L.createElement(Form, { label: "fallback" }) },
          L.createElement(Late, { label: "late" }),
        ),
        L.createElement(Ctx, { value: 1 }, L.createElement(L.Fragment, null, L.createElement(Form, { label: "ctx" }))),
        L.createElement(Bare.Consumer, null, () => L.createElement(Form, { label: "consumer" })),
        L.createElement(Ctx.Consumer, null, () => L.createElement(Plain)),
        L.createElement(Ref, { label: "ref" }),
        L.createElement(Anonymous),
        L.createElement(
          L.StrictMode,
          null,
          L.createElement(L.Profiler, { id: "p", onRender() {} }, L.createElement(Cls)),
        ),
        L.createElement(L.Activity, { mode: "visible" }, L.createElement(Form, { label: "activity" })),
        L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Lazy, { label: "lazy" })),
        L.createElement(Symbol.for("react.view_transition"), { name: "vt" }, L.createElement(Form, { label: "vt" })),
        L.createElement(
          Symbol.for("react.suspense_list"),
          { revealOrder: "forwards", tail: "visible" },
          L.createElement(L.Suspense, { fallback: "x" }, L.createElement(Form, { label: "row" })),
        ),
        new Set([L.createElement(Form, { label: "iterable" })]),
      );
    };
  /** The $ACTION_KEY of the first form in `html`. */
  const actionKey = (html: string): string => /name="\$ACTION_KEY" value="([^"]*)"/.exec(html)![1]!;

  test("forms of server actions carry React's key paths and hashes in every entry", async () => {
    const html = await same(tree(), undefined, true);
    expect(html).toContain("$ACTION_KEY");
    expect(html).toContain('action="/permalink"');
    expect(html).toContain('value="p/permalink"');
    // React's builds hash the key path differently: its Node build with MD5, the others with
    // MurmurHash3, so the streams of the two builds carry different keys.
    expect(actionKey(await pipeAll(Server, tree()(Compat)))).toMatch(/^k[0-9a-f]{32}$/);
    expect(actionKey(await streamAll(Server, tree()(Compat)))).toMatch(/^k\d+$/);
  });

  test("a postback's formState is the matching action's state, with React's markers", async () => {
    const readableKey = actionKey(await streamAll(ReactServer, tree()(React)));
    const pipeKey = actionKey(await pipeAll(ReactNodeServer, tree()(React)));
    for (const [formState, key] of [
      [[42, readableKey, "ref", null], readableKey],
      [[42, "no match", "ref", null], readableKey],
      [[42, readableKey, "another ref", null], readableKey],
      [[42, "p/permalink", "ref", null], readableKey],
    ] as const) {
      const options = { formState };
      const html = await sameStream(tree(true), options);
      expect(html).toContain("<!--F");
      if (formState[1] === key && formState[2] === "ref") expect(html).toContain("<!--F!-->");
      // renderToString has no formState, as React's legacy build.
      expect(Server.renderToString(tree()(Compat), options as Any)).toBe(
        ReactServer.renderToString(tree()(React), options),
      );
    }
    const options = { formState: [42, pipeKey, "ref", null] };
    const piped = await pipeAll(Server, tree(true)(Compat), options, true);
    expect(piped).toBe(await pipeAll(ReactNodeServer, tree(true)(React), options, true));
    expect(piped).toContain("<!--F!-->");
  });

  test("a component that renders again keeps the postback's state and its markers", async () => {
    const again = (L: Lib): Any => {
      const act = serverAction("ref");
      function Again(): Any {
        const [n, setN] = L.useState(0);
        const [state, formAction] = L.useActionState(act, 0);
        if (n < 2) setN(n + 1);
        return L.createElement("form", { action: formAction }, "again:" + n + ":" + state);
      }
      return L.createElement("div", null, L.createElement(Again));
    };
    const key = actionKey(await streamAll(ReactServer, again(React)));
    const html = await sameStream(again, { formState: [42, key, "ref", null] });
    expect(html).toContain("again:2:42");
    expect(html).toContain("<!--F!-->");
  });
});

describe("hints from async work", () => {
  // React's Node build (and its edge build, where AsyncLocalStorage is global) finds the request
  // of a hint made in async work the render started, and flushes it; compat does where
  // AsyncLocalStorage exists. React's Bun build has no such storage: the hint goes nowhere.
  const make: Make = (L) => {
    const D = dom(L);
    const gate = later("done", 20);
    let started = false;
    function Async(): Any {
      if (!started) {
        started = true;
        void Promise.resolve()
          .then(() => later(null, 2))
          .then(() => {
            D.preconnect("https://async.example");
            D.preload("/async.js", { as: "script" });
            D.preinit("/async-script.js", { as: "script" });
          });
      }
      return L.createElement("b", null, L.use(gate));
    }
    return L.createElement(
      "html",
      null,
      L.createElement("body", null, L.createElement(L.Suspense, { fallback: "f" }, L.createElement(Async))),
    );
  };

  test("a hint made in a promise callback the render started reaches the stream", async () => {
    const piped = await pipeAll(Server, make(Compat));
    expect(piped).toBe(await pipeAll(ReactNodeServer, make(React)));
    expect(piped).toContain("/async.js");
    const streamed = await streamAll(Server, make(Compat));
    expect(streamed).toBe(await streamAll(ReactNodeServer, make(React)));
    expect(await streamAll(ReactBunServer, make(React))).not.toContain("/async.js");
  });
});
