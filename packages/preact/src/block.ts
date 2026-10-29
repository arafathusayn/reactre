// Compiled templates (blocks): a tree of host elements that @reactre/preact/compiler found in JSX,
// built once per namespace, cloned per use, with only its holes written.
//
// A block renders exactly what Preact renders for the same JSX:
//   - a prop hole is written with Preact's setProperty when its value changed (!==), as
//     diffElementNodes writes a prop;
//   - a children hole is the only child of its element, and its value is the element's
//     `props.children` as Preact would see it, diffed by Preact's diffChildren. Children keep
//     Preact's matching by key and type, and its placement;
//   - static props are set once on the prototype. One that lives in a DOM property the clone
//     does not copy (the browser decides; checked once per template) is set again on each clone.
// A block vnode is a host vnode: its type is its root's tag, so it matches an old element of
// that tag and key as Preact matches elements. When it meets anything but a block of its own
// template (a plain element, another template, a server node to hydrate), it and the old vnode
// become plain vnodes over the same DOM, and Preact's element diff takes over: rarer, slower,
// and the same result.
//
// The compiler leaves out what depends on more than attributes: refs, keys inside the tree,
// spread props, dangerouslySetInnerHTML, form fields and custom elements.

import {
  type Any,
  blockHooks,
  createVNode,
  diffChildren,
  diffElementNodes,
  EMPTY_OBJ,
  FORCE_PROPS_REVALIDATE,
  getDomSibling,
  isArray,
  MATH_NAMESPACE,
  NULL,
  setProperty,
  slots,
  SVG_NAMESPACE,
  VNODE_MARKER,
  XHTML_NAMESPACE,
} from "./engine.ts";

// #region Templates

/**
 * A template's description, the compiler's JSON: [tag, props, ...children]. A prop value
 * `{ h: i }` is hole i; a child is text, an element, or (as the only child) the index of a
 * children hole. Props are 0 when there are none.
 */
export type Desc = [string, Record<string, Any> | 0, ...(string | number | Desc)[]];

/** A template: its description, and what is built from it per namespace. */
interface Template {
  readonly d: Desc;
  /** Built, by the namespace the root is created in. */
  readonly b: Record<string, Built>;
}

/** A template built in one namespace. */
interface Built {
  /** The prototype every use clones. */
  p: Any;
  /** Path (child indexes) from the root to each element a hole or replay writes. */
  paths: number[][];
  /** Per hole: the element it writes (an index into paths). */
  el: number[];
  /** Per hole: the prop name, or null for a children hole. */
  nm: (string | null)[];
  /** Per hole: the namespace its props are written in, or its children rendered in. */
  ns: string[];
  /** Per children hole: its element's depth under the root. */
  dp: number[];
  /** Per children hole: its element's tag. */
  tg: string[];
  /** Static props the clone loses: element, name, value, namespace. */
  replay: Any[];
}

/**
 * The template for `desc`; the compiler hoists each call to module scope. The first one installs
 * the block renderer into the engine, so an app with no compiled JSX bundles none of it.
 */
export function __template(desc: Desc): Template {
  if (!slots.block) install();
  return { d: desc, b: {} };
}

/** A hole in a prop: `{ h: index }`. */
const isHole = (v: Any): boolean => typeof v == "object" && v !== NULL;

/** The namespace an element with `tag` is created in, inside `parentNs`. */
const nsOf = (tag: string, parentNs: string): string =>
  tag == "svg" ? SVG_NAMESPACE : tag == "math" ? MATH_NAMESPACE : parentNs || XHTML_NAMESPACE;

/** The namespace of `tag`'s children: foreignObject and MathML token elements hold HTML. */
const childNsOf = (tag: string, ns: string): string =>
  tag == "foreignObject" || (ns == MATH_NAMESPACE && /^m(i|n|o|s|text|space)$/.test(tag)) ? XHTML_NAMESPACE : ns;

/** Whether setProperty writes `name` on `dom` as a DOM property (Preact's `in` rule). */
const viaProperty = (dom: Any, name: string, ns: string): boolean =>
  ns != SVG_NAMESPACE &&
  name != "style" &&
  !(name[0] == "o" && name[1] == "n") &&
  !/^(width|height|href|list|form|tabIndex|download|rowSpan|colSpan|role|popover)$/.test(name) &&
  name in dom;

/** Build template `t` with its root in namespace `ns`. */
function build(t: Template, ns: string): Built {
  const b: Built = { p: NULL, paths: [], el: [], nm: [], ns: [], dp: [], tg: [], replay: [] };
  /** Static props set as DOM properties, to check against a clone: element, path, name, value, ns. */
  const props: Any[] = [];
  const at = (path: number[]): number => b.paths.push(path) - 1;
  const make = (d: Desc, ns: string, path: number[], depth: number): Any => {
    const tag = d[0],
      ps = d[1],
      dom = document.createElementNS(ns, tag);
    let own = -1;
    const index = () => (own < 0 ? (own = at(path)) : own);
    if (ps)
      for (const raw in ps) {
        const name = blockHooks.n ? blockHooks.n(raw) : raw;
        let v = ps[raw];
        if (isHole(v)) {
          b.el[v.h] = index();
          b.nm[v.h] = name;
          b.ns[v.h] = ns;
        } else {
          if (blockHooks.v) v = blockHooks.v(name, v);
          // As on a mount: a prop set to undefined is not written.
          if (v !== undefined) {
            setProperty(dom, name, v, undefined, ns);
            if (viaProperty(dom, name, ns)) props.push(dom, path, name, v, ns);
          }
        }
      }
    const cns = childNsOf(tag, ns);
    let k = 0;
    for (let i = 2; i < d.length; i++) {
      const c = d[i]!;
      if (typeof c == "string") {
        dom.appendChild(document.createTextNode(c));
        k++;
      } else if (typeof c == "number") {
        b.el[c] = index();
        b.nm[c] = NULL;
        b.ns[c] = cns;
        b.dp[c] = depth;
        b.tg[c] = tag;
      } else dom.appendChild(make(c, nsOf(c[0], cns), path.concat(k++), depth + 1));
    }
    return dom;
  };
  b.p = make(t.d, ns, [], 0);
  // A property the clone does not carry (it lives in the DOM object, not in an attribute) is
  // written on every clone.
  if (props.length) {
    const clone = b.p.cloneNode(true);
    for (let i = 0; i < props.length; i += 5) {
      const name = props[i + 2];
      if (walk(clone, props[i + 1])[name] !== props[i][name]) b.replay.push(at(props[i + 1]), name, props[i + 3], props[i + 4]);
    }
  }
  return (t.b[ns] = b);
}

/** The node at `path` under `root`. */
function walk(root: Any, path: number[]): Any {
  let n = root;
  for (let i = 0; i < path.length; i++) {
    n = n.firstChild;
    for (let j = path[i]!; j > 0; j--) n = n.nextSibling;
  }
  return n;
}

// #endregion

// #region Block vnodes

let blockId = 0;

/**
 * A block vnode: a host vnode (its type is the root's tag) whose props are the template's
 * statics and holes, built only when something reads them.
 */
class Block {
  type: string;
  key: Any;
  ref: Any = NULL;
  __k: Any = NULL;
  __: Any = NULL;
  __b = 0;
  __e: Any = NULL;
  __c: Any = NULL;
  __v: number;
  __i = -1;
  __u = 0;
  /** The template; undefined once the block became a plain vnode. */
  __t: Template | undefined;
  /** The hole values. */
  __a: Any[];
  /** The elements the holes write, once mounted. */
  __h: Any[] | undefined = undefined;
  /** The props, once read. */
  __p: Any = undefined;
  constructor(t: Template, key: Any, values: Any[], original: number) {
    this.type = t.d[0];
    this.key = key;
    this.__v = original;
    this.__t = t;
    this.__a = values;
  }
  /** The props JSX would have given the root element. */
  get props(): Any {
    return this.__p || (this.__p = propsOf(this.__t!.d, this.__a));
  }
  set props(v: Any) {
    this.__p = v;
  }
  /** compat's element marker, when compat is loaded. */
  get $$typeof(): Any {
    return blockHooks.s;
  }
}
// isValidElement reads `constructor`, as for every Preact vnode.
Object.defineProperty(Block.prototype, "constructor", { value: VNODE_MARKER });

/** A block of template `t` with hole values `values`: what the compiler emits for host JSX. */
export function __block(t: Template, key: Any, values: Any[]): Any {
  return new Block(t, key, values, --blockId);
}

/** The props of template node `d` with hole values `v`; element children as plain vnodes. */
function propsOf(d: Desc, v: Any[]): Any {
  const props: Any = {};
  const ps = d[1];
  if (ps) for (const k in ps) props[k] = isHole(ps[k]) ? v[ps[k].h] : ps[k];
  if (d.length > 2) {
    if (typeof d[2] == "number") props.children = v[d[2]];
    else {
      const kids = d.slice(2).map((c) => (typeof c == "string" ? c : plain(c as Desc, v)));
      props.children = kids.length == 1 ? kids[0] : kids;
    }
  }
  return props;
}

/** Template node `d` as a plain vnode, as JSX's createElement would build it. */
const plain = (d: Desc, v: Any[]): Any => createVNode(d[0], propsOf(d, v), undefined, undefined, NULL);

// #endregion

// #region Rendering

/** Turn block `b` into the plain vnode its JSX would have been, in place. */
function toPlain(b: Any): void {
  const p = plain(b.__t.d, b.__a);
  b.__t = undefined;
  b.props = p.props;
}

/**
 * Turn rendered block `b` into the plain vnode tree Preact would have kept for it, over the same
 * DOM nodes: each element vnode's __e its node, text vnodes over the text nodes, and a children
 * hole's rendered children under its element.
 */
function expand(b: Any): void {
  const t: Template = b.__t,
    v = b.__a,
    shadows = b.__k;
  let s = 0;
  const tree = (d: Desc, dom: Any, depth: number): Any => {
    let kids: Any;
    if (typeof d[2] == "number") kids = shadows[s++].__k;
    else {
      kids = [];
      let n = dom.firstChild;
      for (let i = 2; i < d.length; i++, n = n.nextSibling) {
        const c = d[i] as string | Desc;
        const kid = typeof c == "string" ? createVNode(NULL, c, undefined, undefined, NULL) : tree(c, n, depth + 1);
        kid.__e = n;
        kid.__i = i - 2;
        kids.push(kid);
      }
    }
    const vn = createVNode(d[0], propsOf(d, v), undefined, undefined, NULL);
    vn.__e = dom;
    vn.__b = depth;
    vn.__k = kids;
    for (const k of kids) if (k) (k.__ = vn), (k.__b = depth + 1);
    return vn;
  };
  const root = tree(t.d, b.__e, b.__b);
  b.__t = undefined;
  b.props = root.props;
  b.__k = root.__k;
  for (const k of b.__k) if (k) k.__ = b;
}

/** A vnode standing for an element with a children hole, as the parent of its rendered children. */
function shadow(b: Any, dom: Any, tag: string, depth: number): Any {
  return {
    type: tag,
    props: EMPTY_OBJ,
    key: undefined,
    ref: undefined,
    __k: NULL,
    __: b,
    __b: depth,
    __e: dom,
    __c: NULL,
    constructor: VNODE_MARKER,
    __v: 0,
    __i: -1,
    __u: 0,
  };
}

/** Whether a children value is one text node in Preact: a string, number or bigint. */
const isText = (x: Any): boolean => x != NULL && typeof x != "object" && typeof x != "boolean" && typeof x != "function";

/** Diff block `b` against `old`; returns b's DOM node. Filled into the engine's block slot. */
function diffBlock(
  old: Any,
  b: Any,
  globalContext: Any,
  namespace: Any,
  excess: Any,
  commitQueue: Any[],
  isHydrating: Any,
  refQueue: Any[],
  parentDom: Any,
): Any {
  const t: Template = b.__t;
  // Hydration claims the server's nodes, and any other old vnode needs Preact's element diff.
  if (excess || isHydrating || (old.__e && old.__t !== t)) {
    toPlain(b);
    if (old.__t) expand(old);
    return diffElementNodes(old.__e, b, old, globalContext, namespace, excess, commitQueue, isHydrating, refQueue, parentDom);
  }
  const ns = nsOf(b.type, namespace),
    built = t.b[ns] || build(t, ns),
    v = b.__a,
    n = built.el.length,
    hv = blockHooks.v;
  let dom: Any, nodes: Any[], shadows: Any[], i: number;
  if (old.__e) {
    // The same template: write what changed.
    dom = old.__e;
    nodes = b.__h = old.__h;
    shadows = old.__k;
    b.__k = [];
    const o = old.__a,
      revalidate = old.__u & FORCE_PROPS_REVALIDATE;
    let s = 0;
    for (i = 0; i < n; i++) {
      const name = built.nm[i]!;
      let x = v[i];
      if (name !== NULL) {
        let y = o[i];
        if (hv) (x = hv(name, x)), (y = hv(name, y));
        if (x !== y || (revalidate && x != NULL)) setProperty(nodes[built.el[i]!], name, x, y, built.ns[i]);
        continue;
      }
      const sh = shadows[s++];
      const kids = sh.__k;
      // Text replaced by text: Preact's text diff, without a new text vnode.
      if (isText(x) && kids.length == 1 && kids[0] && kids[0].type === NULL && isText(o[i])) {
        sh.__ = b;
        b.__k.push(sh);
        if (kids[0].props !== x) kids[0].__e.data = kids[0].props = x;
        continue;
      }
      // A new shadow, as Preact makes a new vnode per render: until the diff ends, a lookup that
      // climbs the old tree finds the old children with their DOM.
      const next = shadow(b, sh.__e, sh.type, sh.__b);
      b.__k.push(next);
      diffChildren(
        sh.__e,
        isArray(x) ? x : [x],
        next,
        sh,
        globalContext,
        built.ns[i],
        NULL,
        commitQueue,
        getDomSibling(sh, 0),
        false,
        refQueue,
      );
      next.__e = sh.__e;
    }
    return dom;
  }
  // A new block: clone, find the holes' elements, write every hole.
  dom = built.p.cloneNode(true);
  nodes = b.__h = built.paths.map((p) => walk(dom, p));
  const r = built.replay;
  for (i = 0; i < r.length; i += 4) setProperty(nodes[r[i]], r[i + 1], r[i + 2], undefined, r[i + 3]);
  shadows = b.__k = [];
  for (i = 0; i < n; i++) {
    const name = built.nm[i]!,
      el = nodes[built.el[i]!];
    let x = v[i];
    if (name !== NULL) {
      if (hv) x = hv(name, x);
      if (x !== undefined) setProperty(el, name, x, undefined, built.ns[i]);
      continue;
    }
    const sh = shadow(b, el, built.tg[i]!, b.__b + built.dp[i]!);
    shadows.push(sh);
    diffChildren(el, isArray(x) ? x : [x], sh, EMPTY_OBJ, globalContext, built.ns[i], NULL, commitQueue, NULL, false, refQueue);
    sh.__e = el;
  }
  return dom;
}

function install(): void {
  slots.block = diffBlock;
  slots.expand = expand;
  // A block rendered in a second place: a copy with the same identity, as Preact copies a vnode.
  slots.copy = (b: Any): Any => {
  const c = new Block(b.__t, b.key, b.__a, b.__v);
  c.__p = b.__p;
  return c;
};
// An unmounted block's event listeners stop calling handlers, as Preact clears each element's.
  slots.drop = (b: Any): void => {
  const nodes = b.__h;
  if (nodes) {
    const built = b.__t.b[nsOfDom(b)]!;
    for (let i = 0; i < built.el.length; i++) {
      const name = built.nm[i];
      if (name && name[0] == "o" && name[1] == "n") nodes[built.el[i]!].l = NULL;
    }
  }
};
}

/** The namespace block `b` was built in: its root's. */
const nsOfDom = (b: Any): string => b.__e.namespaceURI;

// #endregion
