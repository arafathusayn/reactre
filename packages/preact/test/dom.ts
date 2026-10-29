// A fake DOM for @reactre/preact's tests: @reactre/testdom's nodes with what Preact's renderer
// reads beyond them: remove(), createElementNS, localName, a style declaration, listener
// removal, and HTML output for assertions.
//
// Preact decides between a DOM property and an attribute with `name in dom`. These elements have
// a few real properties (className, id, title, value, checked, the on* handlers testdom gives),
// so both paths are exercised.

import { FakeComment, FakeElement, FakeEvent, FakeNode, FakeText, HTML_NS } from "@reactre/testdom";

/** Every write to an element's style, as "name=value". */
class Style {
  readonly log: string[] = [];
  [k: string]: unknown;
  cssText = "";
  setProperty(k: string, v: string): void {
    this.log.push(`${k}=${v}`);
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
  get localName(): string {
    return this.namespaceURI === HTML_NS ? this.tagName.toLowerCase() : this.tagName;
  }
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
  /** A DOM property with no attribute, which a clone does not copy. */
  expando: unknown = "";
  private removed: [string, unknown][] = [];
  override removeEventListener(type: string, fn: unknown): void {
    this.removed.push([type, fn]);
    const map = (this as unknown as { listeners: Map<string, unknown[]> | null }).listeners;
    if (map) map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
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

// Nodes remove themselves, as in the DOM.
(FakeNode.prototype as unknown as { remove(): void }).remove = function (this: FakeNode) {
  this.parentNode?.removeChild(this);
};

/** A fresh container element. */
export const container = (): El => new El("DIV");

/** The HTML of a node's children: attributes in the order they were set, as a browser shows. */
export function html(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c instanceof FakeText) out += c.data;
    else if (c instanceof FakeComment) out += `<!--${c.data}-->`;
    else if (c instanceof FakeElement) {
      const tag = (c as El).localName;
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
