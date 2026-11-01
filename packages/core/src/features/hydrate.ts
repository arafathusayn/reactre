// @reactre/core/features/hydrate: hydration, so the client takes over the HTML that
// @reactre/core/server rendered with `hydrate: true` instead of building the page again.
// `hydrate(App, el)` runs the app over `el`'s content: its templates claim the page's nodes, and
// its holes, handlers, refs and effects attach to them. The rest of the module is what the
// compiler's hydrate mode (`compileJs(js, { hydrate: true })`, @reactre/plugin's `hydrate`
// option) emits in place of the client's calls. plans/core-hydration.md has the design.
//
// How it works:
//
//   - A cursor, the page's next node to claim, is set while hydrating; null otherwise. A
//     template's code (`__hclone`) claims the cursor's element when it is set, walking the
//     template's prototype and the page side by side, and clones as before when it is not. The
//     page's text holes are their own nodes (the server writes `<!---->` between a text hole and
//     the text beside it); one that is empty has no node there, and gets one.
//   - A slot, a list and a fragment's function child are between `<!--[-->` and `<!--]-->` on the
//     page. A template claims the pair whole, and the slot's code takes it: its first run claims
//     the nodes between them (the cursor is set to the first while it runs), and every later run
//     replaces what is between them. The markers stay, as the slot's anchors. A run that reads a
//     value that is not ready yet claims nothing: the page keeps the server's nodes, and the run
//     that has the value claims them.
//   - A list claims its rows in order, one per item, by the row template, and keeps them: its
//     first render inserts nothing.
//   - Where the page does not have what the code builds (a mismatch), the nearest slot renders
//     its content afresh, in place of the server's nodes; outside every slot, the whole app does.
//     The development build warns about it.
//   - @reactre/core's feature modules build their content with `__frag` (a context's provider,
//     `<Errored>`, `<Loading>`, `<Reveal>`, `lazy`, `dynamic()`). In a hydrate build they import
//     the core from here (@reactre/plugin points them here, as a server build points them at
//     @reactre/core/server): this module is the core, with a `__frag` that claims.
//     @reactre/core/hydrate/async and /hydrate/errors are `<Loading>` and `<Errored>` for
//     hydration, where the compiler's hydrate mode points an app's imports of those modules.
//
// Design decisions:
//   - A module of its own, compiled code's target only in the hydrate mode: an app that does not
//     hydrate ships none of it, and the core's own code is as it was, byte for byte.
//   - Lists are the core's: `__hfor` gives the core's list a template whose clone claims, and the
//     list's parent an `insertBefore` that leaves a claimed row where it is, for the first render
//     only. A row's hole nodes are those it claimed.
//   - The development build's warning is between `// #if DEV` markers, as in the core's index.ts:
//     the production builds strip it (dist/features/hydrate.js, and @reactre/plugin's builds of
//     the sources), and dist/dev/features/hydrate.js keeps it.

import { __frag as coreFrag, __insert, __Owned, __owner, __Root, __slot, onCleanup, signal } from "@reactre/core";
import type { Prototype } from "@reactre/dom";

export * from "@reactre/core";

// #region The cursor

/** The page's next node to claim; null while nothing hydrates. */
let C: Node | null = null;

/** What a claim throws where the page does not have what the code builds. */
const MISMATCH = new Error("reactre: the page does not match what hydration renders");

// #if DEV
/** The node the last mismatch found. */
let found: Node | null = null;

/** Warn that the page did not match where `what` renders, found at the last mismatch's node. */
function warnMismatch(what: string): void {
  const n = found as (Node & { data?: string; nodeName: string }) | null;
  const at =
    n === null
      ? "nothing"
      : n.nodeType === 1
        ? `<${n.nodeName.toLowerCase()}>`
        : n.nodeType === 8
          ? `<!--${n.data}-->`
          : `the text "${n.data}"`;
  console.warn(
    `reactre HYDRATION_MISMATCH: the page has ${at} where ${what} renders something else, so it was rendered afresh. Fix: render the same on the server and in the browser (no Date.now(), random values or browser-only reads while rendering)`,
  );
}
// #endif

/**
 * How many times code compiled to claim has run (a template's, a boundary's that reads the
 * cursor): none, after `hydrate`'s view, means it was not compiled to claim.
 */
let claims = 0;

/** What `hydrate` throws for an app whose templates were not compiled to claim. */
const UNCOMPILED =
  "reactre: @reactre/core/features/hydrate needs the app compiled for hydration, and this app's templates clone " +
  "instead of claiming the page. Build with @reactre/plugin's `hydrate: true` option (or @reactre/compiler's " +
  "`hydrate` compile option).";
/** What a mismatch throws on a page with no hydration markers at all. */
const UNMARKED =
  "reactre: @reactre/core/features/hydrate needs the server's HTML rendered with its hydration markers, and this " +
  "page has none. Render it with renderToString(app, { hydrate: true }) (or renderToStream's).";

/** Whether the tree `n` is in holds one of the markers a render with `hydrate: true` writes. */
function marked(n: Node): boolean {
  while (n.parentNode !== null) n = n.parentNode;
  const has = (x: Node): boolean => {
    for (let c = x.firstChild; c !== null; c = c.nextSibling)
      if (mark(c, "[") || mark(c, "]") || mark(c, "") || has(c)) return true;
    return false;
  };
  return has(n);
}

/** A mismatch, at node `n`. */
function miss(n: Node | null): Error {
  // #if DEV
  found = n;
  // #else
  // void n;
  // #endif
  return MISMATCH;
}

/** Whether `n` is a comment holding `data`. */
const mark = (n: Node | null, data: string): boolean => n !== null && n.nodeType === 8 && (n as Comment).data === data;

/** The `<!--]-->` that closes the `<!--[-->` at `open`, among its siblings. */
function closeOf(open: Node): Node {
  let depth = 0;
  for (let n = open.nextSibling; n !== null; n = n.nextSibling)
    if (mark(n, "[")) depth++;
    else if (mark(n, "]") && depth-- === 0) return n;
  throw miss(open);
}

/** The `<!--[-->` that `<!--]-->` at `close` closes, among its siblings. */
function openOf(close: Node): Node {
  let depth = 0;
  for (let n = close.previousSibling; n !== null; n = n.previousSibling)
    if (mark(n, "]")) depth++;
    else if (mark(n, "[") && depth-- === 0) return n;
  throw miss(close);
}

/** Internal (@reactre/core/hydrate/*): the `<!--]-->` that closes the `<!--[-->` at `open`. */
export const __close: (open: Node) => Node = closeOf;
/** Internal (@reactre/core/hydrate/*): the `<!--[-->` that the `<!--]-->` at `close` closes. */
export const __open: (close: Node) => Node = openOf;

/** Run `fn` with the cursor at `at` (null: nothing claims), and put the cursor back after. */
function claimAt<T>(at: Node | null, fn: () => T): T {
  const c = C;
  C = at;
  try {
    return fn();
  } finally {
    C = c;
  }
}

/**
 * Whether the code running now claims the page's nodes: inside `hydrate`, or in a slot's run
 * that claims what the server rendered there.
 */
export function isHydrating(): boolean {
  return C !== null;
}

/** Internal (@reactre/core/hydrate/*): the cursor, the page's next node to claim; null while nothing hydrates. */
export function __cursor(): Node | null {
  claims++;
  return C;
}

/** Internal (@reactre/core/hydrate/*): move the cursor to `n`. */
export function __seek(n: Node | null): void {
  C = n;
}

/** Internal (@reactre/core/hydrate/*): `fn()`, claiming from `at`; with a mismatch, `fn()` again, afresh. */
export function __claim<T>(at: Node | null, fn: () => T, what: string): T {
  try {
    return claimAt(at, fn);
  } catch (e) {
    if (e !== MISMATCH) throw e;
    // #if DEV
    warnMismatch(what);
    // #else
    // void what;
    // #endif
    return claimAt(null, fn);
  }
}

// #endregion

// #region Templates

/** A template's prototype as claiming reads it: its root, and the holes of each of its nodes. */
interface Plan {
  readonly root: Element;
  readonly at: Map<Node, number[]>;
  /** The holes that are two pairs on the page: a list and its fallback. */
  readonly two: readonly number[];
}

/** By template: its plan, made the first time it claims. */
const plans = new WeakMap<Prototype, Plan>();
/** By template: its holes that are two pairs (`__htemplate`). */
const twos = new WeakMap<Prototype, readonly number[]>();

// @reactre/dom's kind codes (`Prototype.kinds`).
const TEXT = 0,
  CLASS = 1,
  PROP = 2,
  SLOT = 4;

/** Template `t`'s plan. */
function planOf(t: Prototype): Plan {
  let p = plans.get(t);
  if (p === undefined) {
    const root = (t as unknown as { root: Element }).root,
      nodes: Node[] = [],
      at = new Map<Node, number[]>();
    t.locate(root, nodes);
    for (let i = 0; i < t.n; i++) {
      const hs = at.get(nodes[i]!);
      if (hs === undefined) at.set(nodes[i]!, [i]);
      else hs.push(i);
    }
    plans.set(t, (p = { root, at, two: twos.get(t) ?? [] }));
  }
  return p;
}

/** Whitespace with a line break: formatting between tags, which a template's prototype drops. */
const FORMATTING = /^\s*\n\s*$/;
/** `n`, or the first sibling after it that is not formatting. */
function unformatted(n: Node | null): Node | null {
  while (n !== null && n.nodeType === 3 && FORMATTING.test((n as Text).data)) n = n.nextSibling;
  return n;
}

/**
 * Claim template `t` at the page's node `s` (text before an element is skipped, as content's
 * strings are claimed after it): check the page against the prototype, and fill `out` with the
 * page's node of each hole, as `t.locate` fills it for a clone. A slot's node is its pair's
 * `<!--]-->`. Then write each value of `vals` the page does not have.
 *
 * @throws MISMATCH where the page does not have a node the template has.
 */
function claimTree(t: Prototype, s: Node | null, out: unknown[], vals: readonly unknown[]): Element {
  while (s !== null && s.nodeType === 3) s = s.nextSibling;
  if (s === null || s.nodeType !== 1) throw miss(s);
  const plan = planOf(t);
  match(t, plan, plan.root, s as Element, out);
  for (let i = 0; i < t.n; i++) {
    const k = t.kinds[i],
      v = vals[i],
      node = out[i] as Node;
    // A reactive hole's value is undefined: its bind writes it, and keeps the page's while it waits.
    if (k === PROP || k === SLOT || v === undefined) continue;
    const str = v == null ? "" : "" + (v as string);
    if (k === TEXT) {
      if ((node as Text).data !== str) t.write(i, node, v);
    } else if (k === CLASS) {
      if ((node as Element).className !== str) t.write(i, node, v);
    } else if (v != null && v !== false && (node as Element).getAttribute(t.names[i]!) !== (v === true ? "" : str))
      // An attribute hole of null is left out on the server too, and an element's own hole (a
      // style, a ref, spread props) holds null: what applies it writes it.
      t.write(i, node, v);
  }
  return s as Element;
}

/** Match the prototype's element `q` to the page's element `s`, recording the holes' nodes in `out`. */
function match(t: Prototype, plan: Plan, q: Node, s: Element, out: unknown[]): void {
  if (s.nodeName !== q.nodeName) throw miss(s);
  const own = plan.at.get(q);
  if (own !== undefined) for (const i of own) out[i] = s;
  // A textarea's text is its value, which the server writes and the client sets as a property.
  if (s.nodeName === "TEXTAREA") return;
  let c: Node | null = s.firstChild,
    // Whether what came last was text, so that a separator may follow it.
    text = false;
  for (let k = q.firstChild; k !== null; k = k.nextSibling) {
    if (k.nodeType === 1) {
      c = unformatted(c);
      if (c === null || c.nodeType !== 1) throw miss(c);
      match(t, plan, k, c as Element, out);
      c = c.nextSibling;
      text = false;
      continue;
    }
    const hs = plan.at.get(k);
    if (hs !== undefined && t.kinds[hs[0]!] === SLOT) {
      // A slot or a list: its pair (two, for a list and its fallback).
      if (!mark(c, "[")) throw miss(c);
      let e = closeOf(c!);
      if (plan.two.includes(hs[0]!)) {
        if (!mark(e.nextSibling, "[")) throw miss(e.nextSibling);
        e = closeOf(e.nextSibling!);
      }
      out[hs[0]!] = e;
      c = e.nextSibling;
      text = false;
      continue;
    }
    if (text && mark(c, "")) c = c!.nextSibling;
    if (hs !== undefined) {
      // A text hole: its own text node, or a new one where it was empty.
      if (c !== null && c.nodeType === 3) {
        out[hs[0]!] = c;
        c = c.nextSibling;
      } else out[hs[0]!] = s.insertBefore(document.createTextNode(""), c);
    } else {
      if (c === null || c.nodeType !== 3 || (c as Text).data !== (k as Text).data) throw miss(c);
      c = c.nextSibling;
    }
    text = true;
  }
  c = unformatted(c);
  if (c !== null) throw miss(c);
}

/**
 * Internal (@reactre/compiler's hydrate mode): `__template` for a template with a list that has a
 * fallback, whose holes `two` are two pairs of markers on the page.
 */
export function __htemplate(t: Prototype, two: readonly number[]): Prototype {
  twos.set(t, two);
  return t;
}

/**
 * Internal (@reactre/compiler's hydrate mode): template `t` with values `vals`, as `t.clone`
 * makes it, with its hole nodes in `n` when it is given. While hydrating, the page's element at
 * the cursor, claimed.
 */
export function __hclone(t: Prototype, vals: readonly unknown[], n?: unknown[]): Element {
  claims++;
  if (C === null) {
    const r = t.clone(vals);
    if (n !== undefined) t.locate(r, n);
    return r;
  }
  const r = claimTree(t, C, n ?? [], vals);
  C = r.nextSibling;
  return r;
}

// #endregion

// #region Slots and content

/** Value `v`'s nodes and strings, in order, as `__insert` would insert them. */
function flat(v: unknown, out: (Node | string)[]): void {
  if (v == null || v === false || v === true) return;
  if (Array.isArray(v)) for (const x of v) flat(x, out);
  else out.push(typeof v === "object" && "nodeType" in (v as object) ? (v as Node) : "" + (v as string));
}

/**
 * Make the nodes between `start` and `end` (from the parent's first child for null) value `v`'s:
 * a node already in its place stays, a string takes the text node in its place, and what is left
 * goes. So content claimed from the page is not moved, and new content replaces the old.
 */
function put(start: Node | null, end: Node, v: unknown): void {
  const p = end.parentNode!,
    items: (Node | string)[] = [];
  flat(v, items);
  const keep = new Set<unknown>(items);
  let s = start === null ? p.firstChild! : start.nextSibling!;
  for (const x of items) {
    if (typeof x === "string") {
      if (s !== end && s.nodeType === 3 && !keep.has(s)) {
        if ((s as Text).data !== x) (s as Text).data = x;
        s = s.nextSibling!;
      } else p.insertBefore(document.createTextNode(x), s);
      continue;
    }
    if (x === s) {
      s = s.nextSibling!;
      continue;
    }
    if (x.parentNode === p) {
      // Later in the range, past what is no one's: what is between goes.
      let n = s;
      while (n !== end && n !== x && !keep.has(n)) n = n.nextSibling!;
      if (n === x) {
        while (s !== x) {
          const next = s.nextSibling!;
          p.removeChild(s);
          s = next;
        }
        s = x.nextSibling!;
        continue;
      }
    }
    p.insertBefore(x, s);
  }
  while (s !== end) {
    const next = s.nextSibling!;
    p.removeChild(s);
    s = next;
  }
}

/** Remove what is between `start` and `end`. */
function clear(start: Node, end: Node): void {
  const p = end.parentNode;
  if (p === null || start.parentNode !== p) return;
  while (start.nextSibling !== end) p.removeChild(start.nextSibling!);
}

/**
 * A slot between the page's markers `start` and `end`: an owned effect that makes what is between
 * them `fn()`'s value. Its first run that ends claims the nodes there; a mismatch renders it
 * afresh in place of them.
 */
function range(start: Node, end: Node, fn: () => unknown): void {
  let claim = true;
  // Written to run the slot again, afresh, after a mismatch.
  const [again, redo] = signal(0);
  if (__owner !== null) onCleanup(() => clear(start, end));
  new __Owned(() => {
    again();
    let v: unknown;
    const c = C;
    C = claim ? start.nextSibling : null;
    try {
      v = fn();
    } catch (e) {
      if (e !== MISMATCH) throw e;
      // #if DEV
      warnMismatch("a slot");
      // #endif
      claim = false;
      // The run after this one disposes what this one made.
      redo((n) => n + 1);
      return;
    } finally {
      C = c;
    }
    claim = false;
    put(start, end, v);
  }).run();
}

/**
 * Internal (@reactre/compiler's hydrate mode): `__slot` at `anchor`, a slot hole's node. A pair of
 * the page's markers claims (see `range`); a clone's anchor is the core's slot.
 */
export function __hslot(anchor: Node, fn: () => unknown): void {
  if (anchor.nodeType !== 8) return __slot(anchor, fn);
  range(openOf(anchor), anchor, fn);
}

/**
 * Internal (@reactre/compiler's hydrate mode): `__insert(anchor, fn(), null)`, content inserted
 * once. A pair of the page's markers: `fn` claims the nodes between them.
 */
export function __hinsert(anchor: Node, fn: () => unknown): void {
  if (anchor.nodeType !== 8) {
    __insert(anchor, fn(), null);
    return;
  }
  const start = openOf(anchor);
  put(start, anchor, claimAt(start.nextSibling, fn));
}

/**
 * The core's `__frag`, for a hydrate build: while hydrating, a child that is a function claims
 * the pair of markers at the cursor as its slot, and any other its nodes at the cursor. The
 * nodes returned are those on the page, markers included. The compiler's hydrate mode passes
 * children it made functions to keep their order in `lazy`: each is called once, as content.
 */
export function __frag(kids: readonly unknown[], lazy?: readonly number[]): Node[] {
  if (C === null) {
    if (lazy === undefined) return coreFrag(kids);
    const k = kids.slice();
    for (const i of lazy) k[i] = (k[i] as () => unknown)();
    return coreFrag(k);
  }
  const out: Node[] = [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (typeof k === "function" && lazy?.includes(i) !== true) {
      const s = C;
      if (!mark(s, "[")) throw miss(s);
      const e = closeOf(s!);
      C = e.nextSibling;
      claims++;
      range(s!, e, k as () => unknown);
      for (let n = s!; ; n = n.nextSibling!) {
        out.push(n);
        if (n === e) break;
      }
      continue;
    }
    const items: (Node | string)[] = [];
    flat(typeof k === "function" ? (k as () => unknown)() : k, items);
    for (const x of items) {
      if (typeof x !== "string") {
        if (x === C) C = x.nextSibling;
        out.push(x);
      } else if (C !== null && C.nodeType === 3 && (C as Text).data.startsWith(x) && x !== "") {
        // The page's text, which the server joined with the strings after it: this string's part.
        const t = C as Text;
        if (t.data !== x) {
          t.parentNode!.insertBefore(document.createTextNode(t.data.slice(x.length)), t.nextSibling);
          t.data = x;
        }
        out.push(t);
        C = t.nextSibling;
      } else out.push(document.createTextNode(x));
    }
  }
  return out;
}

/**
 * Internal (@reactre/compiler's hydrate mode): a `<Portal>`, `fn`, which builds its children on
 * the client, in its mount: the empty pair the server wrote at the cursor is passed over.
 */
export function __hportal(fn: () => unknown): unknown {
  if (mark(C, "[")) C = closeOf(C!).nextSibling;
  return claimAt(null, fn);
}

/**
 * Internal (@reactre/compiler's hydrate mode): `document.createElement(tag)` for a `<Dynamic>` of
 * a tag name chosen at runtime (in SVG, with `svg`): while hydrating, the page's element at the
 * cursor, when it has that tag.
 */
export function __hel(tag: string, svg?: 1): Element {
  const s = C;
  if (s !== null && s.nodeType === 1 && s.nodeName.toLowerCase() === tag.toLowerCase()) {
    C = s.nextSibling;
    claimed.add(s);
    claims++;
    return s as Element;
  }
  return svg === 1 ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
}
/** The elements `__hel` claimed. */
const claimed = new WeakSet<Node>();

/**
 * Internal (@reactre/compiler's hydrate mode): a `<Dynamic>` element's children, `fn()`, inserted
 * once: in an element `__hel` claimed, they claim the pair the server wrote in it.
 */
export function __hkids(el: Element, fn: () => unknown): void {
  const first = el.firstChild;
  if (claimed.has(el) && mark(first, "[")) {
    const end = closeOf(first!);
    put(first, end, claimAt(first!.nextSibling, fn));
  } else __insert(el.appendChild(document.createTextNode("")), fn(), null);
}

// #endregion

// #region Lists

/** A spec's template, as `__hfor` gives it to the core's list. */
type Template = Prototype & { clone(vals: readonly unknown[]): Element };
/** What `__hfor` replaces of a template, for the list. */
type Claiming = {
  clone(vals: readonly unknown[]): Element;
  locate(root: Node, out: unknown[]): void;
  locator(holes: readonly number[]): (root: Node, out: unknown[]) => void;
};

/**
 * Internal (@reactre/compiler's hydrate mode): the list `list` (`__for` or `__forMount`) of `spec`
 * at `anchor`, a slot hole's node. `mode` is 1 when the list is its element's only child (it then
 * takes the element, when it is not hydrated), 2 when it has a fallback (its slot's pair follows
 * the list's on the page). On a pair of the page's markers, the list's first render claims a row
 * per item, in order; from the first row that does not match, the rest are built afresh.
 */
export function __hfor<S extends { readonly t: Prototype }>(
  list: (parent: Element, anchor: Node | null, spec: S) => void,
  anchor: Node,
  spec: S,
  mode: 0 | 1 | 2,
): void {
  const parent = anchor.parentNode as Element;
  if (anchor.nodeType !== 8) {
    if (mode !== 1) return list(parent, anchor, spec);
    parent.removeChild(anchor);
    return list(parent, null, spec);
  }
  const end = mode === 2 ? openOf(anchor).previousSibling! : anchor,
    a = parent.insertBefore(document.createTextNode(""), end),
    t = spec.t as Template,
    rows = new WeakMap<Node, unknown[]>();
  let at: Node | null = openOf(end).nextSibling,
    on = true;
  const w = Object.create(t) as Claiming;
  /** Remove the page's rows from the next one on: they were not claimed. */
  const drop = (): void => {
    while (at !== a) {
      const next: Node | null = at!.nextSibling;
      parent.removeChild(at!);
      at = next;
    }
  };
  w.clone = (vals) => {
    if (on)
      try {
        const out: unknown[] = [];
        const r = claimTree(t, at, out, vals);
        rows.set(r, out);
        at = r.nextSibling;
        claims++;
        return r;
      } catch (e) {
        if (e !== MISMATCH) throw e;
        // #if DEV
        warnMismatch("a <For> row");
        // #endif
        on = false;
        drop();
      }
    return t.clone(vals);
  };
  w.locate = (r, out) => {
    const n = rows.get(r);
    if (n === undefined) t.locate(r, out);
    else for (let i = 0; i < n.length; i++) out[i] = n[i];
  };
  w.locator = (holes) => {
    const l = t.locator(holes);
    return (r, out) => {
      const n = rows.get(r);
      if (n === undefined) l(r, out);
      else for (const h of holes) out[h] = n[h];
    };
  };
  // The first render puts each row before the anchor: a claimed row stays where it is.
  const p = parent as Element & { insertBefore: Node["insertBefore"] },
    insert = p.insertBefore;
  p.insertBefore = function <T extends Node>(this: Element, n: T, ref: Node | null): T {
    return rows.has(n) ? n : (insert.call(this, n, ref) as T);
  } as Node["insertBefore"];
  try {
    // A row's slots claim their own pairs; nothing else in the list claims at the cursor.
    claimAt(null, () => list(parent, a, { ...spec, t: w as unknown as Prototype }));
  } finally {
    delete (p as { insertBefore?: unknown }).insertBefore;
  }
  on = false;
  drop();
}

// #endregion

// #region Hydrating

/**
 * Hydrate the component `view` over `el`'s content, which @reactre/core/server rendered from the
 * same component with `hydrate: true`: the content stays, and the view's holes, handlers, refs
 * and effects attach to it, as `render` would have attached them to content it built. Where the
 * content does not match, the nearest slot renders afresh (the whole view, outside any slot);
 * the development build warns. Returns the function that disposes the view, as `attach` does.
 *
 * The app must be compiled for hydration: @reactre/plugin's `hydrate` option, or
 * @reactre/compiler's `hydrate` compile option.
 *
 * @example
 *   import { hydrate } from "@reactre/core/features/hydrate";
 *
 *   hydrate(App, document.getElementById("app")!);
 */
export function hydrate(view: () => unknown, el: Element): () => void {
  const end = el.appendChild(document.createTextNode(""));
  let root = new __Root();
  let v: unknown;
  const before = claims;
  try {
    v = claimAt(el.firstChild, () => __Owned.within(root, view));
    // Content made of nodes, none of them claimed: templates that cloned.
    const items: (Node | string)[] = [];
    flat(v, items);
    if (claims === before && items.some((x) => typeof x !== "string")) {
      root.dispose();
      el.removeChild(end);
      throw new Error(UNCOMPILED);
    }
  } catch (e) {
    if (e !== MISMATCH) throw e;
    // A mismatch outside every slot, on a page with no markers: it was rendered without them.
    if (!marked(el)) {
      root.dispose();
      el.removeChild(end);
      throw new Error(UNMARKED);
    }
    // #if DEV
    warnMismatch("the app");
    // #endif
    root.dispose();
    root = new __Root();
    v = claimAt(null, () => __Owned.within(root, view));
  }
  put(null, end, v);
  return () => {
    root.dispose();
    while (el.firstChild !== end) el.removeChild(el.firstChild!);
    el.removeChild(end);
  };
}

// #endregion
