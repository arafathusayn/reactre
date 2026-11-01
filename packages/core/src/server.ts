// @reactre/core/server: server-side rendering. `renderToString` renders an app to HTML at once,
// `renderToStream` streams it (the shell first, then each <Loading> boundary's content as its
// async data comes), and `renderToStringAsync` waits for all of it and returns the whole page.
//
// How it works:
//
//   - An SSR build compiles the app with @reactre/compiler's server mode (@reactre/plugin's `ssr`
//     option, or Vite's SSR build), where JSX builds strings: an element tree is its markup with
//     escaped holes, a component is called once with its props, and control flow is evaluated
//     once. What a component returns on the server is an `Html`, markup in parts.
//   - The server mode also points the app's imports of @reactre/core at this module, which is the
//     core with server versions of what touches the DOM, and the plugin points the feature
//     modules' imports of it here too: a context's provider, `<Errored>`, `<Reveal>` and `lazy`
//     run as they are, on the `__frag` below. `<Loading>` and `dynamic()` touch the DOM
//     themselves, so they have server versions (./server/async.ts, ./server/dynamic.ts), and so
//     do the effects of features/reaction, timing and errors (./server/reaction.ts, ...).
//   - Signals and memos work as on the client; the app's effects do not run (this module's
//     `effect` is `__ssrEffect`), and its memos compute when first read (`__ssrMemo`).
//   - Async data: a read that is not ready throws, as on the client. A hole or slot that may
//     change is compiled to a thunk (`__ssrLazy`): when it throws so, it becomes a cell, filled by
//     an effect that runs it again when the value comes, as a hole's effect does on the client.
//     A `<Loading>` counts the cells made under it: with none, it is its children; with some,
//     `renderToString` writes its fallback, and `renderToStream` writes its fallback between
//     markers and sends the children later, in a `<template>` and a script that swaps them in.
//   - A function child of `__frag` (a provider's or a boundary's children) is a cell filled by an
//     owned effect, as a slot is on the client, so @reactre/core/features/errors catches what it
//     throws and `<Errored>` shows its fallback, and context lookups find their provider.
//   - With `hydrate`, the HTML carries comment markers a later hydration step can claim the page
//     by: `<!--[-->`/`<!--]-->` around every slot and list, `<!---->` between a text hole and the
//     text beside it (see plans/core-hydration.md). Without it, the HTML is plain.
//
// Design decisions:
//   - A module of its own: no client bundle ever includes it, and no client runtime profile
//     changes. A browser build that imports it for `isServer` gets ./server.browser.ts; a build for
//     a worker, Deno or an edge runtime (whose conditions may include "browser") gets this module.
//   - The core re-exported whole, so an app module and a feature module see one core: the server
//     build has the same signals, owners and async runtime as the client's code would.
//   - Holes that call nothing are evaluated in place, with no thunk; one that may change costs a
//     closure, and an effect only when it reads a value that is not ready.
//   - `<Portal>` renders nothing on the server: its children belong to another part of the page.

import * as core from "@reactre/core";
import { __Owned, __Root, memo as coreMemo, onCleanup, untrack } from "@reactre/core";

export * from "@reactre/core";

/** True: this is the server build. In a browser bundle, @reactre/core/server's `isServer` is false. */
export const isServer: boolean = true;

// #region Markup

/** A piece of markup: escaped HTML, a cell whose content may still come, or a <Loading> boundary. */
type Part = string | Cell | Boundary;

/**
 * Markup on the server: what server-compiled JSX and components return where the client's return
 * DOM nodes. Its parts are escaped HTML, and the cells and boundaries whose content may still come.
 */
export class Html {
  readonly p: readonly Part[];
  constructor(p: readonly Part[]) {
    this.p = p;
  }
}

const ESCAPE = /[&<>"]/,
  ESCAPES = /[&<>"]/g;
const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** Text escaped for markup, between tags or in a double-quoted attribute value. */
export function escape(s: string): string {
  return ESCAPE.test(s) ? s.replace(ESCAPES, (c) => ENTITY[c]!) : s;
}

/**
 * A character no tag or attribute name written here may hold: whitespace, a control character,
 * a quote, `<`, `>`, `/` or `=`. A name without them (a tag's starting with an ASCII letter) is
 * read back by the HTML parser as that one name; one with them could end the tag and start markup.
 */
const NOT_NAME = /[\0-\x20\x7F-\x9F"'<>/=]/;

/** Append part `p` to `out`, joining it to a string before it. */
function push(out: Part[], p: Part): void {
  if (typeof p !== "string") out.push(p);
  else if (p !== "") {
    const n = out.length - 1;
    if (n >= 0 && typeof out[n] === "string") out[n] += p;
    else out.push(p);
  }
}

/**
 * Append what value `v` renders as content to `out`, as `__insert` inserts it on the client:
 * nothing for null, undefined and booleans, an array's items in order, markup as it is, and
 * anything else as escaped text.
 */
function content(v: unknown, out: Part[]): void {
  if (v == null || typeof v === "boolean") return;
  if (Array.isArray(v)) for (const x of v) content(x, out);
  else if (v instanceof Html) for (const p of v.p) push(out, p);
  else push(out, escape("" + (v as string)));
}

/** Parts for markup: a string is escaped HTML already. */
function parts(m: unknown): readonly Part[] {
  return typeof m === "string" ? [m] : (m as Html).p;
}

/** `p` between slot markers, when the render writes them. */
function slot(p: Part[]): Html {
  if (R !== null && R.hydrate) {
    p.unshift("<!--[-->");
    p.push("<!--]-->");
  }
  return new Html(p);
}

// #endregion

// #region Renders, boundaries and cells

/** What a render writes to: a stream, or the promise of `renderToStringAsync`. */
interface Sink {
  push(s: string): void;
  close(): void;
  error(e: unknown): void;
}

/** The options of the render functions. */
export interface RenderOptions {
  /** Write the markers a hydration step needs (see plans/core-hydration.md). Default false. */
  readonly hydrate?: boolean;
  /** A nonce for the scripts a stream writes, for a Content Security Policy. */
  readonly nonce?: string;
  /** Gets an error thrown after a stream's shell was sent, before the stream errors with it. */
  readonly onError?: (err: unknown) => void;
}

/** How a render writes boundaries that still wait: their fallback, a stream's placeholder, or not yet. */
type Mode = "string" | "stream" | "async";

/** The script that swaps a boundary's content, sent in a `<template>`, in for its fallback. */
const SWAP =
  'self.$rr||(self.$rr=function(i){var d=document,t=d.getElementById("rr:t"+i),w=d.createTreeWalker(d,128),s,e,n;' +
  'while(n=w.nextNode()){if(n.data==="rr:b"+i)s=n;else if(n.data==="/rr:b"+i){e=n;break}}' +
  "var p=s.parentNode;while(s.nextSibling!==e)p.removeChild(s.nextSibling);p.replaceChild(t.content,s);p.removeChild(e);t.remove()})";

/** One render of an app. */
class Render {
  readonly mode: Mode;
  readonly hydrate: boolean;
  readonly options: RenderOptions;
  readonly sink: Sink | null;
  /** What the render's owners and effects belong to; disposed when it ends. */
  readonly root: InstanceType<typeof __Root> = new __Root();
  /** The boundary of what is outside every <Loading>: the shell. */
  readonly top: Boundary;
  /** What the app rendered. */
  shell: readonly Part[] = [];
  /** The call that renders is on the stack: what is thrown goes up it. */
  sync = true;
  done = false;
  /** How many boundaries wait for a cell. */
  busy = 0;
  /** A stream: the shell has been sent. */
  sent = false;
  /** A stream: the boundaries whose fallback was sent, which wait for their content. */
  readonly waiting: Set<Boundary> = new Set();
  /** A stream: the swap script has been sent. */
  script = false;
  /** The ids of a stream's boundaries. */
  ids = 0;
  /** A `check` waits for a microtask (`later`). */
  queued = false;
  constructor(mode: Mode, options: RenderOptions, sink: Sink | null) {
    this.mode = mode;
    this.options = options;
    this.hydrate = options.hydrate === true;
    this.sink = sink;
    this.top = new Boundary(this);
  }

  /** The HTML of `p`: a boundary that waits is its fallback, or in a stream, a placeholder too. */
  html(p: readonly Part[]): string {
    let s = "";
    for (const x of p) {
      if (typeof x === "string") s += x;
      else if (x instanceof Cell) s += this.html(x.v);
      else if (x.n === 0) s += this.html(x.content);
      else if (this.mode === "stream") {
        x.id = this.ids++;
        this.waiting.add(x);
        s += `<!--rr:b${x.id}-->${this.html(x.fallback)}<!--/rr:b${x.id}-->`;
      } else s += this.html(x.fallback);
    }
    return s;
  }

  /** Send what is ready: the shell, then each boundary's content; end once nothing waits. */
  check(): void {
    if (this.done || this.sync) return;
    const sink = this.sink!;
    if (this.mode === "async") {
      if (this.busy !== 0) return;
      const s = this.html(this.shell);
      this.end();
      sink.push(s);
      return sink.close();
    }
    if (!this.sent) {
      if (this.top.n !== 0) return;
      this.sent = true;
      sink.push(this.html(this.shell));
    }
    for (const b of [...this.waiting]) {
      if (b.n !== 0) continue;
      this.waiting.delete(b);
      const nonce = this.options.nonce === undefined ? "" : ` nonce="${escape(this.options.nonce)}"`;
      const html = this.html(b.content);
      const swap = this.script ? "" : `<script${nonce}>${SWAP}</script>`;
      this.script = true;
      sink.push(`${swap}<template id="rr:t${b.id}">${html}</template><script${nonce}>$rr(${b.id})</script>`);
    }
    if (this.waiting.size !== 0) return;
    this.end();
    sink.close();
  }

  /**
   * `check`, in a microtask: a boundary stops waiting as a cell it counted is disposed, which may
   * be in the middle of a run that puts other content in its place (an `<Errored>` showing its
   * fallback for what the cell threw), so what is sent is read once that run has ended.
   */
  later(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.check();
    });
  }

  /** An error after the render's call returned: the stream (or the promise) fails with it. */
  fail(err: unknown): void {
    if (this.done) return;
    this.end();
    this.options.onError?.(err);
    this.sink!.error(err);
  }

  /** Stop: the render's effects stop, and its cleanups run. */
  end(): void {
    this.done = true;
    this.root.dispose();
  }
}

/**
 * A <Loading> boundary (or a render's top): how many of the cells made under it wait, and once
 * it has some, its content and fallback.
 */
class Boundary {
  readonly r: Render;
  n = 0;
  content: readonly Part[] = [];
  fallback: readonly Part[] = [];
  /** In a stream, its placeholder's id, once its fallback was sent. */
  id = -1;
  constructor(r: Render) {
    this.r = r;
  }
  wait(): void {
    if (this.n++ === 0) this.r.busy++;
  }
  done(): void {
    if (--this.n !== 0) return;
    this.r.busy--;
    this.r.later();
  }
}

/** The render under way, and the boundary what it makes now belongs to. */
let R: Render | null = null,
  B: Boundary | null = null;

/** What reading a value that is not ready throws; only the core's async build has it. */
const NotReady = (core as { __NotReadyError?: new () => Error }).__NotReadyError;
const notReady = (e: unknown): boolean => NotReady !== undefined && e instanceof NotReady;

/**
 * Content that may come later: a hole or a slot whose value was not ready, or a function child
 * of `__frag`. An effect fills it; until it has, its boundary counts it.
 */
class Cell {
  v: readonly Part[] = [];
  /** It counts in its boundary. */
  pend = false;
  /** Its owner went: it no longer counts. */
  dead = false;
  readonly r: Render;
  readonly b: Boundary;
  readonly o: typeof core.__owner;
  constructor() {
    if (R === null) throw new Error("reactre: server markup that waits for a value is made outside a render");
    this.r = R;
    this.b = B!;
    this.o = core.__owner;
  }
  /** Run `make` now, and again when what it read changes, as the cell's content. */
  fill(make: () => unknown): void {
    onCleanup(() => this.drop());
    new __Owned(() => {
      const r = R,
        b = B;
      R = this.r;
      B = this.b;
      try {
        this.put(make());
      } catch (e) {
        // Not ready: it counts until the effect runs again with the value.
        if (notReady(e)) {
          this.wait();
          throw e;
        }
        if (this.r.sync) throw e;
        this.fail(e);
      } finally {
        R = r;
        B = b;
      }
    }).run();
  }
  wait(): void {
    if (this.pend || this.dead) return;
    this.pend = true;
    this.b.wait();
  }
  put(m: unknown): void {
    this.v = parts(m);
    if (this.pend) {
      this.pend = false;
      this.b.done();
    }
  }
  drop(): void {
    this.dead = true;
    if (this.pend) {
      this.pend = false;
      this.b.done();
    }
  }
  /**
   * What a later run threw: thrown again in a run of its own, under the cell's owner, so the
   * nearest `<Errored>` (@reactre/core/features/errors) gets it; with none, the render fails.
   */
  fail(e: unknown): void {
    try {
      __Owned.within(this.o, () =>
        new __Owned(() => {
          throw e;
        }).run(),
      );
    } catch (err) {
      return this.r.fail(err);
    }
    // A boundary took it: it disposes this cell as it shows its fallback.
    queueMicrotask(() => {
      if (this.pend) this.r.fail(e);
    });
  }
}

// #endregion

// #region What server-compiled code calls

/** Internal: an element tree's markup, its strings between its holes' markup (`__ssrText`, ...). */
export function __ssr(t: readonly string[], ...v: unknown[]): Html {
  const out: Part[] = [];
  push(out, t[0]!);
  for (let i = 0; i < v.length; i++) {
    for (const p of parts(v[i])) push(out, p);
    push(out, t[i + 1]!);
  }
  return new Html(out);
}

/**
 * Internal: a text hole's markup. `sep` says whether text is beside it, before (1) or after (2):
 * with `hydrate`, a marker separates them, so the hole is a text node of its own.
 */
export function __ssrText(v: unknown, sep: number): string {
  const s = v == null ? "" : escape("" + (v as string));
  if (sep === 0 || R === null || !R.hydrate) return s;
  return (sep & 1 ? "<!---->" : "") + s + (sep & 2 ? "<!---->" : "");
}

/** Internal: an attribute: none for null, undefined and false, present and empty for true. */
export function __ssrAttr(v: unknown, name: string): string {
  if (v == null || v === false) return "";
  return v === true ? ` ${name}` : ` ${name}="${escape("" + (v as string))}"`;
}

/** Internal: a class hole: its value as a string, the attribute left out when it is empty. */
export function __ssrClass(v: unknown): string {
  const s = v == null ? "" : "" + (v as string);
  return s === "" ? "" : ` class="${escape(s)}"`;
}

/** A style object's property name in CSS: `fontSize` is `font-size`; a custom property is kept. */
const cssName = (k: string): string => (k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));

/** The CSS text of a `style` value: a string as it is, an object's properties but null and false. */
function css(v: unknown): string {
  if (v == null || typeof v !== "object") return v == null ? "" : "" + (v as string);
  let s = "";
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (x != null && x !== false) s += `${s ? ";" : ""}${cssName(k)}:${x as string}`;
  return s;
}

/** Internal: a `style` attribute, from a string or an object; none when it is empty. */
export function __ssrStyle(v: unknown): string {
  const s = css(v);
  return s === "" ? "" : ` style="${escape(s)}"`;
}

/**
 * Internal: spread props as attributes, as `__spread` applies them on the client: handlers, refs,
 * `children` and `key` are left out, `className` is `class`, `htmlFor` is `for`, `style` takes an
 * object, and a later prop of a name wins. A key that is not one attribute name (empty, or with
 * whitespace, a quote, `<`, `>`, `/`, `=` or a control character) is left out, as Solid 2.0 leaves
 * it: written, it could end the tag and start markup of its own.
 */
export function __ssrAttrs(v: unknown): string {
  const attrs = new Map<string, string>();
  for (const [k, x] of Object.entries((v ?? {}) as Record<string, unknown>)) {
    if (k === "children" || k === "key" || k === "ref" || /^on[A-Z]/.test(k) || k === "" || NOT_NAME.test(k)) continue;
    const name = k === "className" ? "class" : k === "htmlFor" ? "for" : k;
    attrs.set(name, name === "style" ? __ssrStyle(x) : name === "class" ? __ssrClass(x) : __ssrAttr(x, name));
  }
  return [...attrs.values()].join("");
}

/**
 * Internal: a class list taken apart while compiling: its literal classes, then each toggle's
 * class added when its value is truthy and taken out when it is not, as `classList.toggle` does.
 */
export function __ssrClasses(classes: string, toggles: readonly (readonly [string, unknown])[]): string {
  let list = classes === "" ? [] : classes.split(" ");
  for (const [c, on] of toggles) {
    if (!on) list = list.filter((x) => x !== c);
    else if (!list.includes(c)) list.push(c);
  }
  return list.length === 0 ? "" : ` class="${escape(list.join(" "))}"`;
}

/** Internal: a slot's markup: what `v` renders as content (see `content`), between slot markers. */
export function __ssrSlot(v: unknown): Html {
  const out: Part[] = [];
  content(v, out);
  return slot(out);
}

/** Internal: what `v` renders as content, without markers: a fragment's child inserted once. */
export function __ssrInsert(v: unknown): Html {
  const out: Part[] = [];
  content(v, out);
  return new Html(out);
}

/**
 * Internal: the markup `fn` makes, for a hole or a slot that may change, read untracked. When it
 * reads a value that is not ready, a cell that an effect fills when the value comes.
 */
export function __ssrLazy(fn: () => unknown): unknown {
  try {
    return untrack(fn);
  } catch (e) {
    if (!notReady(e)) throw e;
  }
  const c = new Cell();
  c.fill(() => untrack(fn));
  return new Html([c]);
}

/**
 * Internal: a `<For>`'s markup: each item's row, then its fallback while `each` is empty, each
 * between slot markers. A row gets its item, or with `index` (`keyed={false}`), an accessor of it;
 * and its index.
 */
export function __ssrFor<T>(
  each: readonly T[] | null | undefined,
  row: (item: T | (() => T), i: number) => unknown,
  fallback: (() => unknown) | undefined,
  index: boolean,
): Html {
  const rows: Part[] = [];
  const n = each == null ? 0 : each.length;
  for (let i = 0; i < n; i++) {
    const item = each![i]!;
    content(row(index ? () => item : item, i), rows);
  }
  const out = slot(rows).p as Part[];
  if (fallback === undefined) return new Html(out);
  for (const p of __ssrSlot(n === 0 ? fallback() : null).p) push(out, p);
  return new Html(out);
}

/** Internal: a `<Repeat count from>`'s markup: a row per index, from `from` to `from + count - 1`. */
export function __ssrRepeat(
  count: number,
  from: number | undefined,
  row: (i: number) => unknown,
  fallback: (() => unknown) | undefined,
): Html {
  const start = from ?? 0;
  return __ssrFor(
    Array.from({ length: count }, (_, i) => start + i),
    row as (i: unknown) => unknown,
    fallback,
    false,
  );
}

/** Elements that have no closing tag and take no children. */
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));

/**
 * Internal: tag `tag`'s element with `props` as spread props (`__ssrAttrs`) and their children,
 * as `<Dynamic>` and `dynamic()` build one for a tag name chosen at runtime.
 *
 * @throws Error for a tag that is not one element name: a string that starts with an ASCII letter
 *   and holds no whitespace, quote, `<`, `>`, `/`, `=` or control character. The client's
 *   `createElement` throws for one too, and Solid 2.0's server does ("is not a valid tag name").
 */
export function __ssrElement(tag: string, props: Record<string, unknown>): Html {
  if (typeof tag !== "string" || !/^[a-zA-Z]/.test(tag) || NOT_NAME.test(tag))
    throw new Error(`reactre: "${String(tag)}" is not a valid tag name`);
  const open = `<${tag}${__ssrAttrs(props)}>`;
  if (VOID.has(tag)) return new Html([open]);
  const out: Part[] = [open];
  if (props["children"] != null) for (const p of __ssrSlot(props["children"]).p) push(out, p);
  push(out, `</${tag}>`);
  return new Html(out);
}

/**
 * Internal: @reactre/core's `__frag` on the server, for the feature modules (a context's provider,
 * `<Errored>`, `lazy`, ...): its children's markup. A child that is a function is a slot: a cell
 * filled by an owned effect, which follows what it reads, so a boundary's error handling and a
 * provider's scope apply to what it builds, as on the client.
 */
export function __frag(kids: readonly unknown[]): Html {
  const out: Part[] = [];
  for (const k of kids) {
    if (typeof k !== "function") {
      content(k, out);
      continue;
    }
    const c = new Cell();
    c.fill(() => __ssrInsert((k as () => unknown)()));
    for (const p of slot([c]).p) push(out, p);
  }
  return new Html(out);
}

/**
 * Internal: `<Loading>` on the server (@reactre/core/server/async exports it as `Loading`). Its
 * children are built at once, as on the client. When nothing under it waits, they are its markup;
 * otherwise `renderToString` writes its fallback, and a stream its fallback until they are ready.
 */
export function __ssrLoading(props: { fallback?: unknown; children?: unknown }): Html {
  const up = B;
  if (R === null) throw new Error("reactre: <Loading> is rendered outside a render");
  const b = new Boundary(R);
  B = b;
  try {
    b.content = __frag([
      () => {
        const c = props.children;
        return typeof c === "function" ? (c as () => unknown)() : c;
      },
    ]).p;
  } finally {
    B = up;
  }
  if (b.n === 0) return new Html(b.content);
  // The fallback is outside the boundary: what it waits for, the boundary above waits for.
  b.fallback = __frag([() => props.fallback]).p;
  return new Html([b]);
}

/**
 * Internal: `effect` in a module compiled for the server: an effect does not run there. It is
 * this module's `effect` too, so an app's effect does not run however the app reaches it (a
 * namespace import, a re-export); the core's feature modules, whose own effects compute what they
 * return (a projection, a derived signal, `resolve`), import the core's (@reactre/compiler's
 * `serverImports`).
 */
export function __ssrEffect(_fn: () => void, _options?: unknown): void {}
export { __ssrEffect as effect };

/**
 * Internal: `memo` in a module compiled for the server: computed when first read, then kept. A
 * function that returns a Promise or an AsyncIterable is an async memo, as on the client.
 */
export function __ssrMemo<T>(fn: () => T): () => T {
  let state = 0,
    v: T,
    read: (() => T) | undefined;
  return () => {
    if (state === 1) return v;
    if (read !== undefined) return read();
    const r = fn();
    if (r !== null && typeof r === "object" && ("then" in r || Symbol.asyncIterator in r)) {
      let first = true;
      read = coreMemo(() => (first ? ((first = false), r) : fn()));
      return read();
    }
    state = 1;
    return (v = r);
  };
}

// #endregion

// #region Rendering

/** Render `app` under a new render's root, with the render and its top boundary current. */
function start(mode: Mode, app: () => unknown, options: RenderOptions, sink: Sink | null): Render {
  const r = new Render(mode, options, sink),
    pr = R,
    pb = B;
  R = r;
  B = r.top;
  try {
    r.shell = __ssrInsert(__Owned.within(r.root, app)).p;
  } catch (e) {
    r.end();
    throw e;
  } finally {
    R = pr;
    B = pb;
    r.sync = false;
  }
  return r;
}

/**
 * Render the component `app` to HTML, synchronously. A `<Loading>` whose children read a value
 * that is not ready yet renders its fallback; a hole that reads one outside any `<Loading>`,
 * nothing. The render's effects stop and its cleanups run before it returns.
 *
 * @example
 *   import { renderToString } from "@reactre/core/server";
 *
 *   const html = renderToString(() => <App url={request.url} />);
 */
export function renderToString(app: () => unknown, options: RenderOptions = {}): string {
  const r = start("string", app, options, null);
  try {
    return r.html(r.shell);
  } finally {
    r.end();
  }
}

/**
 * Render the component `app` to a stream of HTML: the shell once what it reads outside every
 * `<Loading>` is ready, with each `<Loading>` that still waits showing its fallback; then each
 * one's content as it is ready, in a `<template>` with a script that puts it in place of the
 * fallback. The stream ends when nothing waits. Cancelling it stops the render.
 *
 * An error thrown while the shell renders errors the stream. One thrown later goes to the nearest
 * `<Errored>` inside a boundary still to come; with none, `onError` gets it and the stream errors.
 *
 * @example
 *   import { renderToStream } from "@reactre/core/server";
 *
 *   return new Response(renderToStream(() => <App />), { headers: { "content-type": "text/html" } });
 */
export function renderToStream(app: () => unknown, options: RenderOptions = {}): ReadableStream<Uint8Array> {
  let r: Render | undefined;
  return new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      try {
        r = start("stream", app, options, {
          push: (s) => c.enqueue(enc.encode(s)),
          close: () => c.close(),
          error: (e) => c.error(e),
        });
      } catch (e) {
        // The stream errors with what the shell threw.
        return c.error(e);
      }
      r.check();
    },
    cancel() {
      r?.end();
    },
  });
}

/**
 * Render the component `app` to HTML once everything it reads is ready: the whole page, every
 * `<Loading>` with its children, and no script.
 *
 * @example
 *   const html = await renderToStringAsync(() => <App />);
 */
export function renderToStringAsync(app: () => unknown, options: RenderOptions = {}): Promise<string> {
  return new Promise<string>((ok, no) => {
    let html = "";
    start("async", app, options, { push: (s) => (html = s), close: () => ok(html), error: no }).check();
  });
}

// #endregion
