// @reactre/compat/server's partial prerendering against React's (react-dom@19.3.1, production builds).
//
// Each test builds one tree for each phase and library: `prerender`, where the work that waits
// stays pending until the signal aborts, and `resume`, where it renders. Both servers prerender it
// and must write the same prelude, the same postponed state (as JSON) and report the same errors;
// then React resumes its postponed state and compat resumes both React's (parsed from the JSON) and
// its own (the object it returned), and each must write React's HTML. The web entries are compared
// with React's browser build (react-dom/static.browser, server.browser) through compat's browser
// entry, the Node ones with its Node build through compat's Node entry, errors by their very
// messages: the browser build's minified codes, the Node build's full text.

import { describe, expect, test } from "bun:test";

import * as Compat from "../src/core.ts";
import * as Browser from "../src/server.browser.ts";
import * as Server from "../src/server.ts";

// biome-ignore lint: both libraries are used through one untyped interface.
type Any = any;

const load = (specifier: string): Promise<Any> => import(specifier);
const prevEnv = process.env["NODE_ENV"];
process.env["NODE_ENV"] = "production";
const React: Any = await load("react");
const ReactDOM: Any = await load("react-dom");
const ReactStatic: Any = await load("react-dom/static.browser");
const ReactNodeStatic: Any = await load("react-dom/static.node");
const ReactServer: Any = await load("react-dom/server.browser");
const ReactNodeServer: Any = await load("react-dom/server.node");
if (prevEnv === undefined) delete process.env["NODE_ENV"];
else process.env["NODE_ENV"] = prevEnv;

type Lib = Any;
type Options = Record<string, Any>;
/** The phase a tree is built for: what its holes do (see hole). */
type Phase = string;
type Make = (L: Lib, phase: Phase) => Any;

/** The library with react-dom's functions (preload and the rest) for `L`. */
const dom = (L: Lib): Any => (L === React ? ReactDOM : L);

/** A ReadableStream's bytes as text. */
const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

/** A Node Readable's bytes as text. */
async function readNode(readable: Any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

/** A macrotask: by then both servers have rendered all that settles in microtasks. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A promise that resolves to `value` after `ms`. */
const later = <T>(value: T, ms = 1): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

/** An error's message, as the logs compare them. */
const message = (e: Any): string => (e instanceof Error ? e.message : String(e));

/**
 * A component that waits: forever in the phases listed in `pendingIn` (prerender by default), for
 * `ms` in the others if given, then renders `render()`.
 */
function hole(L: Lib, phase: Phase, render: () => Any, ms?: number, pendingIn: Phase[] = ["prerender"]): Any {
  const wait = pendingIn.includes(phase) ? new Promise(() => {}) : ms === undefined ? null : later(true, ms);
  function Hole(): Any {
    if (wait !== null) L.use(wait);
    return render();
  }
  return L.createElement(Hole);
}

interface Rendered {
  html: string;
  postponed: Any;
  json: string;
  log: string[];
  headers: string[];
}

/** The abort reason the tests use. */
const STOP = new Error("stop");

/**
 * A prerender through `entry` (prerender or prerenderToNodeStream), aborted after the work that
 * settles at once unless `abort` is false, with its prelude read before the postponed state is
 * serialized (the prelude's flushes take segment ids).
 */
async function prerenderWith(
  server: Any,
  entry: string,
  el: Any,
  options: Options = {},
  abort: boolean | ((c: AbortController) => Promise<void>) = true,
): Promise<Rendered> {
  const log: string[] = [],
    headers: string[] = [];
  const controller = new AbortController();
  const promise = server[entry](el, {
    onError: (e: Any) => void log.push(message(e)),
    ...options,
    ...(options["onHeaders"]
      ? { onHeaders: (h: Any) => headers.push(JSON.stringify(h instanceof Headers ? h.get("Link") : h)) }
      : {}),
    signal: controller.signal,
  });
  if (typeof abort === "function") await abort(controller);
  else if (abort) {
    await tick();
    controller.abort(STOP);
  }
  const { prelude, postponed } = await promise;
  const html = entry.endsWith("NodeStream") ? await readNode(prelude) : await text(prelude);
  return { html, postponed, json: JSON.stringify(postponed), log, headers };
}

/** A resume through `resume` (web) or `resumeToPipeableStream` (Node), read to its end. */
async function resumeWith(
  server: Any,
  node: boolean,
  el: Any,
  postponed: Any,
  options: Options = {},
): Promise<Rendered> {
  const log: string[] = [];
  const opts = { onError: (e: Any) => void log.push(message(e)), ...options };
  if (!node) {
    const stream = await server.resume(el, postponed, opts);
    await stream.allReady;
    return { html: await text(stream), postponed: null, json: "", log, headers: [] };
  }
  const html = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const writable = {
      write: (c: Any) => (chunks.push(Buffer.from(c)), true),
      end: () => resolve(Buffer.concat(chunks).toString()),
      on: () => writable,
      destroy: reject,
    };
    const s = server.resumeToPipeableStream(el, postponed, {
      ...opts,
      onShellReady: () => s.pipe(writable),
      onShellError: reject,
    });
  });
  return { html, postponed: null, json: "", log, headers: [] };
}

/** Expect compat's render to be React's: the HTML, the postponed JSON, the errors and the headers. */
function expectSame(c: Rendered, r: Rendered): void {
  expect(c.html).toBe(r.html);
  expect(c.json).toBe(r.json);
  expect(c.log).toEqual(r.log);
  expect(c.headers).toEqual(r.headers);
}

interface Result {
  prelude: string;
  postponed: Any;
  resumed: string;
  log: string[];
}

/**
 * Prerender `make` with both servers, then resume: React from its postponed state, compat from
 * React's (as JSON) and from its own. Expects React's output everywhere; returns React's.
 */
async function same(make: Make, options: Options = {}, node = false, resumeOptions: Options = {}): Promise<Result> {
  const entry = node ? "prerenderToNodeStream" : "prerender";
  const r = await prerenderWith(node ? ReactNodeStatic : ReactStatic, entry, make(React, "prerender"), options);
  const compat = node ? Server : Browser;
  const c = await prerenderWith(compat, entry, make(Compat, "prerender"), options);
  expectSame(c, r);
  if (r.postponed === null) return { prelude: r.html, postponed: null, resumed: "", log: r.log };
  const reactServer = node ? ReactNodeServer : ReactServer;
  const rr = await resumeWith(reactServer, node, make(React, "resume"), JSON.parse(r.json), resumeOptions);
  const cr = await resumeWith(compat, node, make(Compat, "resume"), JSON.parse(r.json), resumeOptions);
  expectSame(cr, rr);
  const own = await resumeWith(compat, node, make(Compat, "resume"), c.postponed, resumeOptions);
  expectSame(own, rr);
  return { prelude: r.html, postponed: r.postponed, resumed: rr.html, log: rr.log };
}

/** `same` through both the web and the Node entries. */
async function sameBoth(make: Make, options: Options = {}): Promise<Result> {
  await same(make, options, true);
  return same(make, options);
}

const h = (L: Lib, ...args: Any[]): Any => L.createElement(...args);
const suspense = (L: Lib, fallback: Any, ...children: Any[]): Any => h(L, L.Suspense, { fallback }, ...children);

describe("prerender", () => {
  test("a prerender that completes writes the whole document and postpones nothing", async () => {
    const make: Make = (L, phase) =>
      h(
        L,
        "html",
        null,
        h(L, "head", null, h(L, "title", null, "Page")),
        h(
          L,
          "body",
          null,
          "a",
          suspense(
            L,
            "loading",
            hole(L, phase, () => "late", 1, []),
          ),
          suspense(L, "loading", h(L, "p", null, "inline")),
        ),
      );
    const options = {
      identifierPrefix: "x-",
      bootstrapScriptContent: "go()",
      bootstrapScripts: ["/a.js", { src: "/b.js", integrity: "sha", crossOrigin: "use-credentials" }],
      bootstrapModules: ["/m.js"],
      importMap: { imports: { a: "/a.js" } },
      // React's static entries ignore a nonce and formState.
      nonce: "n",
      formState: [1, "k", "ref", null],
    };
    const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"), options, false);
    const c = await prerenderWith(Browser, "prerender", make(Compat, "prerender"), options, false);
    expectSame(c, r);
    expect(r.postponed).toBeNull();
    expect(r.html).toContain("late");
    const rn = await prerenderWith(ReactNodeStatic, "prerenderToNodeStream", make(React, "prerender"), options, false);
    const cn = await prerenderWith(Server, "prerenderToNodeStream", make(Compat, "prerender"), options, false);
    expectSame(cn, rn);
    // Without options, too.
    const bare = (L: Lib): Any => h(L, "p", null, "plain");
    expect(await text((await Browser.prerender(bare(Compat))).prelude)).toBe(
      await text((await ReactStatic.prerender(bare(React))).prelude),
    );
  });

  test("aborted with Suspense boundaries pending, then resumed", async () => {
    const make: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        "before",
        suspense(
          L,
          h(L, "i", null, "one…"),
          hole(L, phase, () => h(L, "b", null, "one")),
        ),
        suspense(L, "done", h(L, "span", null, "inline")),
        suspense(
          L,
          h(L, "i", null, "two…"),
          h(
            L,
            "p",
            null,
            "text ",
            hole(L, phase, () => "two", 2),
            " more",
          ),
        ),
        "after",
      );
    const { prelude, postponed, resumed, log } = await sameBoth(make);
    expect(prelude).toContain("one…");
    expect(postponed.replayNodes.length).toBe(1);
    expect(resumed).toContain('$RC("B:0","S:0")');
    expect(log).toEqual([]);
  });

  test("an abort with no reason, and a signal aborted before the prerender starts", async () => {
    const make: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        suspense(
          L,
          "…",
          hole(L, phase, () => "x"),
        ),
      );
    const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"), {}, async (c) => {
      await tick();
      c.abort();
    });
    const c = await prerenderWith(Browser, "prerender", make(Compat, "prerender"), {}, async (c) => {
      await tick();
      c.abort();
    });
    expectSame(c, r);
    const early = async (s: Any): Promise<Rendered> =>
      prerenderWith(s, "prerender", make(s === Browser ? Compat : React, "prerender"), {}, async (c) => c.abort(STOP));
    expectSame(await early(Browser), await early(ReactStatic));
  });

  test("nested boundaries: pending in completed, completed in pending, pending in pending", async () => {
    const make: Make = (L, phase) =>
      h(
        L,
        "main",
        null,
        suspense(
          L,
          "outer…",
          h(
            L,
            "section",
            null,
            "outer done",
            suspense(
              L,
              "inner…",
              hole(L, phase, () => "inner late"),
            ),
          ),
        ),
        suspense(
          L,
          "outer2…",
          hole(L, phase, () =>
            h(
              L,
              "div",
              null,
              suspense(
                L,
                "deep…",
                hole(L, phase, () => "deep", 1),
              ),
            ),
          ),
          suspense(L, "sibling…", "sibling"),
        ),
        suspense(
          L,
          "a…",
          suspense(
            L,
            "b…",
            suspense(
              L,
              "c…",
              h(
                L,
                "em",
                null,
                hole(L, phase, () => "c", 1),
              ),
            ),
          ),
          "after b",
        ),
      );
    const { postponed } = await sameBoth(make);
    expect(JSON.stringify(postponed.replayNodes)).toContain("Suspense Fallback");
  });

  test("useId and formState keys across prerender and resume", async () => {
    // A server action as React's server sees one (see server.test.ts).
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
    const make: Make = (L, phase) => {
      const act = serverAction("ref");
      function Id({ label }: Any): Any {
        const id = L.useId();
        const other = L.useId();
        return h(L, "label", { id, htmlFor: other }, label);
      }
      function Form({ label }: Any): Any {
        const [state, formAction] = L.useActionState(act, 0);
        return h(L, "form", { action: formAction }, h(L, Id, { label }), label + ":" + state);
      }
      function Named(): Any {
        L.useId();
        return h(
          L,
          "div",
          null,
          h(L, Form, { label: "named" }),
          suspense(
            L,
            "…",
            hole(L, phase, () => h(L, Id, { label: "deep" })),
          ),
        );
      }
      return h(
        L,
        "div",
        null,
        h(L, Id, { label: "shell" }),
        h(L, Form, { label: "shell form" }),
        suspense(
          L,
          "…",
          hole(L, phase, () => [h(L, Id, { key: "a", label: "late" }), h(L, Form, { key: "b", label: "late form" })]),
        ),
        h(L, Named),
      );
    };
    const web = await same(make, { identifierPrefix: "p" });
    expect(web.resumed).toContain('id="_pR_');
    expect(web.resumed).toMatch(/name="\$ACTION_KEY" value="k\d+"/);
    const node = await same(make, { identifierPrefix: "p" }, true);
    expect(node.resumed).toMatch(/name="\$ACTION_KEY" value="k[0-9a-f]{32}"/);
  });

  test("resource hints and onHeaders, in the shell and in postponed content", async () => {
    const make: Make = (L, phase) => {
      const D = dom(L);
      function Hints(): Any {
        D.preconnect("https://shell.example");
        D.prefetchDNS("https://dns.example");
        D.preload("/font.woff2", { as: "font", type: "font/woff2", crossOrigin: "" });
        D.preload("/hero.jpg", { as: "image", fetchPriority: "high" });
        D.preload("/style.css", { as: "style" });
        D.preinit("/shell.css", { as: "style", precedence: "high" });
        D.preinitModule("/shell.mjs");
        return h(L, "img", { src: "/img.png", fetchPriority: "high" });
      }
      function LateHints(): Any {
        D.preconnect("https://late.example", { crossOrigin: "anonymous" });
        D.preload("/late.js", { as: "script" });
        D.preinit("/late.js", { as: "script" });
        D.preinit("/style.css", { as: "style", precedence: "low" });
        D.preload("/data.json", { as: "fetch" });
        D.preloadModule("/late.mjs");
        return h(L, "div", null, h(L, "link", { rel: "stylesheet", href: "/late.css", precedence: "high" }), "late");
      }
      return h(
        L,
        "html",
        null,
        h(L, "head", null),
        h(
          L,
          "body",
          null,
          h(L, Hints),
          suspense(
            L,
            "…",
            hole(L, phase, () => h(L, LateHints)),
          ),
          "end",
        ),
      );
    };
    for (const options of [{}, { onHeaders: true }, { onHeaders: true, maxHeadersLength: 120 }]) {
      const web = await same(make, options);
      expect(web.resumed).toContain("/late.css");
      await same(make, options, true);
    }
  });

  test("a shell the abort leaves unfinished: the prelude is empty and the resume renders it all", async () => {
    const make: Make = (L, phase) => {
      const D = dom(L);
      function Hints(): Any {
        D.preconnect("https://a.example");
        D.prefetchDNS("https://b.example");
        D.preconnect("https://c.example", { crossOrigin: "use-credentials" });
        D.preload("/font.woff2", { as: "font" });
        D.preload("/hero.jpg", { as: "image", fetchPriority: "high" });
        D.preload("/script.js", { as: "script" });
        D.preinit("/sheet.css", { as: "style", precedence: "p", crossOrigin: "" });
        D.preinit("/plain.css", { as: "style", precedence: "p" });
        return h(L, "img", { src: "/i.png", fetchPriority: "high" });
      }
      return h(
        L,
        "html",
        null,
        h(
          L,
          "body",
          null,
          h(L, Hints),
          h(L, "form", { action: () => {} }),
          hole(L, phase, () => "shell late"),
          "end",
        ),
      );
    };
    const options = { bootstrapScripts: ["/boot.js"] };
    for (const extra of [{}, { onHeaders: true }]) {
      const { prelude, postponed, resumed } = await same(make, { ...options, ...extra });
      expect(prelude).toBe("");
      expect(postponed.replaySlots).toBe(-1);
      expect(resumed).toContain("/boot.js");
    }
    await same(make, { onHeaders: true }, true);
  });

  test("errors while prerendering: in a boundary it renders on the client; in the shell the prerender fails", async () => {
    const make: Make = (L, phase) => {
      function Boom(): Any {
        throw new Error("boom");
      }
      return h(
        L,
        "div",
        null,
        suspense(L, "fallback", h(L, Boom)),
        suspense(
          L,
          "…",
          hole(L, phase, () => "late"),
        ),
      );
    };
    const { prelude } = await same(make, { onError: (e: Any) => (message(e) === "boom" ? "digest" : undefined) });
    expect(prelude).toContain('data-dgst="digest"');
    const shell = (L: Lib): Any => {
      function Boom(): Any {
        throw new Error("shell boom");
      }
      return h(L, "div", null, h(L, Boom));
    };
    const fail = async (s: Any, L: Lib): Promise<string> => {
      try {
        await s.prerender(shell(L), { onError() {} });
      } catch (e) {
        return message(e);
      }
      return "resolved";
    };
    expect(await fail(Browser, Compat)).toBe(await fail(ReactStatic, React));
    // A fallback the prerender writes first that throws fails the boundary around it.
    const fallback: Make = (L, phase) => {
      function Boom(): Any {
        throw new Error("fallback boom");
      }
      return h(
        L,
        "div",
        null,
        suspense(
          L,
          "outer",
          suspense(
            L,
            h(L, Boom),
            hole(L, phase, () => "x"),
          ),
        ),
      );
    };
    await same(fallback);
  });

  test("errors while resuming: postponed content that throws renders on the client", async () => {
    const make: Make = (L, phase) => {
      function Boom(): Any {
        throw new Error("resume boom");
      }
      return h(
        L,
        "div",
        null,
        suspense(
          L,
          "…",
          hole(L, phase, () => h(L, Boom)),
        ),
        suspense(
          L,
          "…",
          hole(L, phase, () => h(L, "p", null, suspense(L, "inner", h(L, Boom)))),
        ),
        suspense(
          L,
          "…",
          hole(L, phase, () => "fine"),
        ),
      );
    };
    const { resumed } = await same(make, {}, false, { onError: () => "d" });
    expect(resumed).toContain('"d")');
  });
});

describe("replaying the prerendered tree", () => {
  test("through every kind of element on the way to postponed work", async () => {
    const make: Make = (L, phase) => {
      const late = (label: string): Any =>
        suspense(
          L,
          label + "…",
          hole(L, phase, () => label),
        );
      const Memo = L.memo(function Shown({ children }: Any): Any {
        return h(L, "section", null, children);
      });
      const Ref = L.forwardRef(function Fwd({ children }: Any, _ref: Any): Any {
        return h(L, "article", null, children);
      });
      const Ctx = L.createContext("default");
      function Reader(): Any {
        return h(L, "span", null, L.useContext(Ctx), late("ctx"));
      }
      class Cls extends L.Component {
        render(): Any {
          return h(L, "aside", null, (this as Any).props.children);
        }
      }
      const Lazy = L.lazy(() => Promise.resolve({ default: ({ children }: Any) => h(L, "nav", null, children) }));
      return h(
        L,
        "div",
        null,
        h(L, Memo, null, late("memo")),
        h(L, Ref, null, late("ref")),
        h(L, Ctx, { value: "given" }, h(L, Reader)),
        h(L, Ctx.Consumer, null, (v: Any) => h(L, "b", null, v, late("consumer"))),
        h(L, Cls, null, late("class")),
        h(L, L.StrictMode, null, h(L, L.Profiler, { id: "p", onRender() {} }, late("profiler"))),
        h(L, L.Activity, { mode: "visible" }, late("activity")),
        h(L, L.Activity, { mode: "hidden" }, late("hidden")),
        h(L, "ul", null, h(L, Lazy, null, late("lazy"))),
        h(L, L.Fragment, null, h(L, "p", null, late("fragment"))),
        new Set([h(L, "i", { key: "it" }, late("iterable"))]),
        suspense(L, "completed", h(L, "em", null, "done", late("in completed"))),
        h(L, "table", null, h(L, "tbody", null, h(L, "tr", null, h(L, "td", null, late("cell"))))),
        h(L, "svg", null, h(L, "foreignObject", null, late("svg"))),
      );
    };
    const { postponed } = await sameBoth(make);
    expect(postponed.replayNodes.length).toBe(1);
  });

  test("arrays and keys: nested arrays, keyed children and several holes under one element", async () => {
    const make: Make = (L, phase) => {
      const late = (label: string, key?: string): Any =>
        h(
          L,
          L.Suspense,
          { key, fallback: label + "…" },
          hole(L, phase, () => label),
        );
      return h(
        L,
        "div",
        null,
        [
          [late("a", "a"), "text", late("b", "b")],
          ["x", [late("c", "c")]],
        ],
        h(
          L,
          "ul",
          null,
          ["one", "two"].map((k) => h(L, "li", { key: k }, late(k))),
        ),
        suspense(
          L,
          "holes…",
          h(
            L,
            "p",
            null,
            "1",
            hole(L, phase, () => "first"),
            "2",
            hole(L, phase, () => "second", 1),
            "3",
          ),
          [hole(L, phase, () => "in array")],
        ),
      );
    };
    await sameBoth(make);
  });

  test("a boundary at the root, and boundaries that hold the document", async () => {
    const root: Make = (L, phase) =>
      suspense(
        L,
        "root…",
        hole(L, phase, () => h(L, "p", null, "root")),
      );
    const { prelude, postponed } = await same(root);
    expect(prelude).toBe("");
    expect(postponed.replaySlots).toBe(-1);
    const document: Make = (L, phase) =>
      h(
        L,
        "html",
        null,
        h(L, "head", null, h(L, "title", null, "t")),
        h(
          L,
          "body",
          null,
          suspense(
            L,
            "…",
            hole(L, phase, () => "body late"),
          ),
        ),
        suspense(
          L,
          null,
          hole(L, phase, () => h(L, "div", null, "html late")),
        ),
      );
    await sameBoth(document);
    const whole: Make = (L, phase) =>
      suspense(
        L,
        h(L, "html", null, h(L, "body", null, "loading")),
        hole(L, phase, () => h(L, "html", null, h(L, "body", null, "done"))),
      );
    await same(whole);
  });

  test("boundaries postponed in a postponed boundary, and a fallback that waits too", async () => {
    const make: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        suspense(
          L,
          "outer…",
          h(
            L,
            "section",
            null,
            suspense(
              L,
              "inner…",
              hole(L, phase, () => "inner", 1),
            ),
            hole(L, phase, () => "own"),
          ),
        ),
        suspense(
          L,
          "parent…",
          suspense(
            L,
            hole(L, phase, () => "fallback ready"),
            hole(L, phase, () => "content"),
          ),
        ),
      );
    await sameBoth(make);
  });

  test("components on the way that suspend while resuming, once or twice, nested", async () => {
    const make: Make = (L, phase) => {
      const first = phase === "resume" ? later("first", 1) : null;
      const second = phase === "resume" ? later("second", 3) : null;
      function Outer({ children }: Any): Any {
        if (first !== null) L.use(first);
        return h(L, Inner, null, children);
      }
      function Inner({ children }: Any): Any {
        if (second !== null) L.use(second);
        return h(L, "div", null, children);
      }
      function Twice({ children }: Any): Any {
        if (first !== null) L.use(first);
        if (second !== null) L.use(second);
        return children;
      }
      return h(
        L,
        "main",
        null,
        h(
          L,
          Outer,
          null,
          suspense(
            L,
            "a…",
            hole(L, phase, () => "a"),
          ),
        ),
        h(
          L,
          "p",
          null,
          h(
            L,
            Twice,
            null,
            suspense(
              L,
              "b…",
              hole(L, phase, () => "b"),
            ),
          ),
        ),
      );
    };
    await sameBoth(make);
  });

  test("a stack overflow while replaying renders the rest in a task of its own", async () => {
    const make: Make = (L, phase) => {
      let calls = 0;
      function Deep({ children }: Any): Any {
        if (phase === "resume" && calls++ === 0) throw new RangeError("Maximum call stack size exceeded");
        return h(L, "div", null, children);
      }
      function App(): Any {
        return h(
          L,
          Deep,
          null,
          suspense(
            L,
            "…",
            hole(L, phase, () => "deep"),
          ),
        );
      }
      function Wrapped(): Any {
        return h(
          L,
          "section",
          null,
          h(
            L,
            Deep,
            null,
            suspense(
              L,
              "…",
              hole(L, phase, () => "wrapped"),
            ),
          ),
        );
      }
      return h(L, "div", null, h(L, App), h(L, Wrapped));
    };
    await same(make);
    const root: Make = (L, phase) => {
      let calls = 0;
      function Deep({ children }: Any): Any {
        if (phase === "resume" && calls++ === 0) throw new RangeError("Maximum call stack size exceeded");
        return h(L, "div", null, children);
      }
      function App(): Any {
        return h(
          L,
          Deep,
          null,
          suspense(
            L,
            "…",
            hole(L, phase, () => "deep"),
          ),
        );
      }
      return h(L, App);
    };
    await same(root);
  });

  test("SuspenseList rows postponed in each reveal order", async () => {
    const list = (L: Lib, phase: Phase, revealOrder: string): Any =>
      h(
        L,
        Symbol.for("react.suspense_list"),
        { revealOrder, tail: "visible" },
        suspense(L, "1…", "one"),
        suspense(
          L,
          "2…",
          hole(L, phase, () => "two"),
        ),
        suspense(L, "3…", "three"),
        suspense(
          L,
          "4…",
          hole(L, phase, () => "four", 1),
        ),
        hole(L, phase, () => "a bare row"),
      );
    // Rows that reveal independently resume to the end.
    await sameBoth((L, phase) => h(L, "div", null, suspense(L, "list…", list(L, phase, "independent"))));
    // Rows that reveal in order or together: React's resume writes the rows the prerender
    // postponed and then never finishes (its allReady stays pending); compat's does the same. What
    // each writes in its first moments is compared.
    for (const revealOrder of ["forwards", "backwards", "unstable_legacy-backwards", "together"]) {
      const make: Make = (L, phase) => h(L, "div", null, suspense(L, "list…", list(L, phase, revealOrder)));
      const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"));
      const c = await prerenderWith(Browser, "prerender", make(Compat, "prerender"));
      expectSame(c, r);
      const first = async (s: Any, L: Lib): Promise<string> => {
        const stream = await s.resume(make(L, "resume"), JSON.parse(r.json), { onError() {} });
        const reader = stream.getReader();
        let html = "";
        const decoder = new TextDecoder();
        const timeout = later(null, 20);
        for (;;) {
          const step = await Promise.race([reader.read(), timeout]);
          if (step === null || step.done) break;
          html += decoder.decode(step.value);
        }
        await reader.cancel();
        return html;
      };
      const resumed = await first(ReactServer, React);
      expect(resumed).toContain("two");
      expect(await first(Browser, Compat)).toBe(resumed);
    }
    // A row that waits outside any boundary leaves the shell to the resume.
    const shell: Make = (L, phase) =>
      h(
        L,
        Symbol.for("react.suspense_list"),
        { revealOrder: "forwards", tail: "visible" },
        h(L, "p", null, "row"),
        hole(L, phase, () => "a row"),
      );
    await same(shell);
  });

  test("ViewTransitions on the way (React's Node build only, see below)", async () => {
    // React's browser build enqueues the precomputed script that reveals boundaries with view
    // transitions, longer than its 2048-byte views, into the byte stream, which detaches it: any
    // later render in this process that writes it fails (React's error 612). Its Node build copies.
    const make: Make = (L, phase) => {
      const late = (label: string): Any =>
        suspense(
          L,
          label + "…",
          hole(L, phase, () => label),
        );
      return h(
        L,
        "div",
        null,
        h(L, Symbol.for("react.view_transition"), { name: "vt" }, late("vt")),
        h(L, Symbol.for("react.view_transition"), null, late("auto vt")),
      );
    };
    await same(make, {}, true);
  });
});

describe("resuming a tree that differs", () => {
  test("another element, another component, or no Suspense where the prerender had one", async () => {
    const variants: ((L: Lib, phase: Phase, content: Any) => Any)[] = [
      (L, phase, content) => h(L, phase === "resume" ? "section" : "div", null, content),
      (L, phase, content) => {
        function A({ children }: Any): Any {
          return h(L, "b", null, children);
        }
        function B({ children }: Any): Any {
          return h(L, "b", null, children);
        }
        return h(L, phase === "resume" ? B : A, null, content);
      },
      (L, phase, content) => (phase === "resume" ? h(L, "div", null, "no boundary") : content),
      (L, _phase, content) => h(L, "div", null, content),
    ];
    for (const wrap of variants) {
      const make: Make = (L, phase) =>
        h(
          L,
          "main",
          null,
          wrap(
            L,
            phase,
            h(
              L,
              "div",
              null,
              suspense(
                L,
                "…",
                hole(L, phase, () => "a"),
              ),
            ),
          ),
          suspense(
            L,
            "…",
            hole(L, phase, () => "b"),
          ),
        );
      await sameBoth(make);
    }
  });

  test("a Suspense boundary's place taken by another element, and replay nodes left unreached", async () => {
    const swapped: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        phase === "resume"
          ? h(L, "p", null, "not a boundary")
          : suspense(
              L,
              "…",
              hole(L, phase, () => "a"),
            ),
      );
    await same(swapped);
    const missing: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        h(
          L,
          "section",
          null,
          phase === "resume"
            ? null
            : suspense(
                L,
                "…",
                hole(L, phase, () => "gone"),
              ),
        ),
        suspense(
          L,
          "…",
          hole(L, phase, () => "kept"),
        ),
      );
    await same(missing);
    const unreachedInBoundary: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        suspense(
          L,
          "outer…",
          h(
            L,
            "p",
            null,
            phase === "resume"
              ? null
              : suspense(
                  L,
                  "…",
                  hole(L, phase, () => "gone"),
                ),
          ),
          hole(L, phase, () => "own"),
        ),
      );
    await same(unreachedInBoundary);
    const fragment: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        [
          phase === "resume"
            ? [h(L, "p", { key: "x" })]
            : [
                suspense(
                  L,
                  "…",
                  hole(L, phase, () => "a"),
                ),
              ],
        ],
        suspense(
          L,
          "…",
          hole(L, phase, () => "b"),
        ),
      );
    await same(fragment);
  });

  test("an error on the way to postponed work renders what was under it on the client", async () => {
    const make: Make = (L, phase) => {
      function Fails({ children }: Any): Any {
        if (phase === "resume") throw new Error("on the way");
        return h(L, "div", null, children);
      }
      return h(
        L,
        "main",
        null,
        h(
          L,
          Fails,
          null,
          suspense(
            L,
            "…",
            hole(L, phase, () => "a"),
          ),
          h(L, "p", null, suspense(L, "…", "done")),
        ),
        suspense(
          L,
          "outer…",
          h(
            L,
            "section",
            null,
            h(
              L,
              Fails,
              null,
              suspense(
                L,
                "…",
                hole(L, phase, () => "b"),
              ),
            ),
          ),
          hole(L, phase, () => "c"),
        ),
        [
          h(
            L,
            Fails,
            { key: "k" },
            suspense(
              L,
              "…",
              hole(L, phase, () => "d"),
            ),
          ),
        ],
      );
    };
    const { log } = await same(make, {}, false, { onError: (e: Any) => message(e) });
    expect(log).toEqual([]);
    // An error above postponed segments that are not boundaries: their boundary renders on the client.
    const slots: Make = (L, phase) => {
      function Fails({ children }: Any): Any {
        if (phase === "resume") throw new Error("above slots");
        return children;
      }
      return h(
        L,
        "div",
        null,
        suspense(
          L,
          "one…",
          h(
            L,
            Fails,
            null,
            h(
              L,
              "p",
              null,
              hole(L, phase, () => "a"),
            ),
          ),
        ),
        suspense(
          L,
          "two…",
          h(
            L,
            Fails,
            null,
            h(
              L,
              "p",
              null,
              "x",
              hole(L, phase, () => "b"),
              "y",
              hole(L, phase, () => "c"),
            ),
          ),
        ),
      );
    };
    await same(slots);
  });

  test("a root element that differs fails the replay of the shell", async () => {
    const make: Make = (L, phase) =>
      h(
        L,
        phase === "resume" ? "section" : "div",
        null,
        suspense(
          L,
          "…",
          hole(L, phase, () => "a"),
        ),
      );
    await sameBoth(make);
  });

  test("a postponed state with slots in the shell, which no prerender writes, fails the resume", async () => {
    const make: Make = (L, phase) => {
      function Fails({ children }: Any): Any {
        if (phase === "resume") throw new Error("fails");
        return h(L, "div", null, children);
      }
      return h(
        L,
        Fails,
        null,
        suspense(
          L,
          "…",
          hole(L, phase, () => "a"),
        ),
      );
    };
    const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"));
    const crafted = (): Any => {
      const state = JSON.parse(r.json);
      state.replayNodes[0][3] = 7;
      return state;
    };
    const run = async (s: Any, L: Lib): Promise<string> => {
      const log: string[] = [];
      try {
        const stream = await s.resume(make(L, "resume"), crafted(), { onError: (e: Any) => void log.push(message(e)) });
        await stream.allReady;
        return (await text(stream)) + log.join();
      } catch (e) {
        return "rejected: " + message(e) + log.join();
      }
    };
    expect(await run(Browser, Compat)).toBe(await run(ReactServer, React));
  });
});

describe("resumeAndPrerender", () => {
  test("a resume that postpones again, then a last resume", async () => {
    // Phases: prerender, then resumeAndPrerender ("middle"), then resume.
    const make: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        suspense(
          L,
          "a…",
          hole(L, phase, () => "a"),
        ),
        suspense(
          L,
          "b…",
          hole(L, phase, () =>
            h(
              L,
              "p",
              null,
              "b",
              suspense(
                L,
                "c…",
                hole(L, phase, () => "c", undefined, ["prerender", "middle"]),
              ),
            ),
          ),
          undefined,
          ["prerender", "middle"],
        ),
        suspense(
          L,
          "d…",
          hole(L, phase, () => "d", 1, ["prerender"]),
        ),
      );
    for (const node of [false, true]) {
      const entry = node ? "prerenderToNodeStream" : "prerender";
      const again = node ? "resumeAndPrerenderToNodeStream" : "resumeAndPrerender";
      const r = await prerenderWith(node ? ReactNodeStatic : ReactStatic, entry, make(React, "prerender"));
      const c = await prerenderWith(node ? Server : Browser, entry, make(Compat, "prerender"));
      expectSame(c, r);
      const middle = async (s: Any, L: Lib, postponed: Any): Promise<Rendered> => {
        const log: string[] = [];
        const controller = new AbortController();
        const p = s[again](make(L, "middle"), postponed, {
          signal: controller.signal,
          onError: (e: Any) => void log.push(message(e)),
        });
        await later(0, 5);
        controller.abort(STOP);
        const { prelude, postponed: next } = await p;
        const html = node ? await readNode(prelude) : await text(prelude);
        return { html, postponed: next, json: JSON.stringify(next), log, headers: [] };
      };
      const rm = await middle(node ? ReactNodeStatic : ReactStatic, React, JSON.parse(r.json));
      const cm = await middle(node ? Server : Browser, Compat, JSON.parse(r.json));
      expectSame(cm, rm);
      expect(rm.postponed).not.toBeNull();
      const rr = await resumeWith(
        node ? ReactNodeServer : ReactServer,
        node,
        make(React, "resume"),
        JSON.parse(rm.json),
      );
      const cr = await resumeWith(node ? Server : Browser, node, make(Compat, "resume"), JSON.parse(rm.json));
      expectSame(cr, rr);
    }
  });

  test("a resumeAndPrerender that completes, or is aborted inside a boundary it resumed", async () => {
    const make: Make = (L, phase) =>
      h(
        L,
        "div",
        null,
        suspense(
          L,
          "a…",
          h(
            L,
            "p",
            null,
            hole(L, phase, () => "a", undefined, ["prerender", "middle"]),
          ),
        ),
      );
    const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"));
    const run = async (s: Any, L: Lib, phase: Phase): Promise<string> => {
      const controller = new AbortController();
      const log: string[] = [];
      const p = s.resumeAndPrerender(make(L, phase), JSON.parse(r.json), {
        signal: controller.signal,
        onError: (e: Any) => void log.push(message(e)),
      });
      await tick();
      controller.abort(STOP);
      try {
        const { prelude, postponed } = await p;
        return (await text(prelude)) + JSON.stringify(postponed) + log.join();
      } catch (e) {
        return "rejected: " + message(e) + log.join();
      }
    };
    expect(await run(Browser, Compat, "resume")).toBe(await run(ReactStatic, React, "resume"));
    expect(await run(Browser, Compat, "middle")).toBe(await run(ReactStatic, React, "middle"));
  });
});

describe("aborting a resume", () => {
  test("pending replay and render work renders on the client", async () => {
    const make: Make = (L, phase) => {
      const slow = phase === "resume" ? new Promise(() => {}) : null;
      function Slow({ children }: Any): Any {
        if (slow !== null) L.use(slow);
        return h(L, "div", null, children);
      }
      return h(
        L,
        "main",
        null,
        h(
          L,
          Slow,
          null,
          suspense(
            L,
            "a…",
            hole(L, phase, () => "a"),
          ),
        ),
        suspense(
          L,
          "b…",
          hole(L, phase, () => h(L, Slow, null, "b")),
        ),
      );
    };
    const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"));
    const run = async (s: Any, L: Lib): Promise<string> => {
      const controller = new AbortController();
      const log: string[] = [];
      const stream = s.resume(make(L, "resume"), JSON.parse(r.json), {
        signal: controller.signal,
        onError: (e: Any) => void log.push(message(e)),
      });
      await tick();
      controller.abort(STOP);
      try {
        const st = await stream;
        return (await text(st)) + log.join();
      } catch (e) {
        return "rejected: " + message(e) + log.join();
      }
    };
    expect(await run(Browser, Compat)).toBe(await run(ReactServer, React));
  });

  test("aborted from a component the resume replays", async () => {
    let controller = new AbortController();
    const make: Make = (L, phase) => {
      function Aborts({ children }: Any): Any {
        if (phase === "resume") {
          controller.abort(STOP);
          L.use(new Promise(() => {}));
        }
        return h(L, "div", null, children);
      }
      return h(
        L,
        "main",
        null,
        h(
          L,
          Aborts,
          null,
          suspense(
            L,
            "a…",
            hole(L, phase, () => "a"),
          ),
        ),
      );
    };
    const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"));
    const run = async (s: Any, L: Lib): Promise<string> => {
      controller = new AbortController();
      const log: string[] = [];
      try {
        const stream = await s.resume(make(L, "resume"), JSON.parse(r.json), {
          signal: controller.signal,
          onError: (e: Any) => void log.push(message(e)),
        });
        return (await text(stream)) + log.join();
      } catch (e) {
        return "rejected: " + message(e) + log.join();
      }
    };
    expect(await run(Browser, Compat)).toBe(await run(ReactServer, React));
  });

  test("a resume whose shell fails rejects", async () => {
    const make: Make = (L, phase) => {
      function Boom(): Any {
        if (phase === "resume") throw new Error("shell fails");
        return "shell";
      }
      return h(
        L,
        "div",
        null,
        h(L, Boom),
        hole(L, phase, () => "late"),
      );
    };
    const r = await prerenderWith(ReactStatic, "prerender", make(React, "prerender"));
    const run = async (s: Any, L: Lib): Promise<string> => {
      try {
        await s.resume(make(L, "resume"), JSON.parse(r.json), { onError() {} });
        return "resolved";
      } catch (e) {
        return message(e);
      }
    };
    expect(await run(Browser, Compat)).toBe(await run(ReactServer, React));
  });
});
