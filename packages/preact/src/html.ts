// `html`: JSX's elements as a tagged template, for apps with no JSX and no build step.
//
//   html`<ul class=${cls}>${items.map((i) => html`<li key=${i.id}>${i.name}</li>`)}</ul>`
//   html`<${Counter} start=${1} />`        a component, closed with `/>`, `</${Counter}>` or `<//>`
//   html`<p ...${props}>${a} and ${b}</p>` spread props, text and values mixed
//
// A template is parsed once per call site, and each element tree in it becomes what
// @reactre/preact/compiler makes of the same JSX: host trees are compiled templates (blocks),
// built once and cloned, and the rest are vnodes. So a tagged template renders exactly what the
// same JSX renders on Preact. Text follows JSX's whitespace rules: a run of text that spans
// lines is trimmed line by line, and whitespace with a line break in it is no text at all.
// HTML entities are not decoded.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { __block, __template } from "./block.ts";
import { type Any, createElement } from "./engine.ts";
import { reactName, reactValue, templatable, UNCLONED } from "./rules.ts";

// #region Parsing

/** A value of the call: its index in the values. */
type Hole = { i: number };
/** An attribute: a name and true, a string, a hole or text and holes; or a spread (name null). */
type Attr = [string | null, true | string | Hole | (string | Hole)[]];
/** An element: its tag (a hole for a component), attributes and children. */
type El = { t: string | Hole; a: Attr[]; c: Kid[] };
type Kid = string | Hole | El;

/** Parse a template's strings into its top-level nodes. */
function parse(strings: readonly string[]): Kid[] {
  // One item per character, and the index of the value between two strings.
  const items: (string | number)[] = [];
  strings.forEach((s, k) => {
    for (const ch of s) items.push(ch);
    if (k < strings.length - 1) items.push(k);
  });
  let p = 0;
  const peek = (s: string): boolean => {
    for (let j = 0; j < s.length; j++) if (items[p + j] !== s[j]) return false;
    return true;
  };
  const space = () => {
    while (typeof items[p] == "string" && /\s/.test(items[p] as string)) p++;
  };
  /** Characters up to (not including) one that `stop` accepts, or a value. */
  const chars = (stop: RegExp): string => {
    let s = "";
    while (p < items.length && typeof items[p] == "string" && !stop.test(items[p] as string)) s += items[p++];
    return s;
  };

  const nodes = (): Kid[] => {
    const out: Kid[] = [];
    let text = "";
    const flush = () => {
      const t = jsxText(text);
      if (t) out.push(t);
      text = "";
    };
    while (p < items.length) {
      const it = items[p]!;
      if (typeof it == "number") {
        flush();
        out.push({ i: it });
        p++;
      } else if (peek("<!--")) {
        while (p < items.length && !peek("-->")) p++;
        p += 3;
      } else if (peek("</")) {
        // A closing tag: `</p>`, `</${C}>` or `<//>`. It ends the element being parsed.
        while (p < items.length && items[p] !== ">") p++;
        p++;
        break;
      } else if (it == "<") {
        flush();
        out.push(element());
      } else {
        text += it;
        p++;
      }
    }
    flush();
    return out;
  };

  const element = (): El => {
    p++;
    const t: string | Hole = typeof items[p] == "number" ? { i: items[p++] as number } : chars(/[\s/>]/);
    const a: Attr[] = [];
    for (;;) {
      space();
      if (peek("/>")) {
        p += 2;
        return { t, a, c: [] };
      }
      if (items[p] == ">" || p >= items.length) {
        p++;
        return { t, a, c: nodes() };
      }
      if (peek("...") && typeof items[p + 3] == "number") {
        a.push([null, { i: items[p + 3] as number }]);
        p += 4;
        continue;
      }
      const name = chars(/[\s=/>]/);
      if (!name) {
        // A value where a name should be: not JSX, so not a prop.
        p++;
        continue;
      }
      if (items[p] != "=") {
        a.push([name, true]);
        continue;
      }
      p++;
      const q = items[p];
      if (typeof q == "number") {
        a.push([name, { i: q }]);
        p++;
      } else if (q == '"' || q == "'") {
        p++;
        const parts: (string | Hole)[] = [];
        let s = "";
        while (p < items.length && items[p] !== q) {
          const c = items[p++]!;
          if (typeof c == "number") {
            if (s) parts.push(s);
            s = "";
            parts.push({ i: c });
          } else s += c;
        }
        p++;
        if (s || !parts.length) parts.push(s);
        a.push([name, parts.length == 1 ? parts[0]! : parts]);
      } else a.push([name, chars(/[\s>]/)]);
    }
  };

  return nodes();
}

/** A run of text as JSX keeps it: lines trimmed, joined by a space, blank lines dropped. */
function jsxText(s: string): string {
  if (!/[\r\n]/.test(s)) return s;
  const lines = s.split(/\r\n|\n|\r/);
  let out = "";
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, " ");
    if (i > 0) l = l.replace(/^ +/, "");
    if (i < lines.length - 1) l = l.replace(/ +$/, "");
    if (l) out += (out ? " " : "") + l;
  });
  return out;
}

// #endregion

// #region Building

/** What a node is, given the call's values. */
type Make = (v: readonly Any[]) => Any;

/** Whether a parsed item is a value (an element has a tag; text parts are strings or arrays). */
const isHole = (x: Any): x is Hole => typeof x == "object" && "i" in x;

/** An attribute's value for a call. */
const valueOf = (x: Attr[1]): Make =>
  isHole(x) ? (v) => v[x.i] : Array.isArray(x) ? (v) => x.map((y) => (isHole(y) ? v[y.i] : y)).join("") : () => x;

/** The JSX of a tagged template's nodes, built by `react` (compat's prop names) or Preact's rules. */
function builder(react: boolean) {
  /** A node as JSX makes it: a template if it is a host tree that compiles, else a vnode. */
  const make = (k: Kid): Make => {
    if (typeof k == "string") return () => k;
    if (isHole(k)) return (v) => v[k.i];
    return (typeof k.t == "string" && block(k, true)) || vnode(k);
  };

  /** A vnode from createElement: components, and elements a template cannot be. */
  const vnode = (el: El): Make => {
    const type = el.t,
      attrs = el.a.map(([n, x]) => [n, valueOf(x)] as const),
      kids = el.c.map(make);
    return (v) => {
      const props: Any = {};
      for (const [n, f] of attrs) {
        if (n === null) Object.assign(props, f(v));
        else props[n] = f(v);
      }
      return createElement(isHole(type) ? v[type.i] : type, props, ...kids.map((f) => f(v)));
    };
  };

  /**
   * A host element as a template, with its holes' values pushed onto `holes`; false when it
   * cannot be one (`holes` as it was). The root may carry a key; an element inside may not.
   */
  const desc = (el: El, root: boolean, holes: Make[]): Any[] | false => {
    const tag = el.t as string;
    if (el.a.some(([n]) => n === null)) return false;
    const names = el.a.map(([n]) => n as string);
    if (!root && names.includes("key")) return false;
    if (
      !templatable(
        tag,
        names.filter((n) => n != "key"),
      )
    )
      return false;
    let attrs = el.a.filter(([n]) => n != "key") as [string, Attr[1]][];
    // compat's vnode hook writes class (or className) after every other prop.
    if (react) attrs = attrs.slice().sort((a, b) => +/^class(Name)?$/.test(a[0]) - +/^class(Name)?$/.test(b[0]));
    const ps: Any = {};
    // Once one prop is a hole, the literals after it are holes too, so attributes keep Preact's order.
    let dynamic = false;
    for (const [name, x] of attrs) {
      const key = react ? reactName(name) : name;
      let lit: Any = typeof x == "string" || x === true ? x : undefined;
      if (react && lit !== undefined) lit = reactValue(key, lit);
      if (!dynamic && !UNCLONED.has(name) && (typeof x == "string" || x === true)) {
        if (lit !== undefined) ps[key] = lit;
      } else {
        dynamic = true;
        ps[key] = [holes.length];
        holes.push(valueOf(x));
      }
    }
    const d: Any[] = [tag, Object.keys(ps).length ? ps : 0];
    if (!el.c.length) return d;
    // Every child static (text, or a host element that compiles): inline them all.
    const m = holes.length;
    const statics: Any[] = [];
    for (const k of el.c) {
      const s = typeof k == "string" ? k : isHole(k) || typeof k.t != "string" ? false : desc(k, false, holes);
      if (s === false) {
        // One children hole instead: the value JSX gives props.children.
        holes.length = m;
        const kids = el.c.map(make);
        d.push(holes.length);
        holes.push(kids.length == 1 ? kids[0]! : (v) => kids.map((f) => f(v)));
        return d;
      }
      statics.push(s);
    }
    d.push(...statics);
    return d;
  };

  /** A host tree as a template and a block per call, or null when it cannot be one. */
  const block = (el: El, root: boolean): Make | null => {
    const holes: Make[] = [];
    const d = desc(el, root, holes);
    if (!d) return null;
    const t = __template(d as Any);
    const keyAttr = el.a.find(([n]) => n == "key");
    const key = keyAttr ? valueOf(keyAttr[1]) : () => undefined;
    return (v) =>
      __block(
        t,
        key(v),
        holes.map((f) => f(v)),
      );
  };

  const cache = new WeakMap<TemplateStringsArray, Make>();
  return function html(strings: TemplateStringsArray, ...values: Any[]): Any {
    let f = cache.get(strings);
    if (!f) {
      const kids = parse(strings).map(make);
      f = kids.length == 1 ? kids[0]! : (v) => kids.map((g) => g(v));
      cache.set(strings, f);
    }
    return f(values);
  };
}

// #endregion

/** JSX's elements, Preact's prop names, as a tagged template: html`<p class=${c}>${text}</p>`. */
export const html: (strings: TemplateStringsArray, ...values: Any[]) => Any = /* @__PURE__ */ builder(false);

/** The same, with React's prop names (className, onDoubleClick, strokeWidth), for compat apps. */
export const reactHtml: (strings: TemplateStringsArray, ...values: Any[]) => Any = /* @__PURE__ */ builder(true);
