// @reactre/compat's view transitions against React's production client (react-dom@19.3.1), on the
// fake DOM with a view transition API of its own.
//
// React's client starts a view transition (document.startViewTransition) for a transition that
// changes a <ViewTransition>: it names the elements of what leaves or changes on the old page, the
// update callback commits, and it names what enters or changed on the new page; its events run
// once the transition is ready, its passive phase once it finishes. Each test runs one scene with
// each library and expects the same log: what the components write, each startViewTransition call
// with its types and the markup it sees (names are style properties, which the fake style writes
// into the style attribute), the markup after its update, and the animations React starts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeNode, installFakeDocument } from "@reactre/testdom";

import * as Compat from "../src/index.ts";

// biome-ignore lint: both libraries are used through one untyped interface.
type Any = any;
type Lib = Any;

const load = (specifier: string): Promise<Any> => import(specifier);
const prevEnv = process.env["NODE_ENV"];
process.env["NODE_ENV"] = "production";
const React: Lib = await load("react");
const ReactDOM: Any = await load("react-dom");
await load("react-dom/server.browser");
const internals = ReactDOM.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const before = internals.d;
const ReactClient: Any = await load("react-dom/client");
const client = ((globalThis as Any).__reactClientDispatcher ??= internals.d);
beforeAll(() => void (internals.d = client));
afterAll(() => void (internals.d = before));
if (prevEnv === undefined) delete process.env["NODE_ENV"];
else process.env["NODE_ENV"] = prevEnv;

// The fake nodes' document, as both libraries reach it, with what a view transition reads: its
// window (the viewport), fonts, <html> (which animates the transition's pseudo-elements) and, in
// each scene, startViewTransition. Each goes after its test.
const fakeDoc = new FakeNode(9).ownerDocument as Any;
let html: FakeElement & Any;
let animations: string[];
const own = (o: Any, k: string, value: Any): void =>
  void Object.defineProperty(o, k, { configurable: true, writable: true, value });
beforeEach(() => {
  installFakeDocument();
  (globalThis as Any).window = globalThis;
  animations = [];
  html = new FakeElement("HTML") as Any;
  own(html, "animate", (k: Any, o: Any) => {
    animations.push(`animate ${JSON.stringify(k)} ${JSON.stringify(o)}`);
    return { k, o };
  });
  own(html, "getAnimations", () => [
    { effect: { target: html, pseudoElement: "::view-transition-group(a)", getKeyframes: () => [] }, cancel() {} },
    { effect: { target: html, pseudoElement: "::view-transition-old(a)", getKeyframes: () => [] }, cancel() {} },
  ]);
  own(fakeDoc, "addEventListener", () => {});
  own(fakeDoc, "defaultView", {
    document: fakeDoc,
    HTMLIFrameElement: class {},
    getSelection: () => null,
    innerHeight: 1000,
    innerWidth: 1000,
  });
  own(fakeDoc, "fonts", { status: "loaded", ready: Promise.resolve() });
  own(fakeDoc, "documentElement", html);
  (globalThis as Any).document.documentElement = html;
  (globalThis as Any).CSS = { escape: (s: string) => s.replace(/[^\w-]/g, (c) => "\\" + c) };
  (globalThis as Any).getComputedStyle = (el: Any, pseudo?: string) =>
    pseudo !== undefined
      ? { pseudo }
      : {
          display: el.nodeName === "SPAN" ? "inline" : "block",
          position: el.getAttribute("data-pos") ?? "static",
          clipPath: "none",
          overflow: el.hasAttribute("data-clip") ? "hidden" : "visible",
          filter: "none",
          mask: "none",
          borderRadius: "0px",
          paddingTop: "1px",
          paddingBottom: "2px",
        };
});
afterEach(() => {
  delete (globalThis as Any).window;
  delete (globalThis as Any).document.documentElement;
  delete (globalThis as Any).CSS;
  delete (globalThis as Any).getComputedStyle;
  for (const k of [
    "addEventListener",
    "defaultView",
    "fonts",
    "documentElement",
    "startViewTransition",
    "__reactViewTransition",
  ])
    delete fakeDoc[k];
});

// Where an element is: down its siblings, as wide as its text, or as its data-* attributes say.
const rect = (el: Any) => {
  let i = 0;
  for (let n = el.previousSibling; n !== null; n = n.previousSibling) i++;
  const y = Number(el.getAttribute("data-y") ?? i * 20),
    width = Number(el.getAttribute("data-w") ?? el.textContent.length * 10),
    height = Number(el.getAttribute("data-h") ?? 20);
  return { x: 0, y, width, height, top: y, left: 0, bottom: y + height, right: width };
};
const proto = FakeElement.prototype as Any;
beforeAll(() => {
  proto.getBoundingClientRect = function (this: Any) {
    return rect(this);
  };
  proto.getClientRects = function (this: Any) {
    return this.hasAttribute("data-lines") ? [rect(this), { ...rect(this), width: 0 }, rect(this)] : [rect(this)];
  };
});
afterAll(() => {
  delete proto.getBoundingClientRect;
  delete proto.getClientRects;
});

// A style declaration that reads and writes the element's style attribute, as the DOM's reflects
// it, so the names show in the markup.
const styleOf = (el: FakeElement): Any => {
  const props = (): Map<string, string> => {
    const m = new Map<string, string>();
    for (const part of (el.getAttribute("style") ?? "").split(";")) {
      const at = part.indexOf(":");
      if (at > 0) m.set(part.slice(0, at), part.slice(at + 1));
    }
    return m;
  };
  const write = (k: string, v: string): void => {
    const m = props();
    if (v === "") m.delete(k);
    else m.set(k, v);
    el.setAttribute("style", [...m].map(([n, x]) => `${n}:${x}`).join(";"));
  };
  return new Proxy(
    {},
    {
      get: (_, k: string) =>
        k === "setProperty"
          ? (n: string, v: string, important?: string) => write(n, v + (important ? " !" + important : ""))
          : k === "removeProperty"
            ? (n: string) => write(n, "")
            : (props().get(k) ?? ""),
      set: (_, k: string, v: string) => (write(k, "" + v), true),
    },
  );
};
beforeAll(() =>
  Object.defineProperty(proto, "style", {
    configurable: true,
    get: function (this: FakeElement) {
      return styleOf(this);
    },
  }),
);
afterAll(() => void delete proto.style);

/** The markup of `n`'s children: tags lowercased, attributes in order, comments shown. */
function markup(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      // Style declarations sorted, and an empty style left out: React's passive phase clears names
      // on elements it never named, which leaves an empty style attribute, as compat does not.
      const attrs = c.attributes
        .filter((a) => a.name !== "style" || a.value !== "")
        .map((a) => ` ${a.name}="${a.name === "style" ? a.value.split(";").sort().join(";") : a.value}"`)
        .join("");
      out += `<${tag}${attrs}>${markup(c)}</${tag}>`;
    } else if (c.nodeType === 8) out += `<!--${(c as Any).data}-->`;
    else out += c.textContent;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a scene gets: its library, its log, its root and container. */
interface Kit {
  L: Lib;
  log: string[];
  root: Any;
  c: FakeElement;
  flushSync: (fn: () => void) => void;
  /** Writes the container's markup and <html>'s style to the log, after `label`. */
  snap: (label: string) => void;
  /** Gives the document a startViewTransition that logs, updates in a task, and is ready then. */
  api: (opts?: { reject?: boolean; finish?: number }) => void;
  /** Lets every timer and the view transitions run out. */
  settle: () => Promise<void>;
}

/** Runs `scene` with React and with compat and expects the same log. */
async function same(scene: (k: Kit) => Promise<void>): Promise<string[]> {
  const run = async (L: Lib, createRoot: (c: Any) => Any, flushSync: (fn: () => void) => void) => {
    const c = new FakeElement("DIV");
    c.isDocument = true;
    const log: string[] = [];
    animations = [];
    html.removeAttribute("style");
    const root = createRoot(c);
    const snap = (label: string) =>
      void log.push(`${label} ${markup(c)} | html ${html.getAttribute("style") ?? "-"}`, ...animations.splice(0));
    const k: Kit = {
      L,
      log,
      root,
      c,
      flushSync,
      snap,
      api({ reject = false, finish = 5 } = {}) {
        own(fakeDoc, "startViewTransition", ({ update, types }: Any) => {
          snap("start " + JSON.stringify(types));
          let ready!: () => void, fail!: (e: Any) => void, finished!: () => void;
          const t = {
            ready: new Promise<void>((r, j) => ((ready = r), (fail = j))),
            finished: new Promise<void>((r) => (finished = r)),
            skipTransition: () => void log.push("skip"),
          };
          setTimeout(() => {
            if (reject) {
              fail(
                Object.assign(new Error("Skipping view transition because viewport size changed."), {
                  name: "InvalidStateError",
                }),
              );
              setTimeout(finished, finish);
              return;
            }
            update();
            snap("updated");
            ready();
            setTimeout(finished, finish);
          }, 1);
          return t;
        });
      },
      settle: async () => {
        for (let i = 0; i < 8; i++) await sleep(5);
      },
    };
    await scene(k);
    await k.settle();
    snap("end");
    // Unmounted without the API: what React does with it there is not this test's.
    delete fakeDoc.startViewTransition;
    root.unmount();
    await k.settle();
    return log;
  };
  const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
  const compat = await run(Compat, (c) => Compat.createRoot(c as unknown as Element), Compat.flushSync);
  expect(compat).toEqual(react);
  return compat;
}

/** Event props that log, for a boundary named `label`; the update's cleanup logs too. */
const events = (log: string[], label: string) => ({
  onEnter: (i: Any, types: string[]) => void log.push(`${label} enter ${i.name} ${types}`),
  onExit: (i: Any, types: string[]) => void log.push(`${label} exit ${i.name} ${types}`),
  onShare: (i: Any, types: string[]) => void log.push(`${label} share ${i.name} ${types}`),
  onUpdate: (i: Any, types: string[]) => {
    log.push(`${label} update ${i.name} ${types}`);
    // The pseudo-elements an instance has.
    i.group.animate({ opacity: [0, 1] }, 100);
    i.old.animate({ opacity: [1, 0] }, { duration: 50 });
    log.push(
      `animations ${i.group.getAnimations().length} ${i.old.getAnimations().length} ${i.new.getComputedStyle().pseudo}`,
    );
    return () => void log.push(`${label} update over`);
  },
});

describe("view transitions", () => {
  test("an update, an enter, an exit and a shared name, with types and classes by type", () =>
    same(async ({ L, log, root, flushSync, snap, api, settle }) => {
      api();
      let set: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      function App() {
        const [s, setS] = L.useState({ text: "A", panel: false, hero: "a" });
        set = setS;
        L.useEffect(() => void log.push("effect " + JSON.stringify(s)));
        return h(
          "div",
          null,
          h(
            VT,
            { name: "title", update: { next: "slide", default: "fade" }, ...events(log, "title") },
            h("h1", null, s.text),
          ),
          s.panel
            ? h(
                VT,
                { name: "panel", default: "pop", ...events(log, "panel") },
                h("section", null, "panel"),
                h("p", null, "two"),
              )
            : null,
          s.hero === "a"
            ? h(VT, { name: "hero", ...events(log, "hero a") }, h("b", null, "a"))
            : h(
                "i",
                null,
                h(
                  VT,
                  { name: "hero", share: { next: "morph", default: "auto" }, ...events(log, "hero b") },
                  h("b", null, "b"),
                ),
              ),
          h(VT, { ...events(log, "auto") }, h("u", null, "auto")),
          h("em", null, s.text),
        );
      }
      flushSync(() => root.render(h(App)));
      L.startTransition(() => {
        L.addTransitionType("next");
        set((s: Any) => ({ ...s, text: "BB" }));
      });
      await settle();
      snap("updated");
      L.startTransition(() => set((s: Any) => ({ ...s, panel: true })));
      await settle();
      L.startTransition(() => set((s: Any) => ({ ...s, panel: false })));
      await settle();
      // addTransitionType outside a transition starts one of its own, and the next joins it.
      L.addTransitionType("next");
      L.startTransition(() => set((s: Any) => ({ ...s, hero: "b" })));
      await settle();
      // An urgent update starts none.
      flushSync(() => set((s: Any) => ({ ...s, text: "C" })));
      await settle();
    }));

  test("boundaries named none, out of view, inline, clipped, absolute and resized", () =>
    same(async ({ L, log, root, flushSync, snap, api, settle }) => {
      api();
      let set: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      function App() {
        const [n, setN] = L.useState(0);
        set = setN;
        return h(
          "div",
          null,
          h(VT, { name: "off", default: "none", enter: "none", exit: "none" }, h("p", null, "off " + n)),
          h(VT, { name: "far", ...events(log, "far") }, h("p", { "data-y": 5000 }, "far " + n)),
          h(
            VT,
            { name: "inline", ...events(log, "inline") },
            h("span", { style: n ? { marginTop: "3px", display: "inline" } : { margin: "1px" } }, "inline " + n),
            h("span", { "data-lines": "" }, "lines"),
            h("span", null, "plain"),
          ),
          h(VT, { name: "clip", ...events(log, "clip") }, h("p", { "data-clip": "" }, "clip")),
          h(VT, { name: "abs", ...events(log, "abs") }, h("p", { "data-pos": n ? "absolute" : "static" }, "abs")),
          h(VT, { name: "size", ...events(log, "size") }, h("p", { "data-h": 20 + n }, "size")),
          h(VT, { name: "same", ...events(log, "same") }, h("p", null, "same")),
          n === 2 ? null : h(VT, { name: "gone", exit: "none", ...events(log, "gone") }, h("p", null, "gone")),
          n === 1 ? h(VT, { name: "new", enter: "none", ...events(log, "new") }, h("p", null, "new")) : null,
          n === 1 ? h(VT, { name: "far new", ...events(log, "far new") }, h("p", { "data-y": 5000 }, "far")) : null,
        );
      }
      flushSync(() => root.render(h(App)));
      L.startTransition(() => set(1));
      await settle();
      L.startTransition(() => set(2));
      await settle();
      snap("after");
    }));

  test("a boundary in content an Activity hides and shows, and one in a list that moves", () =>
    same(async ({ L, log, root, flushSync, api, settle }) => {
      api();
      let set: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      function App() {
        const [s, setS] = L.useState({ mode: "visible", order: [1, 2] });
        set = setS;
        return h(
          "div",
          null,
          h(L.Activity, { mode: s.mode }, h(VT, { name: "act", ...events(log, "act") }, h("p", null, "activity"))),
          h(
            "ul",
            null,
            s.order.map((k: number) =>
              h(VT, { key: k, name: "row" + k, ...events(log, "row" + k) }, h("li", null, "row " + k)),
            ),
          ),
          h(
            VT,
            { name: "outer", ...events(log, "outer") },
            h("div", null, h(VT, { name: "inner", ...events(log, "inner") }, h("p", null, s.mode))),
          ),
        );
      }
      flushSync(() => root.render(h(App)));
      L.startTransition(() => set((s: Any) => ({ ...s, mode: "hidden" })));
      await settle();
      L.startTransition(() => set((s: Any) => ({ ...s, mode: "visible", order: [2, 1] })));
      await settle();
    }));

  test("pairs nested in what leaves and what enters, content that bails out, and boundaries that grow", () =>
    same(async ({ L, log, root, flushSync, api, settle }) => {
      api();
      let set: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      function Far() {
        return h("p", { "data-y": 5000 }, "far");
      }
      function Wrap({ children }: Any) {
        return children;
      }
      // The same element each render: it bails out, and what it holds did not change.
      const still = h(
        "section",
        null,
        h(VT, { name: "still", ...events(log, "still") }, h("p", null, "still")),
        h(Wrap, null, h(VT, { name: "wrapped still", ...events(log, "wrapped still") }, h("p", null, "still"))),
      );
      function App() {
        const [n, setN] = L.useState(0);
        set = setN;
        return h(
          "div",
          null,
          still,
          n === 0
            ? h(
                VT,
                { name: "box", ...events(log, "box") },
                h("div", null, h(VT, { name: "card", ...events(log, "card old") }, h("p", null, "card"))),
                h(VT, { name: "plain", share: "none", ...events(log, "plain old") }, h("p", null, "plain")),
                h(VT, { name: "far pair", ...events(log, "far pair old") }, h("p", { "data-y": 5000 }, "far pair")),
              )
            : null,
          n === 0 ? h("aside", null, "gone") : null,
          n === 0 ? h(VT, { name: "farx", ...events(log, "farx") }, h(Far)) : null,
          n === 1
            ? h(
                VT,
                { name: "wrap", ...events(log, "wrap") },
                h(VT, { name: "card", ...events(log, "card new") }, h("p", null, "card!")),
              )
            : null,
          n === 1 ? h(VT, { name: "plain", ...events(log, "plain new") }, h("p", null, "plain!")) : null,
          n === 1 ? h(VT, { name: "far pair", ...events(log, "far pair new") }, h("p", null, "far pair!")) : null,
          n === 1 ? h("div", null, h(VT, { name: "in div", ...events(log, "in div") }, h("p", null, "in"))) : null,
          n === 1 ? h("div", null, "plain div") : null,
          h(
            VT,
            { name: "grow", ...events(log, "grow") },
            h("p", null, "one"),
            n === 1 ? h("p", null, "two") : null,
            h(Wrap, null, h("p", null, "wrapped " + n)),
            h(VT, { name: "inner grow", ...events(log, "inner grow") }, h("p", { "data-h": 20 + n }, "inner")),
          ),
        );
      }
      flushSync(() => root.render(h(App)));
      L.startTransition(() => set(1));
      await settle();
    }));

  test("boundaries in a compiled template's holes", () =>
    same(async ({ L, log, root, flushSync, api, settle }) => {
      api();
      let set: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      // What @reactre/compat/compiler makes of <div><VT name="a"><p>{n}</p></VT>{...}</div>: a
      // template whose holes are slots; React gets the elements jsx() builds.
      const T: Any[] | null =
        L === Compat ? [Compat.__template(["div", 0, 0, 1]), Compat.__template(["p", 0, 0])] : null;
      const p = (n: string) => (T === null ? h("p", null, n) : Compat.__block(T[1], null, [n]));
      const box = (name: string, n: string) => h(VT, { name, ...events(log, name) }, p(n));
      function App() {
        const [n, setN] = L.useState(0);
        set = setN;
        const a = box("a", "a " + n),
          b = box("b", "b " + n);
        return T === null ? h("div", null, a, b) : Compat.__block(T[0], null, [a, b]);
      }
      flushSync(() => root.render(h(App)));
      L.startTransition(() => set(1));
      await settle();
    }));

  test("content a boundary reveals once its fallback's throttle ends", () =>
    same(async ({ L, log, root, flushSync, snap, api }) => {
      api();
      let resolve!: (v: string) => void;
      const data = new Promise<string>((r) => (resolve = r));
      let set: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      function Page() {
        return h("p", null, L.use(data));
      }
      function App() {
        const [show, setShow] = L.useState(false);
        set = setShow;
        return h(
          "div",
          null,
          h(
            L.Suspense,
            { fallback: h(VT, { name: "fallback", ...events(log, "fallback") }, h("i", null, "loading")) },
            show ? h(VT, { name: "page", ...events(log, "page") }, h(Page)) : null,
          ),
        );
      }
      flushSync(() => root.render(h(App)));
      // Shown at once, outside a transition: it suspends and its fallback shows.
      flushSync(() => set(true));
      snap("fallback");
      await sleep(20);
      resolve("data");
      await sleep(400);
      snap("revealed");
    }));

  test("with nothing a boundary holds changed, without the API, or with a view transition skipped, the transition commits", () =>
    same(async ({ L, log, root, flushSync, snap, api, settle }) => {
      let set: Any, setM: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      function M() {
        const [m, setMm] = L.useState(0);
        setM = setMm;
        return h("em", null, m);
      }
      function App() {
        const [n, setN] = L.useState(0);
        set = setN;
        L.useEffect(() => void log.push("effect " + n));
        // The boundary is inside an element: a change beside it names nothing (see holds).
        return h(
          "div",
          null,
          h("section", null, h("div", null, h(VT, { name: "box", ...events(log, "box") }, h("p", null, "n " + n)))),
          h(M),
        );
      }
      flushSync(() => root.render(h(App)));
      // Nothing a boundary holds changes: no view transition, with the API or without.
      api();
      L.startTransition(() => setM(1));
      await settle();
      delete fakeDoc.startViewTransition;
      L.startTransition(() => set(1));
      await settle();
      snap("no api");
      api({ reject: true });
      L.startTransition(() => set(2));
      await settle();
      snap("skipped");
    }));

  test("an update before the view transition's update commits it first; a transition while one runs waits for it", () =>
    same(async ({ L, log, root, flushSync, snap, api, settle }) => {
      api({ finish: 30 });
      let set: Any, setOther: Any;
      const h = L.createElement,
        VT = L.ViewTransition;
      function Other() {
        const [m, s] = L.useState(0);
        setOther = s;
        return h("b", null, "m " + m);
      }
      function App() {
        const [n, setN] = L.useState(0);
        set = setN;
        L.useEffect(() => void log.push("effect " + n));
        return h("div", null, h(VT, { name: "box", ...events(log, "box") }, h("p", null, "n " + n)), h(Other));
      }
      flushSync(() => root.render(h(App)));
      L.startTransition(() => set(1));
      await sleep(0);
      snap("started");
      // Before the update callback: React commits what waits first.
      flushSync(() => setOther(1));
      snap("urgent");
      await sleep(5);
      // While the view transition runs, another transition renders and waits for it to finish.
      L.startTransition(() => set(2));
      await sleep(5);
      snap("waiting");
      // An urgent update drops that render; the transition renders again after it.
      flushSync(() => setOther(2));
      await settle();
      await sleep(40);
      snap("done");
    }));
});
