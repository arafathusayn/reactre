// A fake DOM for @reactre/preact's tests: @reactre/testdom's nodes with what Preact's renderer
// reads beyond them: remove(), createElementNS, localName, a style declaration, listener
// removal, and HTML output for assertions.
//
// Preact decides between a DOM property and an attribute with `name in dom`. These elements have
// a few real properties (className, id, title, value, checked, the on* handlers testdom gives),
// so both paths are exercised.

import { afterAll, beforeAll } from "bun:test";

import { FakeComment, FakeElement, FakeEvent, FakeNode, FakeText, HTML_NS } from "@reactre/testdom";

/** Every write to an element's style, as "name=value". */
class Style {
  readonly log: string[] = [];
  [k: string]: unknown;
  cssText = "";
  setProperty(k: string, v: string): void {
    // Called on the proxy: the write below is logged by its set trap.
    this[k] = v;
  }
}

/** An element with the browser features the renderer uses. */
export class El extends FakeElement {
  readonly style: Style = new Proxy(new Style(), {
    set(t, k, v) {
      if (k !== "cssText") t.log.push(`${String(k)}=${v}`);
      (t as Record<string, unknown>)[k as string] = v;
      return true;
    },
  });
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  set id(v: string) {
    this.setAttribute("id", v);
  }
  get title(): string {
    return this.getAttribute("title") ?? "";
  }
  set title(v: string) {
    this.setAttribute("title", v);
  }
  constructor(tag: string, ns?: string) {
    super(tag, ns);
    // Form controls have value and checked properties, with no attribute behind them.
    if (/^(INPUT|TEXTAREA|SELECT|OPTION|PROGRESS)$/.test(tag)) Object.assign(this, { value: "", checked: false });
  }
  /** A DOM property with no attribute, which a clone does not copy. */
  expando: unknown = "";
  /** A read-only DOM property: writing it throws, and Preact falls back to the attribute. */
  get frozen(): string {
    return "";
  }

  private removed: [string, unknown][] = [];
  override removeEventListener(...args: Parameters<FakeElement["removeEventListener"]>): void {
    this.removed.push([args[0], args[1]]);
    super.removeEventListener(...args);
  }
  override cloneNode(deep?: boolean): El {
    const c = new El(this.tagName, this.namespaceURI);
    for (const { name, value } of this.attributes) c.setAttribute(name, value);
    if (deep) for (let n = this.firstChild; n; n = n.nextSibling) c.appendChild(n.cloneNode(true));
    return c;
  }
}

/** A document with createElementNS making El, installed as the global `document`. */
export function installDom(): void {
  const doc = {
    createElement: (tag: string) => new El(tag.toUpperCase()),
    createElementNS: (ns: string, tag: string) => new El(ns === HTML_NS ? tag.toUpperCase() : tag, ns),
    createTextNode: (data: string) => new FakeText(data),
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  // Every fake node shares testdom's document object: give it the same constructors.
  Object.assign(new FakeText("").ownerDocument, doc);
}

// As in the DOM: attribute values are strings, every element (parsed ones too) has a localName,
// and nodes remove themselves. These change @reactre/testdom's prototypes, which every test file
// of the run shares, so a file applies them for its own tests only (useDom), and testdom's own
// come back after it.
const setAttr = FakeElement.prototype.setAttribute;
const PATCHES: [object, string, PropertyDescriptor][] = [
  [
    FakeElement.prototype,
    "setAttribute",
    {
      value(this: FakeElement, k: string, v: unknown) {
        setAttr.call(this, k, String(v));
      },
    },
  ],
  [
    FakeElement.prototype,
    "localName",
    {
      get(this: FakeElement) {
        return this.namespaceURI === HTML_NS ? this.tagName.toLowerCase() : this.tagName;
      },
    },
  ],
  [
    FakeNode.prototype,
    "remove",
    {
      value(this: FakeNode) {
        this.parentNode?.removeChild(this);
      },
    },
  ],
  // The global `document` is not put back: Preact's compat and this package's read whether there is
  // one when they load (IS_DOM), which a later test file may be the first to do.
  // installDom gives testdom's shared document object its constructors.
  ...["createElement", "createElementNS", "createTextNode"].map((k): [object, string, PropertyDescriptor] => [
    new FakeText("").ownerDocument as object,
    k,
    { value: undefined },
  ]),
];

/** Patch testdom for this file's tests, and put it back as it was after them. Call it once per file. */
export function useDom(): void {
  let saved: (PropertyDescriptor | undefined)[] = [];
  beforeAll(() => {
    saved = PATCHES.map(([o, k]) => Object.getOwnPropertyDescriptor(o, k));
    for (const [o, k, d] of PATCHES)
      Object.defineProperty(o, k, { configurable: true, ...("value" in d ? { writable: true } : {}), ...d });
  });
  afterAll(() =>
    PATCHES.forEach(([o, k], i) => {
      const d = saved[i];
      if (d) Object.defineProperty(o, k, d);
      else delete (o as Record<string, unknown>)[k];
    }),
  );
}

/** A fresh container element, connected to a document (Preact moves connected nodes with moveBefore). */
export function container(): El {
  const root = new El("HTML");
  root.isDocument = true;
  return root.appendChild(new El("DIV")) as El;
}

/** The HTML of a node's children: attributes in the order they were set, as a browser shows. */
export function html(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c instanceof FakeText) out += c.data;
    else if (c instanceof FakeComment) out += `<!--${c.data}-->`;
    else if (c instanceof FakeElement) {
      const tag = (c as El).localName as string;
      out += `<${tag}${c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("")}>${html(c)}</${tag}>`;
    }
  }
  return out;
}

/** Dispatch a bubbling event of `type` at `el`. */
export function fire(el: FakeElement, type: string): FakeEvent {
  const e = new FakeEvent(type);
  el.dispatchEvent(e);
  return e;
}

/** Wait for the microtask render queue (and a macrotask turn). */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
