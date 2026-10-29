// @reactre/compat/server against React's own server renderer (react-dom@19.3.1, production builds).
//
// Each test builds one tree twice, once from React and once from compat (so hooks, contexts and
// lazy components come from the library that renders them), renders it with both servers and
// expects the same HTML: renderToString, renderToStaticMarkup and renderToReadableStream (read
// once all of it is ready), plus renderToPipeableStream where the test says so. Errors are
// compared by message. What React's stable build cannot render (browser() tokens) is checked
// against the HTML React writes for the same boundary when it errors.

import { describe, expect, spyOn, test } from "bun:test";

import * as Compat from "../src/index.ts";
import * as Server from "../src/server.ts";
import ServerDefault from "../src/server.ts";

// biome-ignore lint: both libraries are used through one untyped interface.
type Any = any;

// React's production builds: NODE_ENV is read when the modules load. (React has no types here.)
const load = (specifier: string): Promise<Any> => import(specifier);
const prevEnv = process.env["NODE_ENV"];
process.env["NODE_ENV"] = "production";
const React: Any = await load("react");
const ReactServer: Any = await load("react-dom/server.browser");
const ReactNodeServer: Any = await load("react-dom/server.node");
if (prevEnv === undefined) delete process.env["NODE_ENV"];
else process.env["NODE_ENV"] = prevEnv;

type Lib = Any;
type Make = (L: Lib) => Any;
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

/** Both libraries throw the same message from renderToString and from the stream. */
async function sameError(make: Make): Promise<string> {
  const message = thrown(() => ReactServer.renderToString(make(React)));
  expect(thrown(() => Server.renderToString(make(Compat)))).toBe(message);
  expect(thrown(() => Server.renderToStaticMarkup(make(Compat)))).toBe(message);
  const reject = async (server: Any): Promise<string> => {
    try {
      await server.renderToReadableStream(make(server === Server ? Compat : React), quiet);
    } catch (e) {
      return full((e as Error).message);
    }
    return "(resolved)";
  };
  expect(await reject(Server)).toBe(await reject(ReactServer));
  return message;
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
    ]) {
      expect(typeof (Server as Any)[k]).toBe("function");
      expect((ServerDefault as Any)[k]).toBe((Server as Any)[k]);
    }
    expect(Server.version).toBe(Compat.version);
  });

  test("the prerender and resume APIs throw: compat does not implement them", () => {
    for (const name of ["resume", "resumeToPipeableStream", "prerender", "prerenderToNodeStream"])
      expect(() => (Server as Any)[name]()).toThrow(`${name} is not supported by @reactre/compat/server`);
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
      L.createElement("div", null, L.createPortal?.("x", {}) ?? { $$typeof: Symbol.for("react.portal") }),
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
