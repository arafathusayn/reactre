// A small linked-list DOM for tests and profiling: just what @reactre/dom
// touches (template parsing, cloneNode, sibling pointers, insertBefore,
// removeChild, text data, classes, attributes). Bun ships no DOM and the
// library takes no npm packages. Every operation is O(1) pointer work, so
// a CPU profile over it shows the library's own cost, not a browser's.
//
// Design decisions:
//
//   - Nodes are a doubly linked list of siblings with parent, first and last
//     child pointers, as in a browser, so insertion and removal are O(1).
//   - Every DOM operation the library can make is counted in `ops`. Tests
//     assert exact counts, which is how "minimal moves" and "no write when
//     unchanged" are checked.
//   - Behaviour the library relies on follows the browser where it matters:
//     moveBefore throws off-document, className is read-only on SVG
//     elements, fragments empty on insertion, character references decode.
//   - The parser is a regular expression over tags, comments and text: enough
//     for the templates under test, not a full HTML parser.

// #region Operation counters

/** Counts the DOM work done; tests assert on it. */
export const ops = {
  /**
   * Nodes inserted that had no parent. A fragment's children count as
   * inserts into the fragment, then as moves out of it.
   */
  inserts: 0,
  /** Nodes inserted that already had a parent: moves. */
  moves: 0,
  /** Moves made with moveBefore, which keeps state (each also counts in `moves`). */
  stateMoves: 0,
  /** Children removed, one per child, also by a textContent clear. */
  removes: 0,
  /** Elements cloned, each element of a deep clone included. */
  clones: 0,
  classWrites: 0,
  attrWrites: 0,
  /** Writes through nodeValue on a text node. */
  textWrites: 0,
};
/** Zero every counter in `ops`. */
export function resetOps(): void {
  ops.inserts =
    ops.moves =
    ops.stateMoves =
    ops.removes =
    ops.clones =
    ops.classWrites =
    ops.attrWrites =
    ops.textWrites =
      0;
}

// #endregion

// #region Nodes

/**
 * The base node: tree pointers, insertion and removal, deep equality and
 * textContent. nodeType is the DOM's: 1 element, 3 text, 8 comment, 11 fragment.
 */
export class FakeNode {
  parentNode: FakeNode | null = null;
  firstChild: FakeNode | null = null;
  lastChild: FakeNode | null = null;
  nextSibling: FakeNode | null = null;
  previousSibling: FakeNode | null = null;
  readonly nodeType: number;
  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }
  get nodeName(): string {
    return "#node";
  }
  get nodeValue(): string | null {
    return null;
  }
  set nodeValue(_v: string | null) {}
  /** Every fake node's document: no focus, and fragments on request. */
  ownerDocument: { activeElement: unknown } & Partial<typeof FAKE_DOC> = FAKE_DOC;

  /** True on the fake document root: nodes under it are "in the document". */
  isDocument = false;
  /** Whether the node's topmost ancestor is a node marked `isDocument`. */
  get isConnected(): boolean {
    let n: FakeNode = this;
    while (n.parentNode) n = n.parentNode;
    return n.isDocument;
  }

  /** Like Chrome's moveBefore: keeps state, throws when either node is off-document. */
  moveBefore(n: FakeNode, ref: FakeNode | null): void {
    if (!this.isConnected || !n.isConnected) throw new Error("HierarchyRequestError");
    ops.stateMoves++;
    this.insertBefore(n, ref);
  }

  /**
   * Insert `n` before `ref` (at the end when null). A node that has a parent
   * is moved, which counts as a move; one without counts as an insert.
   */
  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode {
    if (n.nodeType === 11) {
      // A fragment hands over its children, in order, and is left empty.
      while (n.firstChild !== null) this.insertBefore(n.firstChild, ref);
      return n;
    }
    if (n.parentNode) {
      ops.moves++;
      n.parentNode.unlink(n);
    } else ops.inserts++;
    n.parentNode = this;
    if (ref === null) {
      n.previousSibling = this.lastChild;
      n.nextSibling = null;
      if (this.lastChild) this.lastChild.nextSibling = n;
      else this.firstChild = n;
      this.lastChild = n;
    } else {
      if (ref.parentNode !== this) throw new Error("ref is not a child");
      n.nextSibling = ref;
      n.previousSibling = ref.previousSibling;
      if (ref.previousSibling) ref.previousSibling.nextSibling = n;
      else this.firstChild = n;
      ref.previousSibling = n;
    }
    return n;
  }
  appendChild(n: FakeNode): FakeNode {
    return this.insertBefore(n, null);
  }
  removeChild(n: FakeNode): FakeNode {
    if (n.parentNode !== this) throw new Error("not a child");
    ops.removes++;
    this.unlink(n);
    return n;
  }
  /** Put `n` where `old` was. Counts the insertion of `n`; the removal of `old` is not counted. */
  replaceChild(n: FakeNode, old: FakeNode): FakeNode {
    this.insertBefore(n, old);
    this.unlink(old);
    return old;
  }
  /** Detach child `n` from the sibling list, without counting anything. */
  private unlink(n: FakeNode): void {
    if (n.previousSibling) n.previousSibling.nextSibling = n.nextSibling;
    else this.firstChild = n.nextSibling;
    if (n.nextSibling) n.nextSibling.previousSibling = n.previousSibling;
    else this.lastChild = n.previousSibling;
    n.parentNode = n.nextSibling = n.previousSibling = null;
  }
  /** Like the DOM's: same type, name, attributes (any order), data and children, compared deeply. */
  isEqualNode(other: FakeNode | null): boolean {
    if (other === null || other.nodeType !== this.nodeType || other.nodeName !== this.nodeName) return false;
    if (this.nodeValue !== other.nodeValue) return false;
    if (this.nodeType === 1) {
      const a = (this as unknown as FakeElement).attributes,
        b = (other as unknown as FakeElement).attributes;
      if (a.length !== b.length) return false;
      for (const { name, value } of a) if ((other as unknown as FakeElement).getAttribute(name) !== value) return false;
    }
    let x = this.firstChild,
      y = other.firstChild;
    for (; x !== null && y !== null; x = x.nextSibling, y = y.nextSibling) if (!x.isEqualNode(y)) return false;
    return x === null && y === null;
  }

  /** A fresh array of the children (the DOM's is a live NodeList; tests only read it). */
  get childNodes(): FakeNode[] {
    const out: FakeNode[] = [];
    for (let c = this.firstChild; c; c = c.nextSibling) out.push(c);
    return out;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  /** Replaces every child with one text node (none for ""). Each child dropped counts as a remove. */
  set textContent(v: string) {
    for (let c = this.firstChild; c;) {
      const next: FakeNode | null = c.nextSibling;
      ops.removes++;
      c.parentNode = c.nextSibling = c.previousSibling = null;
      c = next;
    }
    this.firstChild = this.lastChild = null;
    if (v !== "") this.appendChild(new FakeText(v));
  }
  cloneNode(_deep?: boolean): FakeNode {
    throw new Error("abstract");
  }
}

/** A document fragment: a parentless holder whose children move on insertion. */
export class FakeFragment extends FakeNode {
  constructor() {
    super(11);
  }
  override get nodeName(): string {
    return "#document-fragment";
  }
}

// The fake nodes' document: what installFakeDocument's `document` makes, and fragments.
const FAKE_DOC = {
  activeElement: null as unknown,
  createElement: (tag: string): FakeElement => new FakeElement(tag.toUpperCase()),
  createTextNode: (data: string): FakeText => new FakeText(data),
  createDocumentFragment: (): FakeFragment => new FakeFragment(),
};

/** A text node. Writes through nodeValue count as text writes; writes to `data` are not counted. */
export class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super(3);
    this.data = data;
  }
  override get nodeName(): string {
    return "#text";
  }
  override get nodeValue(): string {
    return this.data;
  }
  override set nodeValue(v: string | null) {
    ops.textWrites++;
    this.data = v ?? "";
  }
  override get textContent(): string {
    return this.data;
  }
  override cloneNode(): FakeText {
    return new FakeText(this.data);
  }
}

/** A comment node. Templates mark their text holes with comments in the markup. */
export class FakeComment extends FakeNode {
  data: string;
  constructor(data: string) {
    super(8);
    this.data = data;
  }
  override get nodeName(): string {
    return "#comment";
  }
  override get nodeValue(): string {
    return this.data;
  }
  override set nodeValue(v: string | null) {
    this.data = v ?? "";
  }
  // As in the DOM: comments add nothing to their parent's textContent.
  override get textContent(): string {
    return "";
  }
  override cloneNode(): FakeComment {
    return new FakeComment(this.data);
  }
}

// #endregion

// #region Elements and events

/** The HTML namespace, every element's unless parsed inside an `svg` element. */
export const HTML_NS = "http://www.w3.org/1999/xhtml";
/** The SVG namespace. */
export const SVG_NS = "http://www.w3.org/2000/svg";

/** A bubbling event for `FakeElement.dispatchEvent`. */
export class FakeEvent {
  readonly type: string;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  cancelBubble = false;
  constructor(type: string) {
    this.type = type;
  }
  stopPropagation(): void {
    this.cancelBubble = true;
  }
}

/**
 * An element: class and attributes, handler properties, listeners and
 * bubbling dispatch, cloning, and `innerHTML` parsing. Any other property can
 * be set on it (the index signature), as tests do with `key` and `value`.
 */
export class FakeElement extends FakeNode {
  // Handler properties, like a browser element's (an event with none, such as
  // compositionstart, has no property: "oncompositionstart" in el is false).
  onclick: unknown = null;
  ondblclick: unknown = null;
  oninput: unknown = null;
  onchange: unknown = null;
  onsubmit: unknown = null;
  onkeydown: unknown = null;
  onkeyup: unknown = null;
  onfocus: unknown = null;
  onblur: unknown = null;
  onfocusin: unknown = null;
  onfocusout: unknown = null;
  onmouseenter: unknown = null;
  onmouseleave: unknown = null;
  onpointerdown: unknown = null;
  onpointerup: unknown = null;
  onscroll: unknown = null;
  onload: unknown = null;
  onerror: unknown = null;
  // The class lives apart from the other attributes: className and the
  // "class" attribute are two views of it, as in the DOM.
  private cls = "";
  get className(): string {
    return this.cls;
  }
  /** Like the browser's: read-only on an SVG element (strict-mode code throws). */
  set className(v: string) {
    if (this.namespaceURI === SVG_NS)
      throw new TypeError("Cannot set property className of SVGElement, which has only a getter");
    ops.classWrites++;
    this.cls = v;
  }
  // Created on the first attribute: most elements under test have none.
  private attrs: Map<string, string> | null = null;
  [prop: string]: unknown;

  private listeners: Map<string, ((e: { type: string; target: FakeNode }) => void)[]> | null = null;

  readonly tagName: string;
  /** HTML, or SVG for an `svg` element and everything parsed inside one. */
  readonly namespaceURI: string;
  constructor(tagName: string, namespaceURI: string = HTML_NS) {
    super(1);
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }
  override get nodeName(): string {
    return this.tagName;
  }
  /** A fresh array of name/value pairs; a non-empty class comes first. */
  get attributes(): { name: string; value: string }[] {
    const out = this.attrs ? [...this.attrs].map(([name, value]) => ({ name, value })) : [];
    return this.cls ? [{ name: "class", value: this.cls }, ...out] : out;
  }
  hasAttribute(k: string): boolean {
    return k === "class" ? this.cls !== "" : (this.attrs?.has(k) ?? false);
  }
  /** data-* attributes as a plain object view, enough for h()'s Object.assign. */
  get dataset(): Record<string, string> {
    return new Proxy({} as Record<string, string>, {
      // camelCase key -> data-kebab-case attribute, as the DOM maps them.
      set: (_t, k, v) => {
        this.setAttribute("data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), String(v));
        return true;
      },
    });
  }
  addEventListener(type: string, fn: (e: { type: string; target: FakeNode }) => void): void {
    const map = (this.listeners ??= new Map());
    map.set(type, [...(map.get(type) ?? []), fn]);
  }
  /** Calls this element's listeners for `type` with this element as `this`. */
  fire(type: string): void {
    for (const fn of this.listeners?.get(type) ?? []) fn.call(this, { type, target: this });
  }
  /**
   * Dispatches a bubbling event from this element: at each element up to the
   * top, its listeners and its `on<type>` property run with the element as
   * `this` and as `currentTarget`, until a handler stops propagation.
   */
  dispatchEvent(e: FakeEvent): boolean {
    e.target ??= this;
    for (let n: FakeNode | null = this; n !== null && !e.cancelBubble; n = n.parentNode) {
      if (!(n instanceof FakeElement)) continue;
      e.currentTarget = n;
      for (const fn of n.listeners?.get(e.type) ?? []) fn.call(n, e as unknown as { type: string; target: FakeNode });
      const p = (n as unknown as Record<string, unknown>)["on" + e.type];
      if (typeof p === "function") (p as (this: FakeNode, e: FakeEvent) => void).call(n, e);
    }
    e.currentTarget = null;
    return true;
  }
  setAttribute(k: string, v: string): void {
    if (k === "class") {
      ops.classWrites++;
      this.cls = v;
    } else {
      ops.attrWrites++;
      (this.attrs ??= new Map()).set(k, v);
    }
  }
  getAttribute(k: string): string | null {
    return k === "class" ? this.className || null : (this.attrs?.get(k) ?? null);
  }
  removeAttribute(k: string): void {
    if (k === "class") {
      ops.classWrites++;
      this.cls = "";
    } else {
      ops.attrWrites++;
      this.attrs?.delete(k);
    }
  }
  /** Copies tag, namespace, class and attributes (and children when deep); properties are not copied, as in the DOM. */
  override cloneNode(deep?: boolean): FakeElement {
    ops.clones++;
    const e = new FakeElement(this.tagName, this.namespaceURI);
    e.cls = this.cls;
    if (this.attrs) e.attrs = new Map(this.attrs);
    if (deep) for (let c = this.firstChild; c; c = c.nextSibling) e.appendRaw(c.cloneNode(true));
    return e;
  }
  // Clone-time append that does not count as an insert of the list under test.
  private appendRaw(n: FakeNode): void {
    n.parentNode = this;
    n.previousSibling = this.lastChild;
    if (this.lastChild) this.lastChild.nextSibling = n;
    else this.firstChild = n;
    this.lastChild = n;
  }
  set innerHTML(src: string) {
    this.textContent = "";
    parse(src, this);
  }
  /** A `<template>`'s content: here the element itself holds the parsed children. */
  get content(): FakeElement {
    return this;
  }
}

// #endregion

// #region Markup parser

// One token per match: a comment (1), an end tag (2), a start tag with its
// name (3), attributes (4) and self-closing slash (5), or text (6).
const TOKEN =
  /<!--([\s\S]*?)-->|<\/([a-z0-9-]+)\s*>|<([a-z0-9-]+)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
// One attribute: its name (1) and a double-quoted (2), single-quoted (3) or bare (4) value.
const ATTR = /([^\s=>/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

// Character references, as the HTML parser decodes them in text and
// attribute values: numeric ones, and the common named ones. An unknown name
// stays as written, as in a browser.
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  larr: "←",
  uarr: "↑",
  rarr: "→",
  darr: "↓",
  check: "✓",
};
const REF = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;
/** Decode the character references in `s` (decimal, hex and the names in NAMED). */
export const decode = (s: string): string =>
  // Most strings hold no reference: skip the regex for them.
  s.indexOf("&") < 0
    ? s
    : s.replace(REF, (all, dec?: string, hex?: string, name?: string) =>
        dec !== undefined
          ? String.fromCodePoint(+dec)
          : hex !== undefined
            ? String.fromCodePoint(parseInt(hex, 16))
            : (NAMED[name!] ?? all),
      );

/**
 * Parse `src` into `root`'s children. End tags close the innermost open
 * element whatever their name; void elements must be written self-closing.
 * Resets `ops` at the end: parsing a template is not the work under test.
 */
function parse(src: string, root: FakeElement): void {
  const stack: FakeElement[] = [root];
  for (const m of src.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.appendChild(new FakeComment(m[1]));
    else if (m[2]) stack.pop();
    else if (m[3]) {
      // As the HTML parser does: an svg element and its content are SVG, with case-kept tag names.
      const svg = top.namespaceURI === SVG_NS || m[3].toLowerCase() === "svg";
      const el = svg ? new FakeElement(m[3], SVG_NS) : new FakeElement(m[3].toUpperCase());
      for (const a of (m[4] ?? "").matchAll(ATTR)) el.setAttribute(a[1]!, decode(a[2] ?? a[3] ?? a[4] ?? ""));
      top.appendChild(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.appendChild(new FakeText(decode(m[6])));
  }
  resetOps();
}

// #endregion

// #region Installation

/**
 * Installs a global `document` and `Node` with what the library and h() call.
 * Each call makes a new `document` object; nodes made before keep working.
 */
export function installFakeDocument(): void {
  const g = globalThis as unknown as { document: unknown; Node: unknown };
  g.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    createTextNode: (data: string) => new FakeText(data),
  };
  g.Node = FakeNode;
}

/** Casts a fake node to the DOM type the library's signatures expect. */
export const asDom = <T extends Node = Node>(n: FakeNode): T => n as unknown as T;

// #endregion
