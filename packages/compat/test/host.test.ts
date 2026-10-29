// Unit tests for host elements in @reactre/compat, on the fake DOM with the few browser features
// these rules read added locally (see "A richer fake DOM").
//
// Covered here: the namespace an element is created in, document metadata hoisted to <head>,
// raw HTML and text-only content, attributes (aliases, booleans, the XLink and XML namespaces,
// custom element properties, function actions), styles, the form fields' value, checked and
// default props by React's rules, hydration claiming the server's elements, controlled fields
// shown their props again after an event, and function form actions on submit.
//
// Where compat differs from React 19 the case is a test.todo naming React's behavior.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeEvent, FakeText, HTML_NS, installFakeDocument, SVG_NS } from "@reactre/testdom";

import { createElement as h, createRoot, flushSync, hydrateRoot, type Root, useState } from "../src/index.ts";

// #region A richer fake DOM

const MATH_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** A style declaration that logs every write as "name=value": properties, and setProperty. */
function makeStyle(): Record<string, unknown> & { log: string[] } {
  const log: string[] = [];
  const decl: Record<string, unknown> = {
    log,
    setProperty(k: string, v: string): void {
      log.push(`${k}=${v}`);
      decl[k] = v;
    },
  };
  return new Proxy(decl, {
    set(t, k, v) {
      log.push(`${String(k)}=${v}`);
      t[k as string] = v;
      return true;
    },
  }) as Record<string, unknown> & { log: string[] };
}

/**
 * An element with what host rendering reads beyond @reactre/testdom: localName, a style
 * declaration, namespaced attributes, an innerHTML getter (and a count of its writes), and the
 * one selector restoreControlled queries.
 */
class El extends FakeElement {
  readonly style = makeStyle();
  /** The namespace of each attribute set with setAttributeNS, by qualified name. */
  readonly attrNs = new Map<string, string>();
  htmlWrites = 0;
  get localName(): string {
    return this.namespaceURI === HTML_NS ? this.tagName.toLowerCase() : this.tagName;
  }
  setAttributeNS(ns: string, name: string, v: string): void {
    this.attrNs.set(name, ns);
    this.setAttribute(name, v);
  }
  removeAttributeNS(ns: string, local: string): void {
    for (const [name, n] of this.attrNs)
      if (n === ns && name.slice(name.indexOf(":") + 1) === local) {
        this.attrNs.delete(name);
        this.removeAttribute(name);
      }
  }
  override get innerHTML(): string {
    return html(this);
  }
  override set innerHTML(v: string) {
    this.htmlWrites++;
    super.innerHTML = v;
  }
  /** Only `input[type=radio][name="x"]`: the radios of group x below this element. */
  querySelectorAll(sel: string): Input[] {
    const name = /^input\[type=radio\]\[name="(.*)"\]$/.exec(sel)![1];
    const out: Input[] = [];
    const walk = (n: FakeElement): void => {
      for (let c = n.firstChild; c !== null; c = c.nextSibling) {
        if (c instanceof Input && c.type === "radio" && c.name === name) out.push(c);
        if (c instanceof FakeElement) walk(c);
      }
    };
    walk(this);
    return out;
  }
}

/**
 * An <input> as a browser keeps one: value and checked apart from their defaults (the value and
 * checked attributes) once set, all accessors on the prototype, as the value tracker needs. Writes
 * of type, value and name are logged in order.
 */
class Input extends El {
  #value: string | null = null;
  #checked: boolean | null = null;
  readonly writes: string[] = [];
  get value(): string {
    return this.#value ?? this.getAttribute("value") ?? "";
  }
  set value(v: unknown) {
    this.writes.push("value");
    this.#value = String(v);
  }
  get defaultValue(): string {
    return this.getAttribute("value") ?? "";
  }
  set defaultValue(v: unknown) {
    this.setAttribute("value", String(v));
  }
  get checked(): boolean {
    return this.#checked ?? this.hasAttribute("checked");
  }
  set checked(v: unknown) {
    this.#checked = !!v;
  }
  get defaultChecked(): boolean {
    return this.hasAttribute("checked");
  }
  set defaultChecked(v: unknown) {
    if (v) this.setAttribute("checked", "");
    else this.removeAttribute("checked");
  }
  get type(): string {
    return this.getAttribute("type") ?? "text";
  }
  set type(v: unknown) {
    this.writes.push("type");
    this.setAttribute("type", String(v));
  }
  get name(): string {
    return this.getAttribute("name") ?? "";
  }
  set name(v: unknown) {
    this.writes.push("name");
    this.setAttribute("name", String(v));
  }
  /** The nearest <form> above, as the browser's form owner. */
  get form(): Form | null {
    let n = this.parentNode;
    while (n !== null && !(n instanceof Form)) n = n.parentNode;
    return n;
  }
}

/** A <textarea>: its default value is its text content, its value that until set. */
class TextArea extends El {
  #value: string | null = null;
  get value(): string {
    return this.#value ?? this.defaultValue;
  }
  set value(v: unknown) {
    this.#value = String(v);
  }
  get defaultValue(): string {
    return this.textContent;
  }
  set defaultValue(v: unknown) {
    this.textContent = String(v);
  }
}

/** A <select>: its mode, and its options in tree order. */
class Select extends El {
  multiple = false;
  size = 0;
  get options(): Option[] {
    const out: Option[] = [];
    for (let c = this.firstChild; c !== null; c = c.nextSibling) if (c instanceof Option) out.push(c);
    return out;
  }
}

/** An <option>: its value is the value attribute, or its text. */
class Option extends El {
  #selected = false;
  get selected(): boolean {
    return this.#selected;
  }
  /** As in a browser, selecting an option of a single select deselects the others. */
  set selected(v: unknown) {
    this.#selected = !!v;
    const s = this.parentNode;
    if (v && s instanceof Select && !s.multiple) for (const o of s.options) if (o !== this) o.#selected = false;
  }
  get value(): string {
    return this.getAttribute("value") ?? this.textContent;
  }
}

/** A <form>: its method and how often it was reset. */
class Form extends El {
  method = "get";
  resets = 0;
  reset(): void {
    this.resets++;
  }
}

/** A custom element that defines an `items` property. */
class Widget extends El {
  items: unknown = undefined;
}

const KINDS: Record<string, typeof El> = {
  INPUT: Input,
  TEXTAREA: TextArea,
  SELECT: Select,
  OPTION: Option,
  FORM: Form,
  "MY-WIDGET": Widget,
};
const make = (tag: string, ns: string = HTML_NS): El => {
  if (ns !== HTML_NS) return new El(tag, ns);
  const T = KINDS[tag.toUpperCase()] ?? El;
  return new T(tag.toUpperCase());
};

/** A submit event: its submitter, and preventDefault. */
class SubmitEvent extends FakeEvent {
  readonly submitter: unknown;
  defaultPrevented = false;
  constructor(submitter: unknown = null) {
    super("submit");
    this.submitter = submitter;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

/** FormData, recording the form and submitter it was made from. */
class FakeFormData {
  constructor(
    readonly form: unknown,
    readonly submitter: unknown,
  ) {}
}

/** Change a field as the user does: through the prototype's setter, which the value tracker does not see. */
const userSets = (el: El, key: "value" | "checked", v: unknown): void =>
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), key)!.set!.call(el, v);

// #endregion

// #region Fixtures

let container: El;
let head: El;
let root: Root;
const g = globalThis as unknown as { document: unknown; CSS: unknown; FormData: unknown };
let saved: { CSS: unknown; FormData: unknown };

beforeEach(() => {
  installFakeDocument();
  head = new El("HEAD");
  g.document = {
    head,
    createElement: (tag: string) => make(tag),
    createElementNS: (ns: string, tag: string) => make(tag, ns),
    createTextNode: (data: string) => new FakeText(data),
  };
  saved = { CSS: g.CSS, FormData: g.FormData };
  g.CSS = { escape: (s: string) => s };
  g.FormData = FakeFormData;
  container = new El("DIV");
  container.isDocument = true;
  root = createRoot(container as unknown as Element);
});

afterEach(() => {
  g.CSS = saved.CSS;
  g.FormData = saved.FormData;
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
// The first element rendered, or its child at `path`.
const first = <T extends El = El>(...path: number[]): T => {
  let n = container.firstChild!;
  for (const i of path) n = n.childNodes[i]!;
  return n as unknown as T;
};
// "name=value" for each attribute, names lowercased (HTML attribute names are case-insensitive).
const attrs = (el: FakeElement): string[] => el.attributes.map((a) => `${a.name.toLowerCase()}=${a.value}`);
const noop = (): void => {};

// #endregion

describe("namespaces", () => {
  test("children of an SVG container are SVG elements", () => {
    const svg = new El("svg", SVG_NS);
    svg.isDocument = true;
    flushSync(() => createRoot(svg as unknown as Element).render(h("circle", { r: 1 })));
    expect((svg.firstChild as El).namespaceURI).toBe(SVG_NS);
    expect((svg.firstChild as El).tagName).toBe("circle");
  });

  test("children of a foreignObject container are HTML elements", () => {
    const fo = new El("foreignObject", SVG_NS);
    fo.isDocument = true;
    flushSync(() => createRoot(fo as unknown as Element).render(h("div")));
    expect((fo.firstChild as El).namespaceURI).toBe(HTML_NS);
  });

  test("children of a MathML container are MathML elements", () => {
    const math = new El("math", MATH_NS);
    math.isDocument = true;
    flushSync(() => createRoot(math as unknown as Element).render(h("mi", null, "x")));
    expect((math.firstChild as El).namespaceURI).toBe(MATH_NS);
  });

  test("<svg> and <math> start their namespaces, and a foreignObject goes back to HTML", () => {
    render(
      h("div", null, h("svg", null, h("g"), h("foreignObject", null, h("p"))), h("math", null, h("mi", null, "x"))),
    );
    expect(first(0).namespaceURI).toBe(SVG_NS);
    expect(first(0, 0).namespaceURI).toBe(SVG_NS);
    expect(first(0, 1, 0).namespaceURI).toBe(HTML_NS);
    expect(first(1).namespaceURI).toBe(MATH_NS);
    expect(first(1, 0).namespaceURI).toBe(MATH_NS);
  });
});

describe("document metadata", () => {
  test("<title>, <meta> and <link> are placed in <head>, not where they render", () => {
    render(h("div", null, h("meta", { name: "a" }), h("link", { rel: "icon", href: "i.png" }), h("title", null, "T")));
    // As in React, a <title> goes before the first title already in <head>, or last when none is.
    expect(html(head)).toBe("<meta></meta><link></link><title>T</title>");
    expect(html()).toBe("<div></div>");
  });

  test("metadata with itemProp, inside SVG, or a <link> React does not hoist stays in place", () => {
    render(
      h(
        "div",
        null,
        h("meta", { itemProp: "name", content: "x" }),
        h("svg", null, h("title", null, "Icon")),
        h("link", { rel: "stylesheet", href: "a.css" }),
        h("link", { rel: "preload", href: "b.css", onLoad: noop }),
        h("link", { rel: "stylesheet", href: "c.css", precedence: "default" }),
      ),
    );
    expect(html()).toBe("<div><meta></meta><svg><title>Icon</title></svg><link></link><link></link></div>");
    expect(html(head)).toBe("<link></link>");
  });
});

describe("content", () => {
  test("dangerouslySetInnerHTML is written once, and again only when the HTML changes", () => {
    render(h("div", { dangerouslySetInnerHTML: { __html: "<b>a</b>" } }));
    const div = first();
    expect(html()).toBe("<div><b>a</b></div>");
    render(h("div", { dangerouslySetInnerHTML: { __html: "<b>a</b>" } }));
    expect(div.htmlWrites).toBe(1);
    render(h("div", { dangerouslySetInnerHTML: { __html: "<i>b</i>" } }));
    expect(div.htmlWrites).toBe(2);
    expect(html()).toBe("<div><i>b</i></div>");
  });

  test("raw HTML replaces element children, text, and the other way round", () => {
    render(h("div", null, h("span", null, "x"), h("span", null, "y")));
    render(h("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }));
    expect(html()).toBe("<div><b>raw</b></div>");
    render(h("div", null, "text"));
    expect(html()).toBe("<div>text</div>");
    render(h("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }));
    expect(html()).toBe("<div><b>raw</b></div>");
    render(h("div", null, h("i", null, "el")));
    expect(html()).toBe("<div><i>el</i></div>");
  });

  test("an empty __html leaves the element empty", () => {
    render(h("div", { dangerouslySetInnerHTML: {} }));
    expect(html()).toBe("<div></div>");
  });

  test("text replaces element children, and element children replace text", () => {
    render(h("p", null, h("b", null, "1"), h("i", null, "2")));
    render(h("p", null, "plain"));
    expect(html()).toBe("<p>plain</p>");
    render(h("p", null, h("b", null, "1")));
    expect(html()).toBe("<p><b>1</b></p>");
  });
});

describe("attributes", () => {
  test("React's aliases name the attribute, in HTML and as SVG's kebab-case presentation attributes", () => {
    render(h("label", { className: "c", htmlFor: "f", tabIndex: 0 }));
    expect(attrs(first())).toEqual(["class=c", "for=f", "tabindex=0"]);
    render(h("svg", { viewBox: "0 0 1 1" }, h("path", { strokeWidth: 2, fillOpacity: 0.5 })));
    expect(attrs(first())).toEqual(["viewbox=0 0 1 1"]);
    expect(first().getAttribute("viewBox")).toBe("0 0 1 1");
    expect(attrs(first(0))).toEqual(["stroke-width=2", "fill-opacity=0.5"]);
  });

  test("boolean attributes are present for true and absent for false", () => {
    render(h("input", { disabled: true, readOnly: true, hidden: false }));
    expect(first().getAttribute("disabled")).toBe("");
    expect(first().getAttribute("readOnly")).toBe("");
    expect(first().hasAttribute("hidden")).toBe(false);
    render(h("input", { disabled: false, readOnly: true }));
    expect(first().hasAttribute("disabled")).toBe(false);
  });

  test("download and capture take true as presence and a string as their value", () => {
    render(h("a", { download: true }));
    expect(first().getAttribute("download")).toBe("");
    render(h("a", { download: "file.txt" }));
    expect(first().getAttribute("download")).toBe("file.txt");
  });

  test("data-, aria- and booleanish props write booleans as text", () => {
    render(h("div", { "data-on": false, "aria-hidden": true, draggable: false, spellCheck: true }));
    expect(attrs(first())).toEqual(["data-on=false", "aria-hidden=true", "draggable=false", "spellcheck=true"]);
  });

  test("a boolean on any other attribute, and functions, symbols and null, leave it out", () => {
    render(h("div", { title: "t", id: "i", lang: "en", dir: "ltr" }));
    render(h("div", { title: true, id: noop, lang: Symbol("x"), dir: null }));
    expect(attrs(first())).toEqual([]);
  });

  test("removed props remove their attributes", () => {
    render(h("div", { title: "t", className: "c" }));
    render(h("div", null));
    expect(attrs(first())).toEqual([]);
  });

  test("SVG's xlink and xml props are set in the XLink and XML namespaces, and removed there", () => {
    render(h("svg", { xmlnsXlink: XLINK_NS }, h("use", { xlinkHref: "#a", xmlLang: "en", xmlSpace: "preserve" })));
    const use = first(0);
    expect(attrs(use)).toEqual(["xlink:href=#a", "xml:lang=en", "xml:space=preserve"]);
    expect([...use.attrNs]).toEqual([
      ["xlink:href", XLINK_NS],
      ["xml:lang", XML_NS],
      ["xml:space", XML_NS],
    ]);
    // xmlns:xlink is a plain attribute, not one in the XML namespace.
    expect(attrs(first())).toEqual([`xmlns:xlink=${XLINK_NS}`]);
    expect(first().attrNs.size).toBe(0);
    render(h("svg", { xmlnsXlink: XLINK_NS }, h("use", { xmlLang: "en" })));
    expect(attrs(use)).toEqual(["xml:lang=en"]);
  });

  test("a custom element takes a non-string value through a property it defines", () => {
    const items = [1, 2];
    render(h("my-widget", { items, label: "x", count: 3 }));
    const w = first<Widget>();
    expect(w.items).toBe(items);
    // Props the element does not define stay attributes.
    expect(attrs(w)).toEqual(["label=x", "count=3"]);
  });

  test("a function action or formAction writes React's URL that throws on a native submit", () => {
    render(h("form", { action: noop }, h("button", { formAction: noop })));
    expect(first().getAttribute("action")).toStartWith(
      "javascript:throw new Error('A React form was unexpectedly submitted.",
    );
    expect(first(0).getAttribute("formaction")).toBe(first().getAttribute("action"));
  });

  test.todo("a falsy non-boolean on a boolean attribute leaves it out (React: disabled={0} and hidden='' are absent)");
  test.todo("credentialless is a boolean attribute (React: credentialless={true} writes '')");
  test.todo("muted={true} on a <video> sets its muted property to true (compat writes !!'' = false)");
  test.todo("muted is only a property (React writes no muted attribute, and sets audio.muted too)");
  test.todo("a custom element takes a string through a property it defines (React: `key in el` sets el[key])");
  test.todo("xmlLang and xlinkHref are namespaced on HTML elements too (React's setProp does it for every tag)");
});

describe("styles", () => {
  const style = (): Record<string, unknown> & { log: string[] } => first().style;

  test("numbers get px, except 0 and unitless properties", () => {
    render(h("div", { style: { width: 10, margin: 0, lineHeight: 1.5, opacity: 0.5, zIndex: 2, flexGrow: 1 } }));
    expect(style().log).toEqual(["width=10px", "margin=0", "lineHeight=1.5", "opacity=0.5", "zIndex=2", "flexGrow=1"]);
  });

  test("more of React's unitless properties take plain numbers", () => {
    render(
      h("div", {
        style: { order: 1, zoom: 2, fontWeight: 700, columnCount: 3, gridRow: 1, animationIterationCount: 2 },
      }),
    );
    expect(style().log).toEqual([
      "order=1",
      "zoom=2",
      "fontWeight=700",
      "columnCount=3",
      "gridRow=1",
      "animationIterationCount=2",
    ]);
  });

  test("custom properties go through setProperty and keep plain numbers", () => {
    render(h("div", { style: { "--gap": 4, "--color": "red" } }));
    expect(style().log).toEqual(["--gap=4", "--color=red"]);
    expect(style()["--gap"]).toBe("4");
  });

  test("float is written as cssFloat", () => {
    render(h("div", { style: { float: "left" } }));
    expect(style()["cssFloat"]).toBe("left");
  });

  test("null, booleans and empty strings clear a property", () => {
    render(h("div", { style: { color: null, display: false, top: "" } }));
    expect(style().log).toEqual(["color=", "display=", "top="]);
  });

  test("an update writes only the properties that changed, and clears removed ones", () => {
    render(h("div", { style: { color: "red", top: 1, "--x": "a" } }));
    style().log.length = 0;
    render(h("div", { style: { color: "red", top: 2 } }));
    expect(style().log).toEqual(["--x=", "top=2px"]);
    style().log.length = 0;
    render(h("div", null));
    expect(style().log).toEqual(["color=", "top="]);
  });

  test.todo("a string style throws, as React's does (compat writes it as cssText)");
  test.todo(
    "aspectRatio, scale, tabSize, columns and strokeWidth take plain numbers, and gridGap gets px, by React's list",
  );
});

describe("inputs", () => {
  test("an input takes type, then value, then name, after its other attributes", () => {
    render(h("input", { name: "n", value: "v", type: "text", placeholder: "p", onChange: noop }));
    const input = first<Input>();
    expect(input.writes).toEqual(["type", "value", "name"]);
    expect(attrs(input)).toEqual(["placeholder=p", "type=text", "value=v", "name=n"]);
  });

  test("value sets both the value and the default value; defaultValue alone sets both too", () => {
    render(h("div", null, h("input", { value: "a", onChange: noop }), h("input", { defaultValue: "b" })));
    expect([first<Input>(0).value, first<Input>(0).defaultValue]).toEqual(["a", "a"]);
    expect([first<Input>(1).value, first<Input>(1).defaultValue]).toEqual(["b", "b"]);
  });

  test("a submit or reset button with no value keeps no value attribute", () => {
    render(h("div", null, h("input", { type: "submit", defaultValue: "Send" }), h("input", { type: "reset" })));
    expect(first(0).hasAttribute("value")).toBe(false);
    expect(first(1).hasAttribute("value")).toBe(false);
  });

  test("checked, or else defaultChecked, sets checked and its default; a function is false", () => {
    render(
      h(
        "div",
        null,
        h("input", { type: "checkbox", checked: true, onChange: noop }),
        h("input", { type: "checkbox", defaultChecked: true }),
        h("input", { type: "checkbox", checked: noop, onChange: noop }),
      ),
    );
    expect([first<Input>(0).checked, first<Input>(0).defaultChecked]).toEqual([true, true]);
    expect([first<Input>(1).checked, first<Input>(1).defaultChecked]).toEqual([true, true]);
    expect([first<Input>(2).checked, first<Input>(2).defaultChecked]).toEqual([false, false]);
  });

  test("a type or name that is not a string or number is left out", () => {
    render(h("input", { type: noop, name: true }));
    expect(attrs(first())).toEqual([]);
  });

  test("a function or symbol value is written as the empty string", () => {
    render(
      h("div", null, h("input", { value: noop, onChange: noop }), h("input", { value: Symbol("s"), onChange: noop })),
    );
    expect(first<Input>(0).defaultValue).toBe("");
    expect(first<Input>(1).defaultValue).toBe("");
  });

  test.todo("a boolean value is written as text (React's getToStringValue keeps booleans: value={true} is 'true')");

  test("a changed type is set, and a removed one removed", () => {
    render(h("input", { type: "text" }));
    render(h("input", { type: "email" }));
    expect(first<Input>().type).toBe("email");
    render(h("input", null));
    expect(first().hasAttribute("type")).toBe(false);
  });

  test("a controlled value moves the field's value and its default together", () => {
    render(h("input", { value: "a", onChange: noop }));
    render(h("input", { value: "b", onChange: noop }));
    expect([first<Input>().value, first<Input>().defaultValue]).toEqual(["b", "b"]);
  });

  test("a number input keeps text the user typed while it means the value", () => {
    render(h("input", { type: "number", value: 1, onChange: noop }));
    const input = first<Input>();
    userSets(input, "value", "1.0");
    render(h("input", { type: "number", value: 1, onChange: noop }));
    expect([input.value, input.defaultValue]).toEqual(["1.0", "1.0"]);
    // An emptied field shows 0 when the value is 0, though "" == 0.
    userSets(input, "value", "");
    render(h("input", { type: "number", value: 0, onChange: noop }));
    expect([input.value, input.defaultValue]).toEqual(["0", "0"]);
  });

  test("dropping a submit button's value removes its value attribute", () => {
    render(h("input", { type: "submit", value: "Go" }));
    render(h("input", { type: "submit" }));
    expect(first().hasAttribute("value")).toBe(false);
  });

  test("defaultValue updates the default, and removing it removes the value attribute", () => {
    render(h("input", { defaultValue: "a" }));
    render(h("input", { defaultValue: "b" }));
    expect(first<Input>().defaultValue).toBe("b");
    render(h("input", null));
    expect(first().hasAttribute("value")).toBe(false);
  });

  test("defaultChecked updates the default of an uncontrolled checkbox; checked sets the state", () => {
    render(h("input", { type: "checkbox", defaultChecked: false }));
    render(h("input", { type: "checkbox", defaultChecked: true }));
    expect(first<Input>().defaultChecked).toBe(true);
    render(h("input", { type: "checkbox", checked: false, onChange: noop }));
    expect(first<Input>().checked).toBe(false);
  });

  test("a changed name is set, and a removed one removed", () => {
    render(h("input", { name: "a" }));
    render(h("input", { name: 5 }));
    expect(first<Input>().name).toBe("5");
    render(h("input", null));
    expect(first().hasAttribute("name")).toBe(false);
  });
});

describe("textareas", () => {
  test("value, defaultValue or the children set the initial text, never as a value attribute", () => {
    render(
      h(
        "div",
        null,
        h("textarea", { value: "v", onChange: noop }),
        h("textarea", { defaultValue: "d" }),
        h("textarea", null, "c"),
        h("textarea", null, ["one"]),
      ),
    );
    expect([0, 1, 2, 3].map((i) => first<TextArea>(i).value)).toEqual(["v", "d", "c", "one"]);
    expect(first(0).hasAttribute("value")).toBe(false);
  });

  test("a controlled value moves the text and the default together", () => {
    render(h("textarea", { value: "a", onChange: noop }));
    const ta = first<TextArea>();
    userSets(ta, "value", "typed");
    render(h("textarea", { value: "b", onChange: noop }));
    expect([ta.value, ta.defaultValue]).toEqual(["b", "b"]);
  });

  test.todo("an uncontrolled textarea's defaultValue updates its default (React's updateTextarea)");
  test.todo("a controlled textarea with a defaultValue keeps that as its default (React's updateTextarea)");
});

describe("selects", () => {
  const opts = (...vs: string[]) => vs.map((v) => h("option", { key: v, value: v }, v.toUpperCase()));
  const selected = (): boolean[] => first<Select>().options.map((o) => o.selected);

  test("multiple and size are set when the select is created, before its options", () => {
    render(h("div", null, h("select", { multiple: true, size: 3 }), h("select", { size: 3 })));
    expect([first<Select>(0).multiple, first<Select>(0).size]).toEqual([true, 0]);
    expect([first<Select>(1).multiple, first<Select>(1).size]).toEqual([false, 3]);
  });

  test("value selects the matching option, and is no attribute", () => {
    render(h("select", { value: "b", onChange: noop }, opts("a", "b", "c")));
    expect(selected()).toEqual([false, true, false]);
    expect(first().hasAttribute("value")).toBe(false);
    render(h("select", { value: "c", onChange: noop }, opts("a", "b", "c")));
    expect(selected()).toEqual([false, false, true]);
  });

  test("defaultValue selects on mount only", () => {
    render(h("select", { defaultValue: "b" }, opts("a", "b")));
    expect(selected()).toEqual([false, true]);
    render(h("select", { defaultValue: "a" }, opts("a", "b")));
    expect(selected()).toEqual([false, true]);
  });

  test("a value no option has selects the first option", () => {
    render(h("select", { value: "z", onChange: noop }, opts("a", "b")));
    expect(selected()).toEqual([true, false]);
    render(h("select", { value: "z", onChange: noop }));
    expect(first<Select>().options).toEqual([]);
  });

  test("a multiple select selects every option in its value array", () => {
    render(h("select", { multiple: true, value: ["a", "c"], onChange: noop }, opts("a", "b", "c")));
    expect(selected()).toEqual([true, false, true]);
    render(h("select", { multiple: true, value: ["b"], onChange: noop }, opts("a", "b", "c")));
    expect(selected()).toEqual([false, true, false]);
  });

  test.todo("with no match, the first enabled option is selected (React skips disabled ones)");
  test.todo("defaultValue also sets the matching option's defaultSelected, so a form reset keeps it (React)");
});

describe("hydration", () => {
  test("a server element is claimed, and its unclaimed children are removed", () => {
    const p = make("p"),
      span = make("span"),
      extra = make("em");
    p.appendChild(span);
    p.appendChild(extra);
    container.appendChild(p);
    hydrateRoot(container as unknown as Element, h("p", { title: "t" }, h("span")));
    expect(first()).toBe(p);
    expect(first(0)).toBe(span);
    expect(html()).toBe("<p><span></span></p>");
    expect(p.getAttribute("title")).toBe("t");
  });

  test("a claimed element keeps its server text node", () => {
    const p = make("p"),
      text = new FakeText("hi");
    p.appendChild(text);
    container.appendChild(p);
    hydrateRoot(container as unknown as Element, h("p", null, "hi"));
    expect(first().firstChild).toBe(text);
  });

  test("raw HTML the server already rendered is left alone", () => {
    const div = make("div"),
      b = make("b");
    b.appendChild(new FakeText("x"));
    div.appendChild(b);
    container.appendChild(div);
    hydrateRoot(container as unknown as Element, h("div", { dangerouslySetInnerHTML: { __html: "<b>x</b>" } }));
    expect(div.htmlWrites).toBe(0);
    expect(first(0)).toBe(b);
  });
});

describe("controlled fields after an event", () => {
  test("an input whose onChange keeps its value shows the value again", () => {
    render(h("input", { value: "a", onChange: noop }));
    const input = first<Input>();
    userSets(input, "value", "ab");
    input.dispatchEvent(new FakeEvent("input"));
    expect(input.value).toBe("a");
  });

  test("an input that took the change shows the new value", () => {
    function Field() {
      const [v, setV] = useState("a");
      return h("input", { value: v, onChange: (e: { target: Input }) => setV(e.target.value) });
    }
    render(h(Field));
    const input = first<Input>();
    userSets(input, "value", "ab");
    input.dispatchEvent(new FakeEvent("input"));
    expect([input.value, input.defaultValue]).toEqual(["ab", "ab"]);
  });

  test("a field its own onChange removed is left as it is", () => {
    function Field() {
      const [on, setOn] = useState(true);
      return on ? h("input", { value: "a", onChange: () => setOn(false) }) : null;
    }
    render(h(Field));
    const input = first<Input>();
    userSets(input, "value", "ab");
    input.dispatchEvent(new FakeEvent("input"));
    expect(html()).toBe("");
    expect(input.value).toBe("ab");
  });

  test("a checkbox whose onChange keeps checked is unchecked again", () => {
    render(h("input", { type: "checkbox", checked: false, onChange: noop }));
    const box = first<Input>();
    userSets(box, "checked", true);
    box.dispatchEvent(new FakeEvent("click"));
    expect(box.checked).toBe(false);
  });

  test("clicking a controlled radio gives the others in its form their checked prop back", () => {
    render(
      h(
        "form",
        null,
        h("input", { type: "radio", name: "g", checked: true, onChange: noop }),
        h("input", { type: "radio", name: "g", checked: false, onChange: noop }),
      ),
    );
    const [a, b] = [first<Input>(0), first<Input>(1)];
    // The browser checks the clicked radio and unchecks the rest of its group.
    userSets(a, "checked", false);
    userSets(b, "checked", true);
    b.dispatchEvent(new FakeEvent("click"));
    expect([a.checked, b.checked]).toEqual([true, false]);
  });

  test("a textarea whose onChange keeps its value shows the value again", () => {
    render(h("textarea", { value: "a", onChange: noop }));
    const ta = first<TextArea>();
    userSets(ta, "value", "ab");
    ta.dispatchEvent(new FakeEvent("input"));
    expect(ta.value).toBe("a");
  });

  test("a select whose onChange keeps its value selects that option again", () => {
    render(h("select", { value: "a", onChange: noop }, h("option", { value: "a" }), h("option", { value: "b" })));
    const [a, b] = first<Select>().options;
    a!.selected = false;
    b!.selected = true;
    first().dispatchEvent(new FakeEvent("change"));
    expect([a!.selected, b!.selected]).toEqual([true, false]);
  });
});

describe("form actions", () => {
  test("submitting a form with a function action runs it with the form's data, then resets the form", () => {
    const calls: FakeFormData[] = [];
    render(h("form", { action: (d: FakeFormData) => calls.push(d) }, h("button", { type: "submit" })));
    const form = first<Form>(),
      button = first(0);
    const e = new SubmitEvent(button);
    form.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.form).toBe(form);
    expect(calls[0]!.submitter).toBe(button);
    expect(form.resets).toBe(1);
  });

  test("the submit button's formAction runs instead of the form's action", () => {
    const log: string[] = [];
    render(
      h(
        "form",
        { action: () => log.push("form") },
        h("button", { formAction: () => log.push("button") }),
        h("button", { type: "submit" }),
      ),
    );
    first().dispatchEvent(new SubmitEvent(first(0)));
    first().dispatchEvent(new SubmitEvent(first(1)));
    first().dispatchEvent(new SubmitEvent());
    expect(log).toEqual(["button", "form", "form"]);
  });

  test("an onSubmit that prevents the default stops the action", () => {
    const log: string[] = [];
    render(
      h("form", { action: () => log.push("action"), onSubmit: (e: { preventDefault(): void }) => e.preventDefault() }),
    );
    first().dispatchEvent(new SubmitEvent());
    expect(log).toEqual([]);
  });

  test("a form whose action is a URL submits natively", () => {
    render(h("form", { action: "/save" }, h("button", { formAction: "/other" })));
    const e = new SubmitEvent(first(0));
    first().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(first().getAttribute("action")).toBe("/save");
  });
});
