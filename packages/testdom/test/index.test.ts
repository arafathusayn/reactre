// Unit tests for the fake DOM's own behaviour where the packages' tests do not reach it: the base
// node's defaults, fragments, comments, the read-only className of SVG elements, removing
// attribute nodes, and the phases of a dispatched event.

import { describe, expect, test } from "bun:test";

import { FakeComment, FakeElement, FakeEvent, FakeFragment, FakeNode, FakeText, SVG_NS } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: listeners and handler properties are read untyped.
type Any = any;

describe("nodes", () => {
  test("a base node has a generic name, no value to set, and no clone of its own", () => {
    const n = new FakeNode(1);
    expect(n.nodeName).toBe("#node");
    n.nodeValue = "x";
    expect(n.nodeValue).toBeNull();
    expect(() => n.cloneNode()).toThrow("abstract");
  });

  test("a fragment is named as the DOM names one", () => {
    expect(new FakeFragment().nodeName).toBe("#document-fragment");
  });

  test("a comment holds its value as data and adds no text to its parent", () => {
    const c = new FakeComment("a");
    expect([c.nodeType, c.nodeName, c.nodeValue]).toEqual([8, "#comment", "a"]);
    c.nodeValue = "b";
    expect(c.data).toBe("b");
    c.nodeValue = null;
    expect(c.data).toBe("");
    const p = new FakeElement("P");
    p.appendChild(new FakeText("t"));
    p.appendChild(new FakeComment("hidden"));
    expect(p.textContent).toBe("t");
    const copy = c.cloneNode();
    expect(copy).not.toBe(c);
    expect(copy.data).toBe(c.data);
  });
});

describe("elements", () => {
  test("className is read-only on an SVG element, as in the browser's strict mode", () => {
    const svg = new FakeElement("circle", SVG_NS);
    expect(() => (svg.className = "c")).toThrow(TypeError);
    const div = new FakeElement("DIV");
    div.className = "c";
    expect(div.getAttribute("class")).toBe("c");
  });

  test("removeAttributeNode removes an entry of attributes, and the entry from that array, as from a live map", () => {
    const div = new FakeElement("DIV");
    div.className = "c";
    div.setAttribute("id", "i");
    const list = div.attributes;
    while (list.length) div.removeAttributeNode(list[0]!);
    expect(div.attributes).toEqual([]);
    // An entry of an older array: the attribute goes, the newest array stays as it was.
    div.setAttribute("id", "i");
    const old = div.attributes;
    div.setAttribute("title", "t");
    const now = div.attributes;
    div.removeAttributeNode(old[0]!);
    expect(div.hasAttribute("id")).toBe(false);
    expect(now.map((a) => a.name)).toEqual(["id", "title"]);
  });
});

describe("events", () => {
  /** A list of elements, outermost first: each the parent of the next. */
  const chain = (...tags: string[]): FakeElement[] => {
    const els = tags.map((t) => new FakeElement(t));
    for (let i = 1; i < els.length; i++) els[i - 1]!.appendChild(els[i]!);
    return els;
  };

  test("an event runs the capture listeners top down, the target's, then the bubble ones and on<type> up", () => {
    const [a, b, c] = chain("A", "B", "C");
    const log: string[] = [];
    const add = (el: FakeElement, capture: boolean | { capture?: boolean } | undefined, name: string) =>
      el.addEventListener(
        "x",
        (e: Any) => void log.push(`${name} ${e.eventPhase} ${e.currentTarget.tagName}`),
        capture,
      );
    add(a!, true, "a capture");
    add(a!, undefined, "a bubble");
    add(b!, { capture: true }, "b capture");
    add(b!, {}, "b bubble");
    add(c!, false, "c bubble");
    add(c!, true, "c capture");
    (a as Any).onx = () => void log.push("a onx");
    const e = new FakeEvent("x");
    expect(c!.dispatchEvent(e)).toBe(true);
    expect(log).toEqual([
      "a capture 1 A",
      "b capture 1 B",
      "c capture 2 C",
      "c bubble 2 C",
      "b bubble 3 B",
      "a bubble 3 A",
      "a onx",
    ]);
    expect([e.target, e.currentTarget, e.eventPhase]).toEqual([c!, null, 0]);
  });

  test("a listener added twice runs once, a removed one not at all, and stopping ends the dispatch", () => {
    const [a, b] = chain("A", "B");
    const log: string[] = [];
    const fn = () => void log.push("a");
    a!.addEventListener("x", fn);
    a!.addEventListener("x", fn);
    a!.addEventListener("x", fn, true);
    a!.removeEventListener("x", fn, true);
    a!.removeEventListener("y", fn);
    b!.dispatchEvent(new FakeEvent("x"));
    expect(log).toEqual(["a"]);
    a!.removeEventListener("x", fn);
    b!.dispatchEvent(new FakeEvent("x"));
    expect(log).toEqual(["a"]);
    // stopPropagation lets the element's other listeners run; stopImmediatePropagation does not,
    // nor its on<type> property.
    b!.addEventListener("x", (e: Any) => (log.push("b1"), e.stopPropagation()));
    b!.addEventListener("x", () => void log.push("b2"));
    a!.addEventListener("x", fn);
    b!.dispatchEvent(new FakeEvent("x"));
    expect(log).toEqual(["a", "b1", "b2"]);
    const [c, d] = chain("C", "D");
    d!.addEventListener("x", (e: Any) => (log.push("d1"), e.stopImmediatePropagation()));
    d!.addEventListener("x", () => void log.push("d2"));
    (d as Any).onx = () => void log.push("d onx");
    c!.addEventListener("x", () => void log.push("c"));
    d!.dispatchEvent(new FakeEvent("x"));
    expect(log).toEqual(["a", "b1", "b2", "d1"]);
  });

  test("an event made from another takes its pointer and related element, and nothing of its dispatch", () => {
    const [a] = chain("A");
    const first = new FakeEvent("pointerover", { pointerId: 3, relatedTarget: a! });
    a!.dispatchEvent(first);
    const copy = new FakeEvent(first.type, first);
    expect([copy.pointerId, copy.relatedTarget, copy.target, copy.eventPhase]).toEqual([3, a!, null, 0]);
    expect(new FakeEvent("x").pointerId).toBeUndefined();
  });
});
