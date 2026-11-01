// Ports of Solid 2.0's tests of <Portal>, <Dynamic> and dynamic(), from
// packages/web/test/portal.spec.tsx and packages/web/test/dynamic.spec.tsx; solid-js 2.0.0-rc.20
// (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato;
// the license is in ./harness.ts.
//
// Solid mounts with `render`, which returns a disposer: reactre's is `attach`. Solid makes some
// components in a createRoot and keeps their <div> by ref; a port mounts them with `attach` and
// keeps the <div> by a ref function. `innerHTML` is `html()`, and `el.click()` dispatches a click,
// which the fake DOM lacks. The fake document has no body, head or createElementNS: this file
// gives it them for its own tests, as ../flow.test.ts does.
//
// Not ported: Solid's `_$host` assertions (a field of its event retargeting, which the delegated
// event tests cover), the insert-ownership test (Solid's diagnostics), and dynamic()'s async
// source (async boundaries are ported in their own file).

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeElement, FakeEvent, type FakeNode, installFakeDocument } from "@reactre/testdom";

import { flush } from "../../src/features/timing.ts";
import { base, compile, gap } from "./harness.ts";

const SVG = "http://www.w3.org/2000/svg";

// One page for the file: Solid's describes keep what one test mounted for the next.
const page = new FakeElement("HTML"),
  head = new FakeElement("HEAD"),
  body = new FakeElement("BODY");
page.isDocument = true;
page.appendChild(head);
page.appendChild(body);

beforeEach(() => {
  installFakeDocument();
  Object.assign(globalThis.document, {
    body,
    head,
    createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  });
});
afterAll(installFakeDocument);

// oxlint-disable-next-line no-explicit-any
type Api = Record<string, any>;

/** Compile and run a source ending in `return { ... }`, with `scope`'s names in scope. */
const run = (src: string, scope: Record<string, unknown> = {}): Api => compile<Api>(src, base, scope);

/** A fresh element of the fake document, as `document.createElement`. */
const el = (tag: string): FakeElement => new FakeElement(tag.toUpperCase());

/** `innerHTML`: elements with their attributes, and text; comments (markers) left out. */
function html(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.namespaceURI === SVG ? c.tagName : c.tagName.toLowerCase();
      const attrs = c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
      out += `<${tag}${attrs}>${html(c)}</${tag}>`;
    } else if (c.nodeType === 3) out += c.textContent;
  }
  return out;
}

/** The elements under `n` of tag `tag`, in document order (`querySelectorAll`). */
function all(n: FakeNode, tag: string, out: FakeElement[] = []): FakeElement[] {
  for (let c = n.firstChild; c !== null; c = c.nextSibling)
    if (c instanceof FakeElement) {
      if (c.tagName.toLowerCase() === tag) out.push(c);
      all(c, tag, out);
    }
  return out;
}

const click = (n: unknown): void => void (n as FakeElement).dispatchEvent(new FakeEvent("click"));

// #region portal.spec.tsx

describe("Testing a simple Portal", () => {
  const div = el("div"),
    testMount = el("div");
  let t: Api;
  test("Create portal control flow", () => {
    t = run(
      `
      import { attach, Portal } from "@reactre/core";
      const Component = () => <Portal mount={testMount}>Hi</Portal>;
      return { dispose: attach(Component, div) };
      `,
      { div, testMount },
    );
    expect(html(div)).toBe("");
    expect(html(testMount)).toBe("Hi");
  });

  test("dispose", () => {
    t["dispose"]();
    expect(html(div)).toBe("");
  });
});

describe("Testing an SVG Portal", () => {
  const div = el("div"),
    testMount = new FakeElement("svg", SVG);
  let t: Api;
  test("Create portal control flow", () => {
    t = run(
      `
      import { attach, Portal } from "@reactre/core";
      const Component = () => <Portal mount={testMount}>Hi</Portal>;
      return { dispose: attach(Component, div) };
      `,
      { div, testMount },
    );
    expect(html(div)).toBe("");
    expect(html(testMount)).toBe("Hi");
  });

  test("dispose", () => t["dispose"]());
});

describe("Testing Portal delegated event containers", () => {
  const why = "the click reaches the portal's handler, not the <section>'s";

  gap("portal-events", why, "default body portal from an app root bubbles through the logical tree", () => {
    const root = el("div");
    body.appendChild(root);
    const t = run(
      `
      import { attach, Portal } from "@reactre/core";
      const calls = [];
      let portalButton;
      const dispose = attach(
        () => (
          <section onClick={() => calls.push("logical")}>
            <Portal>
              <button ref={(b) => (portalButton = b)} onClick={() => calls.push("portal")} />
            </Portal>
          </section>
        ),
        root,
      );
      return { calls, button: () => portalButton, dispose };
      `,
      { root },
    );
    click(t["button"]());
    expect(t["calls"]).toEqual(["portal", "logical"]);
    t["dispose"]();
  });

  gap("portal-events", why, "outside-root portal delegated events bubble through the logical tree", () => {
    const root = el("div"),
      mount = el("div");
    body.appendChild(root);
    body.appendChild(mount);
    const t = run(
      `
      import { attach, Portal } from "@reactre/core";
      const calls = [];
      let portalButton;
      const dispose = attach(
        () => (
          <section onClick={() => calls.push("logical")}>
            <Portal mount={mount}>
              <button ref={(b) => (portalButton = b)} onClick={() => calls.push("portal")} />
            </Portal>
          </section>
        ),
        root,
      );
      return { calls, button: () => portalButton, dispose };
      `,
      { root, mount },
    );
    click(t["button"]());
    expect(t["calls"]).toEqual(["portal", "logical"]);
    t["dispose"]();
  });

  gap(
    "portal-events",
    why,
    "delegated event targeting the render root itself does not crash with a body portal (#3008)",
    () => {
      const root = el("div");
      body.appendChild(root);
      const t = run(
        `
        import { attach, Portal } from "@reactre/core";
        const calls = [];
        let portalButton;
        const dispose = attach(
          () => (
            <section onClick={() => calls.push("logical")}>
              <Portal>
                <button ref={(b) => (portalButton = b)} onClick={() => calls.push("portal")} />
              </Portal>
            </section>
          ),
          root,
        );
        return { calls, button: () => portalButton, dispose };
        `,
        { root },
      );
      expect(() => click(root)).not.toThrow();
      expect(t["calls"]).toEqual([]);
      click(t["button"]());
      expect(t["calls"]).toEqual(["portal", "logical"]);
      t["dispose"]();
    },
  );

  test("inside-root portal mounts do not install extra delegated listeners", () => {
    const root = el("div"),
      mount = el("div");
    const add = mock(mount.addEventListener.bind(mount));
    mount.addEventListener = add;
    root.appendChild(mount);
    body.appendChild(root);
    const t = run(
      `
      import { attach, Portal } from "@reactre/core";
      let calls = 0;
      let portalButton;
      const dispose = attach(
        () => (
          <Portal mount={mount}>
            <button ref={(b) => (portalButton = b)} onClick={() => calls++} />
          </Portal>
        ),
        root,
      );
      return { calls: () => calls, button: () => portalButton, dispose };
      `,
      { root, mount },
    );
    click(t["button"]());
    expect(t["calls"]()).toBe(1);
    expect(add).not.toHaveBeenCalledWith("click", expect.any(Function));
    t["dispose"]();
  });
});

describe("Testing Portal mount ref timing", () => {
  test("mounts into an earlier sibling ref", () => {
    const root = el("div");
    body.appendChild(root);
    const t = run(
      `
      import { attach, Portal } from "@reactre/core";
      let mount, portalButton;
      const dispose = attach(
        () => (
          <>
            <div ref={(d) => (mount = d)} />
            <Portal mount={mount}>
              <button ref={(b) => (portalButton = b)}>Portal button</button>
            </Portal>
          </>
        ),
        root,
      );
      return { mount: () => mount, button: () => portalButton, dispose };
      `,
      { root },
    );
    expect(html(root)).toBe("<div><button>Portal button</button></div>");
    expect(t["button"]().parentNode).toBe(t["mount"]());
    expect(t["button"]().textContent).toBe("Portal button");
    t["dispose"]();
  });

  test("preserves child ref timing for default body portals", () => {
    const root = el("div");
    body.appendChild(root);
    const t = run(
      `
      import { attach, Portal } from "@reactre/core";
      let portalButton;
      const dispose = attach(
        () => (
          <Portal>
            <button ref={(b) => (portalButton = b)}>Ready</button>
          </Portal>
        ),
        root,
      );
      return { button: () => portalButton, dispose };
      `,
      { root },
    );
    expect(t["button"]()).toBeInstanceOf(FakeElement);
    expect(t["button"]().tagName).toBe("BUTTON");
    expect(t["button"]().parentNode).toBe(body);
    t["dispose"]();
  });

  gap(
    "portal-events",
    "the click reaches the portal's handler, not the <section>'s",
    "delegated events bubble through logical tree with an earlier sibling mount ref",
    () => {
      const root = el("div");
      body.appendChild(root);
      const t = run(
        `
        import { attach, Portal } from "@reactre/core";
        const calls = [];
        let mount, portalButton;
        const dispose = attach(
          () => (
            <section onClick={() => calls.push("logical")}>
              <div ref={(d) => (mount = d)} />
              <Portal mount={mount}>
                <button ref={(b) => (portalButton = b)} onClick={() => calls.push("portal")} />
              </Portal>
            </section>
          ),
          root,
        );
        return { calls, button: () => portalButton, dispose };
        `,
        { root },
      );
      click(t["button"]());
      expect(t["calls"]).toEqual(["portal", "logical"]);
      t["dispose"]();
    },
  );
});

describe("Testing a Portal to the head", () => {
  const div = el("div");
  let t: Api;
  test("Create portal control flow", () => {
    t = run(
      `
      import { attach, Portal, Show, signal } from "@reactre/core";
      const [s, set] = signal("A Meaningful Page Title"),
        [visible, setVisible] = signal(true);
      const Component = () => (
        <Show when={visible()}>
          <Portal mount={document.head}>
            <title>{s()}</title>
          </Portal>
        </Show>
      );
      return { set, setVisible, dispose: attach(Component, div) };
      `,
      { div },
    );
    expect(html(div)).toBe("");
    expect(html(head)).toBe("<title>A Meaningful Page Title</title>");
  });

  test("Update title text", () => {
    t["set"]("A New Better Page Title");
    flush();
    expect(html(head)).toBe("<title>A New Better Page Title</title>");
  });

  test("Hide Portal", () => {
    t["setVisible"](false);
    flush();
    expect(html(head)).toBe("");
    t["setVisible"](true);
    flush();
    expect(html(head)).toBe("<title>A New Better Page Title</title>");
  });

  test("dispose", () => {
    expect(html(head)).toBe("<title>A New Better Page Title</title>");
    t["dispose"]();
    expect(html(head)).toBe("");
  });
});

describe("Testing a Portal with Synthetic Events", () => {
  const div = el("div");
  let t: Api;
  test("Create portal control flow", () => {
    t = run(
      `
      import { attach, Portal } from "@reactre/core";
      let testElem;
      let clicked = false;
      const Component = () => (
        <Portal>
          <div ref={(d) => (testElem = d)} onClick={(e) => (clicked = true)} />
        </Portal>
      );
      return { elem: () => testElem, clicked: () => clicked, dispose: attach(Component, div) };
      `,
      { div },
    );
    expect(html(div)).toBe("");
  });

  test("Test portal element clicked", () => {
    expect(t["clicked"]()).toBe(false);
    click(t["elem"]());
    expect(t["clicked"]()).toBe(true);
  });

  test("dispose", () => t["dispose"]());
});

describe("Testing Portal content swapping (#2757)", () => {
  test("keyed Show swaps replace content instead of accumulating", () => {
    const div = el("div"),
      mount = el("div");
    const t = run(
      `
      import { attach, Portal, Show, signal } from "@reactre/core";
      const [key, setKey] = signal(1);
      const dispose = attach(
        () => (
          <Portal mount={mount}>
            <Show keyed when={key()}>
              {(k) => <span>content for key {k}</span>}
            </Show>
          </Portal>
        ),
        div,
      );
      return { setKey, dispose };
      `,
      { div, mount },
    );
    expect(all(mount, "span").length).toBe(1);
    expect(all(mount, "span")[0]!.textContent).toBe("content for key 1");
    for (let i = 2; i <= 4; i++) {
      t["setKey"](i);
      flush();
      expect(all(mount, "span").length).toBe(1);
      expect(all(mount, "span")[0]!.textContent).toBe(`content for key ${i}`);
    }
    t["dispose"]();
    expect(html(mount)).toBe("");
  });

  test("two portals sharing a mount stay isolated", () => {
    const div = el("div"),
      mount = el("div");
    const t = run(
      `
      import { attach, Portal, Show, signal } from "@reactre/core";
      const [key, setKey] = signal(1);
      const dispose = attach(
        () => (
          <>
            <Portal mount={mount}>
              <Show keyed when={key()}>
                {(k) => <span>swapping {k}</span>}
              </Show>
            </Portal>
            <Portal mount={mount}>
              <b>stable</b>
            </Portal>
          </>
        ),
        div,
      );
      return { setKey, dispose };
      `,
      { div, mount },
    );
    expect(all(mount, "span").length).toBe(1);
    expect(all(mount, "b").length).toBe(1);
    t["setKey"](2);
    flush();
    expect(all(mount, "span").length).toBe(1);
    expect(all(mount, "span")[0]!.textContent).toBe("swapping 2");
    expect(all(mount, "b").length).toBe(1);
    expect(all(mount, "b")[0]!.textContent).toBe("stable");
    t["dispose"]();
    expect(html(mount)).toBe("");
  });

  gap(
    "portal-events",
    "the click reaches the portal's handler, not the <section>'s",
    "delegated events retarget through nodes inserted by swaps",
    () => {
      const root = el("div"),
        mount = el("div");
      body.appendChild(root);
      body.appendChild(mount);
      const t = run(
        `
        import { attach, Portal, Show, signal } from "@reactre/core";
        const calls = [];
        const [key, setKey] = signal(1);
        let portalButton;
        const dispose = attach(
          () => (
            <section onClick={() => calls.push("logical")}>
              <Portal mount={mount}>
                <Show keyed when={key()}>
                  {(k) => <button ref={(b) => (portalButton = b)} onClick={() => calls.push("portal " + k)} />}
                </Show>
              </Portal>
            </section>
          ),
          root,
        );
        return { calls, setKey, button: () => portalButton, dispose };
        `,
        { root, mount },
      );
      click(t["button"]());
      expect(t["calls"]).toEqual(["portal 1", "logical"]);
      t["calls"].length = 0;
      t["setKey"](2);
      flush();
      click(t["button"]());
      expect(t["calls"]).toEqual(["portal 2", "logical"]);
      t["dispose"]();
    },
  );
});

// #endregion

// #region dynamic.spec.tsx

/** dynamic.spec.tsx's components of `{ id }`. */
const comps = `
  const CompA = (props) => <div>Hi {props.id}</div>,
    CompB = (props) => <span>Yo {props.id}</span>;
`;

describe("Testing Dynamic control flow", () => {
  let t: Api;
  beforeEach(() => {
    t = run(
      `
      import { attach, Dynamic, signal } from "@reactre/core";
      ${comps}
      const [comp, setComp] = signal(undefined),
        [name, setName] = signal("Smith");
      let div;
      const Component = () => (
        <div ref={(d) => (div = d)}>
          <Dynamic component={comp()} id={name()} />
        </div>
      );
      return { CompA, CompB, setComp, setName, div: () => div, dispose: attach(Component, root) };
    `,
      { root: el("div") },
    );
    flush();
  });

  test("Toggle Dynamic control flow", () => {
    const div = (): FakeElement => t["div"]();
    expect(html(div())).toBe("");
    t["setComp"](() => t["CompA"]);
    flush();
    expect(html(div())).toBe("<div>Hi Smith</div>");
    t["setName"]("Smithers");
    flush();
    expect(html(div())).toBe("<div>Hi Smithers</div>");
    t["setComp"](() => t["CompB"]);
    flush();
    expect(html(div())).toBe("<span>Yo Smithers</span>");
    t["setComp"]("h1");
    flush();
    expect(html(div())).toBe(`<h1 id="Smithers"></h1>`);
    t["setName"]("Sunny");
    flush();
    expect(html(div())).toBe(`<h1 id="Sunny"></h1>`);
    expect(all(div(), "h1")[0]).toBeInstanceOf(FakeElement);
    t["dispose"]();
  });

  gap("dynamic-svg", '"svg" and "path" become HTML elements', "Renders SVG elements", () => {
    const div = (): FakeElement => t["div"]();
    t["setComp"]("svg");
    flush();
    expect(all(div(), "svg")[0]?.namespaceURI).toBe(SVG);
    t["setComp"]("path");
    flush();
    expect(all(div(), "path")[0]?.namespaceURI).toBe(SVG);
    t["dispose"]();
  });
});

describe("Dynamic intrinsic elements are created eagerly (#3291)", () => {
  test("a signal written from a Dynamic ref inside a Portal wakes a tracked effect", () => {
    const t = run(
      `
      import { attach, Dynamic, effect, Portal, signal } from "@reactre/core";
      const Wrapper = (props) => <Dynamic {...props} component="div" />;
      const [el, setEl] = signal(undefined);
      const seen = [];
      const dispose = attach(() => {
        effect(() => {
          seen.push(!!el());
        });
        return (
          <Portal>
            <Wrapper ref={setEl} />
          </Portal>
        );
      }, root);
      return { el, seen, dispose };
      `,
      { root: el("div") },
    );
    flush();
    expect(t["el"]()).toBeInstanceOf(FakeElement);
    expect(t["el"]().tagName).toBe("DIV");
    expect(t["seen"]).toContain(true);
    t["dispose"]();
  });
});

describe("Testing Dynamic with state spread", () => {
  let t: Api;
  beforeEach(() => {
    t = run(
      `
      import { attach, Dynamic, signal } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      ${comps}
      const [comp, setComp] = signal(undefined),
        [state, setState] = createStore({ id: "Smith" });
      let div;
      const Component = () => (
        <div ref={(d) => (div = d)}>
          <Dynamic component={comp()} {...state} />
        </div>
      );
      return { CompA, CompB, setComp, setState, div: () => div, dispose: attach(Component, root) };
    `,
      { root: el("div") },
    );
  });

  gap("store-spread", "CompA's props.id stays Smith", "Toggle Dynamic control flow", () => {
    const div = (): FakeElement => t["div"]();
    expect(html(div())).toBe("");
    t["setComp"](() => t["CompA"]);
    flush();
    expect(html(div())).toBe("<div>Hi Smith</div>");
    t["setState"]((s: { id: string }) => {
      s.id = "Smithers";
    });
    flush();
    expect(html(div())).toBe("<div>Hi Smithers</div>");
    t["setComp"](() => t["CompB"]);
    flush();
    expect(html(div())).toBe("<span>Yo Smithers</span>");
    t["setComp"]("h1");
    flush();
    expect(html(div())).toBe(`<h1 id="Smithers"></h1>`);
    t["setState"]((s: { id: string }) => {
      s.id = "Sunny";
    });
    flush();
    expect(html(div())).toBe(`<h1 id="Sunny"></h1>`);
    t["dispose"]();
  });
});

describe("Dynamic intrinsic child granularity", () => {
  test("does not rerun unrelated child slots for intrinsic strings", () => {
    const rendered = mock(() => undefined);
    const t = run(
      `
      import { attach, Dynamic, Show, signal } from "@reactre/core";
      const [show, setShow] = signal(true);
      let div;
      const dispose = attach(
        () => (
          <div ref={(d) => (div = d)}>
            <Dynamic component="div">
              <button />
              {rendered()}
              <Show when={show()}>{show() ? "hide" : "show"}</Show>
            </Dynamic>
          </div>
        ),
        root,
      );
      return { setShow, div: () => div, dispose };
      `,
      { root: el("div"), rendered },
    );
    flush();
    expect(rendered).toHaveBeenCalledTimes(1);
    expect(html(t["div"]())).toBe("<div><button></button>hide</div>");
    t["setShow"](false);
    flush();
    expect(rendered).toHaveBeenCalledTimes(1);
    expect(html(t["div"]())).toBe("<div><button></button></div>");
    t["dispose"]();
  });

  gap("array-text", '["a", "b"] shows as "a,b"', "keeps raw array children reactive", () => {
    const t = run(
      `
      import { attach, Dynamic, signal } from "@reactre/core";
      const [list, setList] = signal(["a", "b"]);
      let div;
      const dispose = attach(
        () => (
          <div ref={(d) => (div = d)}>
            <Dynamic component="div">{list()}</Dynamic>
          </div>
        ),
        root,
      );
      return { setList, div: () => div, dispose };
      `,
      { root: el("div") },
    );
    flush();
    expect(html(t["div"]())).toBe("<div>ab</div>");
    t["setList"](["x"]);
    flush();
    expect(html(t["div"]())).toBe("<div>x</div>");
    t["dispose"]();
  });
});

describe("dynamic factory", () => {
  test("returns a stable Component usable directly in JSX with children", () => {
    const t = run(
      `
      import { attach } from "@reactre/core";
      import { dynamic } from "@reactre/core/features/dynamic";
      const CompA = (props) => <div>Hi {props.children}</div>;
      const User = dynamic(() => CompA);
      let div;
      const dispose = attach(
        () => (
          <div ref={(d) => (div = d)}>
            <User>Smith</User>
          </div>
        ),
        root,
      );
      return { User, div: () => div, dispose };
      `,
      { root: el("div") },
    );
    expect(typeof t["User"]).toBe("function");
    flush();
    expect(html(t["div"]())).toBe("<div>Hi Smith</div>");
    t["dispose"]();
  });

  test("swaps component reactively from a signal source", () => {
    const t = run(
      `
      import { attach, signal } from "@reactre/core";
      import { dynamic } from "@reactre/core/features/dynamic";
      const CompA = (props) => <div>A {props.id}</div>;
      const CompB = (props) => <span>B {props.id}</span>;
      const [comp, setComp] = signal(undefined);
      const User = dynamic(() => comp() ?? CompA);
      let div;
      const dispose = attach(
        () => (
          <div ref={(d) => (div = d)}>
            <User id="x" />
          </div>
        ),
        root,
      );
      return { CompB, setComp, div: () => div, dispose };
      `,
      { root: el("div") },
    );
    flush();
    expect(html(t["div"]())).toBe("<div>A x</div>");
    t["setComp"](() => t["CompB"]);
    flush();
    expect(html(t["div"]())).toBe("<span>B x</span>");
    t["dispose"]();
  });

  test("component identity is stable across renders", () => {
    const t = run(`
      import { dynamic } from "@reactre/core/features/dynamic";
      const CompA = () => <div>A</div>;
      const User1 = dynamic(() => CompA);
      const User2 = dynamic(() => CompA);
      return { User1, User2 };
    `);
    expect(t["User1"]).toBe(t["User1"]);
    expect(t["User1"]).not.toBe(t["User2"]);
  });

  test("supports string tags through the factory", () => {
    const t = run(
      `
      import { attach, signal } from "@reactre/core";
      import { dynamic } from "@reactre/core/features/dynamic";
      const [tag, setTag] = signal("div");
      const El = dynamic(() => tag());
      let div;
      const dispose = attach(
        () => (
          <div ref={(d) => (div = d)}>
            <El>hi</El>
          </div>
        ),
        root,
      );
      return { setTag, div: () => div, dispose };
      `,
      { root: el("div") },
    );
    flush();
    expect(html(t["div"]())).toBe("<div>hi</div>");
    t["setTag"]("span");
    flush();
    expect(html(t["div"]())).toBe("<span>hi</span>");
    t["dispose"]();
  });

  test("renders nothing when source returns null, false, or undefined, and swaps back", () => {
    const t = run(
      `
      import { attach, signal } from "@reactre/core";
      import { dynamic } from "@reactre/core/features/dynamic";
      const CompA = () => <div>A</div>;
      const [comp, setComp] = signal(undefined);
      const User = dynamic(() => comp());
      let div;
      const dispose = attach(
        () => (
          <div ref={(d) => (div = d)}>
            <User />
          </div>
        ),
        root,
      );
      return { CompA, setComp, div: () => div, dispose };
      `,
      { root: el("div") },
    );
    const view = (): string => html(t["div"]());
    flush();
    expect(view()).toBe("");
    for (const nothing of [null, false, undefined]) {
      t["setComp"](() => t["CompA"]);
      flush();
      expect(view()).toBe("<div>A</div>");
      t["setComp"](nothing);
      flush();
      expect(view()).toBe("");
    }
    t["dispose"]();
  });
});

// #endregion
