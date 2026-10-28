// Class components, which the class build (@reactre/compat/classes)
// adds to @reactre/compat. Importing it installs class support for
// every test in the process, so class tests live here.
//
// Covered: setState merging and callbacks with componentDidUpdate, and an error boundary's
// fallback with getDerivedStateFromError and componentDidCatch.

import { beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import { Component, createElement as h, createRoot, flushSync, type Root } from "../src/classes.ts";

let container: FakeElement;
let root: Root;

beforeEach(() => {
  installFakeDocument();
  // A container "in the document", so moves can keep state (moveBefore).
  container = new FakeElement("DIV");
  container.isDocument = true;
  root = createRoot(container as unknown as Element);
});

// The rendered markup, tags lowercased, without attributes.
const html = (n: FakeElement | null = container): string => {
  if (n === null) return "";
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) out += `<${c.tagName.toLowerCase()}>${html(c)}</${c.tagName.toLowerCase()}>`;
    else out += c.textContent;
  }
  return out;
};
const render = (el: unknown): void => flushSync(() => root.render(el));

describe("class components", () => {
  test("setState merges state and runs its callback after the render", () => {
    const log: string[] = [];
    let inst!: Counter;
    class Counter extends Component<object, { n: number; label: string }> {
      override state = { n: 0, label: "n" };
      override componentDidUpdate() {
        log.push("did update " + this.state.n);
      }
      override render() {
        inst = this;
        return h("b", null, this.state.label, this.state.n);
      }
    }
    render(h(Counter));
    // The updater returns only `n`: `label` must survive the merge.
    flushSync(() =>
      inst.setState(
        (s: { n: number }) => ({ n: s.n + 1 }),
        () => log.push("callback"),
      ),
    );
    expect(html()).toBe("<b>n1</b>");
    expect(log).toEqual(["did update 1", "callback"]);
  });
});

describe("error boundaries", () => {
  test("a boundary replaces a throwing subtree with its fallback", () => {
    const caught: string[] = [];
    class Boundary extends Component<{ children?: unknown }, { error: string | null }> {
      override state = { error: null as string | null };
      static getDerivedStateFromError(e: Error) {
        return { error: e.message };
      }
      override componentDidCatch(e: Error) {
        caught.push(e.message);
      }
      override render() {
        return this.state.error !== null ? h("p", null, "error: " + this.state.error) : (this.props.children as never);
      }
    }
    function Bomb(): never {
      throw new Error("boom");
    }
    // With no onCaughtError option, the root logs the caught error; keep the test output clean.
    const quiet = console.error;
    console.error = () => {};
    try {
      render(h("div", null, h(Boundary, null, h("span", null, "ok"), h(Bomb))));
    } finally {
      console.error = quiet;
    }
    expect(html()).toBe("<div><p>error: boom</p></div>");
    expect(caught).toEqual(["boom"]);
  });
});

describe("packaging", () => {
  // The class build works by side effect: importing it installs class support. A bundler that
  // trusts a blanket "sideEffects": false follows its re-exports to the main module and drops
  // the install (Vite's Rolldown does), so the manifest must name it.
  test("the class build is declared as having side effects", async () => {
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { sideEffects: unknown };
    expect(manifest.sideEffects).toEqual(["./src/classes.ts", "./dist/classes.js"]);
  });
});
