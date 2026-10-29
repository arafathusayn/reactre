// Unit tests for the fake DOM's own behaviour where the packages' tests do not reach it: the base
// node's defaults, fragments, comments and the read-only className of SVG elements.

import { describe, expect, test } from "bun:test";

import { FakeComment, FakeElement, FakeFragment, FakeNode, FakeText, SVG_NS } from "../src/index.ts";

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
});
