// @reactre/compat: the React 19 client API on @reactre/dom.
//
// One module stands in for `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`,
// `react/compiler-runtime`, `react-dom` and `react-dom/client`. Alias those specifiers to it at
// build time and an unchanged React app (components, hooks, libraries) renders on it. It exists
// so React code gets @reactre/dom's DOM speed without being rewritten.
//
// Key design decisions:
//
//   1. Fibers: one small object per element, rendered depth first and synchronously. An element
//      that is the same object as last time (hoisted JSX, the React Compiler's memo cache,
//      `children` passed through) and has no pending update is skipped with its whole subtree.
//   2. Placement: only host elements (and roots, portals and block slots) place DOM nodes. After
//      a render changes which nodes a host holds, the host's node list is compared with its live
//      children: the common prefix and suffix are kept, and the rest is reordered with
//      @reactre/dom's longest increasing subsequence, so a reorder costs the minimum number of DOM
//      moves. Moves use moveBefore() where the browser has it, so a moved row keeps focus,
//      selection, iframes and running animations; React's insertBefore() loses them.
//   3. Events: one listener per event type on each root (and portal container), added when a
//      prop first uses that type. A dispatch walks the fiber tree from the target, so events
//      bubble through portals as in React. Non-bubbling events (scroll, load, media events) get
//      one listener on the element; mouseenter and friends are derived from over and out events.
//   4. Effects: insertion effects run when their component completes, layout effects and refs
//      before the render returns, passive effects after paint (or before the next render,
//      whichever comes first). Updates batch automatically and flush in a microtask; updates
//      from an event handler or inside flushSync flush before the handler returns.
//   5. Blocks: @reactre/compat/compiler turns JSX trees of host elements into templates. A block
//      clones a prebuilt prototype and on update writes only the holes whose values changed. A
//      component whose whole render is one block hosts it itself, so a list row costs one fiber.
//   6. Hot paths are written for the JavaScript engine: small objects with one shape and short
//      field names, loops split into small functions the engine optimizes early, and no
//      allocation per row where it can be avoided. Comments at each such spot say which.
//
// What differs from React: rendering is synchronous (no time slicing, so a transition renders at
// once and a suspended update shows its boundary's fallback, with the old content kept hidden
// and its state intact), and hydration claims matching nodes in order and patches mismatches in
// place instead of re-rendering on the client. There is no server renderer: use React's own on
// the server.
//
// The file reads top down, in folding regions: elements, children utilities, fibers, child
// reconciliation, DOM placement, host elements, compiled blocks, hydration, roots and portals,
// components, unmounting, scheduling, effects, hooks, events, resource hints and the default
// export.

import { lis } from "@reactre/dom";

/** The React version this module implements, as libraries read it. */
export const version: string = "19.2.0";

// #region Elements and types

// #region Public types

// `Any` stands for React's untyped values (props, children, element types): one alias keeps the
// lint suppression in one place.
// biome-ignore lint: props are whatever components declare.
type Any = any;

/** Props of any element. */
export type Props = Record<string, Any>;

/** A React element: what JSX and createElement return. */
export interface ReactElement {
  readonly $$typeof: symbol;
  readonly type: Any;
  readonly key: string | null;
  readonly ref: Any;
  readonly props: Props;
}

/** A ref object. */
export interface RefObject<T> {
  current: T;
}

// #endregion

// #region Type tags and built-in components

// React's own type tags, from the global symbol registry, so elements and types made by a real
// React copy (a library bundling its own) are recognized here too.
const ELEMENT = Symbol.for("react.transitional.element");
const LEGACY_ELEMENT = Symbol.for("react.element");
const PORTAL_TYPE = Symbol.for("react.portal");
const CONTEXT_TYPE = Symbol.for("react.context");
const CONSUMER_TYPE = Symbol.for("react.consumer");
const MEMO_TYPE = Symbol.for("react.memo");
const FORWARD_TYPE = Symbol.for("react.forward_ref");
const LAZY_TYPE = Symbol.for("react.lazy");
const MEMO_SENTINEL = Symbol.for("react.memo_cache_sentinel");

/** `<>...</>`: children with no element of their own. */
export const Fragment: symbol = Symbol.for("react.fragment");
/** Renders its children; development checks are not run. */
export const StrictMode: symbol = Symbol.for("react.strict_mode");
/** Renders its children; nothing is measured. */
export const Profiler: symbol = Symbol.for("react.profiler");
/** Shows `fallback` while a child suspends. */
export const Suspense: symbol = Symbol.for("react.suspense");
/** Renders its children in order; reveal order is not coordinated. */
export const SuspenseList: symbol = Symbol.for("react.suspense_list");
/** Hides its children with `mode="hidden"`, keeping their state; their effects are cleaned up while hidden. */
export const Activity: symbol = Symbol.for("react.activity");
/** Renders its children; view transitions are not started. */
export const ViewTransition: symbol = Symbol.for("react.view_transition");

/** Names the transition for view transition types; with no view transitions started, it has no effect. */
export function addTransitionType(_type: string): void {}
export {
  Activity as unstable_Activity,
  SuspenseList as unstable_SuspenseList,
  ViewTransition as unstable_ViewTransition,
};

// #endregion

// #region Creating elements

/**
 * A plain element object. Every element is built here with the same fields in the same order,
 * so they all share one shape. As in React 19, `ref` is an ordinary prop, mirrored on the element.
 */
function element(type: Any, key: string | null, props: Props): ReactElement {
  return { $$typeof: ELEMENT, type, key, ref: props["ref"] ?? null, props };
}

/**
 * `props` with `type.defaultProps` filled in where a prop is undefined. `copy` says whether
 * `props` belongs to the caller (and must not be written); a fresh object is written in place.
 */
function withDefaults(type: Any, props: Props, copy: boolean): Props {
  const dp = type != null ? type.defaultProps : undefined;
  if (dp == null) return props;
  const out = copy ? { ...props } : props;
  for (const k in dp) if (out[k] === undefined) out[k] = dp[k];
  return out;
}

/** Internal: an inline element's key (@reactre/compat/compiler). */
export function __key(k: Any): string | null {
  return k === undefined ? null : "" + k;
}

/**
 * Internal: an inline element's props with its type's defaultProps filled
 * in (@reactre/compat/compiler builds component elements without jsx()).
 */
export function __defaults(type: Any, props: Props): Props {
  return withDefaults(type, props, false);
}

/**
 * The automatic JSX runtime's element factory (also exported as `jsxs` and `jsxDEV`). The config
 * object becomes the props as it is, unless it holds a `key` (a spread), which is taken out.
 */
export function jsx(type: Any, config: Props, maybeKey?: Any): ReactElement {
  let key = maybeKey === undefined ? null : "" + maybeKey;
  // The JSX transform passes a fresh object literal per element: it serves as the props with no
  // copy (withDefaults copies it only when it has defaults to fill in).
  let props = config;
  if ("key" in config) {
    props = {};
    for (const k in config) if (k !== "key") props[k] = config[k];
    if (config["key"] !== undefined) key = "" + config["key"];
  }
  return element(type, key, withDefaults(type, props, props === config));
}
export { jsx as jsxDEV, jsx as jsxs };

/**
 * The classic factory: `createElement(type, props, ...children)`. One child is stored as itself,
 * several as an array, as React does, so `props.children` reads the same as with JSX.
 */
export function createElement(type: Any, config?: Props | null, ...children: Any[]): ReactElement {
  const props: Props = {};
  let key: string | null = null;
  if (config != null) {
    // __self and __source are the classic JSX transform's debug props, never real ones.
    for (const k in config) {
      if (k === "key") {
        if (config[k] !== undefined) key = "" + config[k];
      } else if (k !== "__self" && k !== "__source") props[k] = config[k];
    }
  }
  if (children.length === 1) props["children"] = children[0];
  else if (children.length > 1) props["children"] = children;
  return element(type, key, withDefaults(type, props, false));
}

/**
 * A copy of `el` with `config` merged into its props (key and ref included). As in React, a prop
 * set to undefined falls back to the type's defaultProps, and `ref: undefined` keeps the old ref.
 */
export function cloneElement(el: ReactElement, config?: Props | null, ...children: Any[]): ReactElement {
  const props: Props = { ...el.props };
  let key = el.key;
  if (config != null) {
    const dp = el.type != null ? el.type.defaultProps : undefined;
    for (const k in config) {
      if (k === "key") {
        if (config[k] !== undefined) key = "" + config[k];
      } else if (k !== "__self" && k !== "__source" && !(k === "ref" && config[k] === undefined)) {
        props[k] = config[k] === undefined && dp != null ? dp[k] : config[k];
      }
    }
  }
  if (children.length === 1) props["children"] = children[0];
  else if (children.length > 1) props["children"] = children;
  return element(el.type, key, props);
}

/** Whether `o` is a React element, including one made by React 18's `react.element` tag. */
export function isValidElement(o: unknown): o is ReactElement {
  return (
    typeof o === "object" && o !== null && ((o as Any).$$typeof === ELEMENT || (o as Any).$$typeof === LEGACY_ELEMENT)
  );
}

// #endregion

// #region Refs, component wrappers, context and portals

/** A ref object holding null. */
export function createRef<T = Any>(): RefObject<T | null> {
  return { current: null };
}

/**
 * A component that re-renders only when `compare(prev, next)` (shallow equality by default) says
 * the props changed. `compare` returns true when they are equal, as in React.
 */
export function memo<T>(type: T, compare?: (a: Any, b: Any) => boolean): T {
  return { $$typeof: MEMO_TYPE, type, compare: compare ?? null } as Any;
}

/** A component that receives the ref its parent passes as a second argument. */
export function forwardRef<T>(render: (props: Any, ref: Any) => Any): T {
  return { $$typeof: FORWARD_TYPE, render } as Any;
}

/**
 * A component loaded on first render; it suspends until `load` resolves. The `_payload` and
 * `_init` fields follow React's shape, so libraries that unwrap lazy types read them as usual.
 */
export function lazy<T>(load: () => PromiseLike<{ default: T }>): T {
  // s: -1 not started, 0 loading, 1 loaded, 2 failed. v: the loader, its promise, then the
  // component or the error.
  const payload: Any = { s: -1, v: load };
  return { $$typeof: LAZY_TYPE, _payload: payload, _init: initLazy } as Any;
}

/**
 * A lazy type's component, starting its load on the first call. Until it loads this throws the
 * promise (so the nearest Suspense boundary shows its fallback); after a failure, the error.
 */
function initLazy(p: Any): Any {
  if (p.s === -1) {
    const t = p.v();
    p.s = 0;
    p.v = t;
    t.then(
      (m: Any) => {
        if (p.s === 0) ((p.s = 1), (p.v = m.default));
      },
      (e: Any) => {
        if (p.s === 0) ((p.s = 2), (p.v = e));
      },
    );
  }
  if (p.s === 1) return p.v;
  throw p.v;
}

/** A context object; `<Ctx value>` (or `<Ctx.Provider value>`) provides it. */
export interface Context<T> {
  readonly $$typeof: symbol;
  _currentValue: T;
  readonly Provider: Context<T>;
  readonly Consumer: { readonly $$typeof: symbol; readonly _context: Context<T> };
  displayName?: string;
}

/**
 * A context with a default value. As in React 19, the context is its own Provider. The default
 * lives in `_currentValue`, where libraries that read contexts directly look for it.
 */
export function createContext<T>(defaultValue: T): Context<T> {
  const ctx: Any = { $$typeof: CONTEXT_TYPE, _currentValue: defaultValue };
  ctx.Provider = ctx;
  ctx.Consumer = { $$typeof: CONSUMER_TYPE, _context: ctx };
  return ctx;
}

/** A portal: `children` rendered into `container`, with events bubbling through the React tree. */
export function createPortal(children: Any, container: Element | DocumentFragment, key?: string | null): Any {
  return { $$typeof: PORTAL_TYPE, key: key == null ? null : "" + key, children, containerInfo: container };
}

// #endregion

// #endregion

// #region Children

// Keys built the way React's Children.map builds them, so code that inspects the keys of
// mapped children (or relies on them staying stable) sees React's strings.

/** An explicit key, escaped as React escapes it: `$` first, `=` and `:` encoded. */
const escapeKey = (k: string): string => "$" + k.replace(/[=:]/g, (c) => (c === "=" ? "=0" : "=2"));
/** A key that goes into a key path: each run of slashes gets one more, so paths stay unique. */
const escapeUserKey = (k: string): string => k.replace(/\/+/g, "$&/");
/** An iterable that is not an array or an element (a Set, a generator, an Immutable list). */
const isIterable = (o: Any): boolean =>
  typeof o === "object" &&
  o !== null &&
  !Array.isArray(o) &&
  typeof o[Symbol.iterator] === "function" &&
  o.$$typeof === undefined;

/**
 * React's mapIntoArray: flattens `children`, calls `fn` on each leaf, and pushes the results to
 * `out` with keys built from `prefix` and each child's path (`name`). `count` is a one-item
 * array so nested calls share one running index.
 */
function mapInto(
  children: Any,
  out: Any[],
  prefix: string,
  name: string,
  fn: (c: Any, i: number) => Any,
  count: number[],
): void {
  const t = typeof children;
  // null, undefined and booleans count as one empty child, as in React: fn sees null.
  if (children == null || t === "boolean") children = null;
  if (
    children === null ||
    t === "string" ||
    t === "number" ||
    t === "bigint" ||
    isValidElement(children) ||
    children.$$typeof === PORTAL_TYPE
  ) {
    const child = children;
    let mapped = fn(child, count[0]!++);
    const childKey = name === "" ? "." + (child !== null && child.key != null ? escapeKey("" + child.key) : "0") : name;
    // fn returned an array: its items are flattened under this child's key path.
    if (Array.isArray(mapped)) {
      mapInto(mapped, out, prefix + escapeUserKey(childKey) + "/", "", (c) => c, [0]);
    } else if (mapped != null) {
      if (isValidElement(mapped)) {
        // A key fn gave the element (other than the child's own) leads the child's key path,
        // as React builds it.
        const mk =
          mapped.key != null && (child === null || child.key !== mapped.key)
            ? escapeUserKey("" + mapped.key) + "/"
            : "";
        mapped = element(mapped.type, prefix + mk + childKey, mapped.props);
      }
      out.push(mapped);
    }
    return;
  }
  const items = Array.isArray(children)
    ? children
    : isIterable(children)
      ? Array.from(children as Iterable<Any>)
      : null;
  if (items === null) throw new Error("Objects are not valid as a React child");
  // Nested levels are joined with ':'; unkeyed items are named by their index in base 36.
  const base = name === "" ? "." : name + ":";
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const k = c != null && typeof c === "object" && c.key != null ? escapeKey("" + c.key) : i.toString(36);
    mapInto(c, out, prefix, base + k, fn, count);
  }
}

/**
 * React's Children utilities. They flatten nested arrays and iterables and key the results the
 * way React does; `map` returns `children` itself when it is null or undefined.
 */
export const Children: {
  map<T>(children: Any, fn: (child: Any, index: number) => T, ctx?: unknown): T[];
  forEach(children: Any, fn: (child: Any, index: number) => void, ctx?: unknown): void;
  count(children: Any): number;
  toArray(children: Any): Any[];
  only(children: Any): ReactElement;
} = {
  map(children, fn, ctx) {
    if (children == null) return children;
    const out: Any[] = [];
    mapInto(children, out, "", "", (c, i) => fn.call(ctx, c, i), [0]);
    return out;
  },
  forEach(children, fn, ctx) {
    if (children != null) mapInto(children, [], "", "", (c, i) => void fn.call(ctx, c, i), [0]);
  },
  count(children) {
    const n = [0];
    if (children != null) mapInto(children, [], "", "", () => null, n);
    return n[0]!;
  },
  toArray(children) {
    const out: Any[] = [];
    if (children != null) mapInto(children, out, "", "", (c) => c, [0]);
    return out;
  },
  only(children) {
    if (!isValidElement(children))
      throw new Error("React.Children.only expected to receive a single React element child.");
    return children;
  },
};

// #endregion

// #region Fibers

// #region Fiber kinds, flags and constants

// Fiber kinds (Fiber.n). Plain integers, so one Fiber class serves every kind of node.
const ROOT = 0;
const HOST = 1;
const TEXT = 2;
const FUNC = 3;
const CLASS = 4;
const FRAG = 5;
const PROVIDER = 6;
const CONSUMER = 7;
const PORTAL = 8;
const SUSPENSE = 9;
const LAZY = 10;
const ACTIVITY = 11;
const MEMO = 12; // memo() of anything but a plain function: a wrapper around one child
const BLOCK = 13; // a compiled template instance (@reactre/compat/compiler)
const SLOT = 14; // a child hole of a block holding elements: places its nodes before its anchor

// Flags (bits of Fiber.f). Several states share one number field, so a fiber stays small and a
// check of several at once is one mask.
const DIRTY = 1; // must render even if its element is unchanged
const QUEUED = 2; // in the update queue
const DEAD = 4; // unmounted
const STRUCT = 8; // host: its DOM children changed; place them
const RERENDER = 16; // function: set state during its own render
const FORCE = 32; // class: forceUpdate
const FORWARD = 64; // function: forwardRef render (props, ref)
const SHOWN = 128; // suspense: its primary content has been shown
const HIDDEN = 256; // suspense, activity: content hidden
const CLAIMED = 512; // host: claimed from server HTML while hydrating
const HOIST = 1024; // host: <title>, <meta> or <link> placed in document.head
// Places one DOM node of its own, f.d: host, text and block fibers, and a
// function component that hosts the block it renders (see runFunc).
const BOX = 2048;

// Namespaces (Fiber.ns), as indexes into NS_URI and into a template's per-namespace arrays.
const HTML_NS = 0;
const SVG_NS = 1;
const MATH_NS = 2;
const NS_URI = ["http://www.w3.org/1999/xhtml", "http://www.w3.org/2000/svg", "http://www.w3.org/1998/Math/MathML"];

const ARRAY = Symbol("array"); // type of a fiber made from a nested array
// Shared empty values: a fiber with no props or no children points at these instead of
// allocating its own. NO_FIBERS is never written; code that adds a child replaces it first.
const NO_PROPS: Props = {};
const NO_FIBERS: Fiber[] = [];
const NO_CONTEXT = {};

// DOM node expandos. Symbols, so they never collide with a property a page or library sets.
const FIBER = Symbol("fiber"); // element -> its host fiber
const OWN = Symbol("own"); // node -> the host fiber that places it
const LISTENS = Symbol("listens"); // element -> direct listener types
const TRACKED = Symbol("tracked"); // input or textarea -> the value (or checked state) last set or seen

/** A child's key: an explicit key (a string) or, without one, its position (a number). */
type Key = string | number;

// #endregion

// #region The Fiber class

/**
 * One node of the rendered tree: a host element, a text, a component, a provider, a boundary,
 * a block, and so on, told apart by its kind `n`. Every kind uses this one class.
 *
 * The fields have one- and two-letter names and are all set in the constructor or as class
 * fields, in one order. That keeps every fiber the same shape, so the engine sees one hidden
 * class at every access, and keeps the object small: a list of thousands of rows makes one
 * fiber per row. Several fields hold different things for different kinds; each field's doc
 * lists them.
 */
class Fiber {
  /** Kind: ROOT, HOST, TEXT, FUNC, CLASS, FRAG and the rest. */
  n: number;
  /**
   * Type: a host's tag, a component's function or class, a provider's context, a consumer,
   * lazy or memo type, a block's template, ARRAY for a nested array, Fragment for an internal
   * fragment; null for text, roots, portals and slots.
   */
  t: Any;
  /** Key among its siblings: the element's key, else its position. */
  k: Key;
  /**
   * Props; for text the string; for arrays the array; for portals the portal; for a block its
   * hole values; for a root the children it renders.
   */
  p: Any = NO_PROPS;
  /**
   * The element last rendered, for the identity bailout. For a slot, the list it last rendered
   * while its rows match that list one to one, else null.
   */
  e: Any = null;
  /** Parent ("return") fiber; null for a root. */
  r: Fiber | null;
  /** Child fibers in order; the shared NO_FIBERS while there are none. */
  c: Fiber[] = NO_FIBERS;
  /** Index in the parent's children. */
  i = 0;
  /** DOM node, or container for roots and portals, or the parent element of a slot's anchor. */
  d: Any = null;
  /** Flags: DIRTY, QUEUED, DEAD, BOX and the rest, as bits. */
  f = 0;
  /** The root this fiber renders in. */
  o: RootImpl;
  /** A function component's hooks, in call order; null until its first hook call. */
  h: Hook[] | null = null;
  /**
   * Class instance; function component's render function; provider subscribers; form status;
   * suspense primary; activity's inner fragment; a slot's anchor text node.
   */
  s: Any = null;
  /** Memo compare; class update queue; suspense fallback; form status subscribers. */
  q: Any = null;
  /** Pending effects of a function's render; a value thrown to this boundary. */
  x: Any = null;
  /** Callback ref cleanup. */
  rx: Any = null;
  /** Host: its text content when it holds only text, else null. */
  tx: string | null = null;
  /** Namespace (HTML_NS, SVG_NS or MATH_NS) of a host, block, root, portal or slot. */
  ns = HTML_NS;
  /**
   * Hydration cursor holder: while hydrating, the next server-rendered child node this host
   * (or root) has yet to claim; null when there is nothing to claim.
   */
  hc: Any = null;
  /** Block, or a function component hosting one: the block element last rendered. */
  b: BlockElement | null = null;
  /** Its hole nodes once looked up (by index), then its slot fibers (at holes + index). */
  bs: Any[] | null = null;
  /** Memoized component: how many keys its props have, once a compare counted them (-1 until). */
  pk = -1;
  constructor(n: number, t: Any, k: Key, r: Fiber | null, o: RootImpl) {
    this.n = n;
    // Host, text and block fibers always place one node of their own.
    if (n === HOST || n === TEXT || n === BLOCK) this.f = BOX;
    this.t = t;
    this.k = k;
    this.r = r;
    this.o = o;
  }
}

// #endregion

// #region Render state and type lookup

// What render is doing now. Module variables, not arguments: rendering is synchronous and
// single-threaded, and every function that changes one saves and restores it (in a finally) so
// a throw leaves them as they were.
let cur: Fiber | null = null; // the function or class component rendering
let hi = 0; // its next hook index
let curHost: Fiber = null as Any; // the host that places nodes created now
let curNs = HTML_NS; // the namespace new host elements are created in
let hydrating = false; // claiming server-rendered nodes instead of creating them

/** Whether `v` is a promise or any object with a `then` method, as React tests for one. */
const isThenable = (v: Any): boolean => v !== null && typeof v === "object" && typeof v.then === "function";

/** The fiber kind for an element type; throws React's error for a type that is not one. */
function kindOf(type: Any): number {
  if (typeof type === "string") return HOST;
  if (typeof type === "function") return type.prototype && type.prototype.isReactComponent ? CLASS : FUNC;
  if (type === Fragment || type === StrictMode || type === Profiler || type === SuspenseList || type === ViewTransition)
    return FRAG;
  if (type === Suspense) return SUSPENSE;
  if (type === Activity) return ACTIVITY;
  if (type != null) {
    switch (type.$$typeof) {
      case TEMPLATE_TYPE:
        return BLOCK;
      case CONTEXT_TYPE:
        return PROVIDER;
      case CONSUMER_TYPE:
        return CONSUMER;
      case FORWARD_TYPE:
        return FUNC;
      case LAZY_TYPE:
        return LAZY;
      case MEMO_TYPE: {
        // memo() of a function component (or forwardRef) is that function with a compare:
        // one FUNC fiber. memo() of anything else needs a wrapper fiber (MEMO).
        const inner = type.type;
        return (typeof inner === "function" && !(inner.prototype && inner.prototype.isReactComponent)) ||
          (inner != null && inner.$$typeof === FORWARD_TYPE)
          ? FUNC
          : MEMO;
      }
    }
  }
  throw new Error(
    `Element type is invalid: expected a string or a class/function but got: ${type === null ? "null" : typeof type}.`,
  );
}

// The type create() last saw, and what it is: its fiber kind and, for a function, its memo
// compare, forwardRef flag and render function. A one-entry cache: a list's rows share a type,
// so a list mount works the type out once, not once per row.
let lastType: Any = undefined,
  lastKind = 0,
  lastQ: Any = null,
  lastForward = false,
  lastRender: Any = null;

/**
 * For create()'s cache: a function type's memo compare, forwardRef flag and render function,
 * unwrapping memo() then forwardRef(), so rendering calls the plain function directly.
 */
function setupFunc(type: Any): void {
  let t = type;
  lastQ = null;
  lastForward = false;
  if (t.$$typeof === MEMO_TYPE) {
    lastQ = t.compare ?? shallowEqual;
    t = t.type;
  }
  if (t.$$typeof === FORWARD_TYPE) {
    lastForward = true;
    t = t.render;
  }
  lastRender = t;
}

/**
 * Shallow equality of two objects by own keys and Object.is, as React compares props. Not part
 * of React's public API; exported for libraries and for @reactre/compat/classes (PureComponent).
 */
export function shallowEqual(a: Any, b: Any): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  // Counted with for-in, not Object.keys: memo compares every row on every
  // render, and this allocates nothing.
  let n = 0;
  for (const k in a) {
    if (!Object.is(a[k], b[k]) || (b[k] === undefined && !Object.hasOwn(b, k))) return false;
    n++;
  }
  for (const _ in b) n--;
  return n === 0;
}

// #endregion

// #endregion

// #region Reconciling children

// reconcile() turns a fiber's new children (an element, text, an array, an iterable, a promise)
// into child fibers, reusing old fibers by key and type as React does. It tries the cheap
// shapes first (one element, rows that line up, appends, removals, a swap) and only builds a key
// map for what is left. Moving DOM nodes is left to place(), run once per host after its
// children render; the fast paths that move or insert nodes themselves skip that pass.

// #region Keys and types

/**
 * A child's key. An explicit key is a string and an implicit one (the position) a number, so
 * the two never collide and no key string is built per render.
 */
function keyOf(it: Any, i: number): Key {
  return typeof it === "object" && it.key != null ? it.key : i;
}

/** Whether old fiber `o` can be reused for child `it`: React's same-type rule. */
function sameType(o: Fiber, it: Any): boolean {
  switch (typeof it) {
    case "string":
    case "number":
    case "bigint":
      return o.n === TEXT;
  }
  // Elements first: a list re-render checks every row.
  if (it.$$typeof === ELEMENT) {
    if (o.t === it.type) return o.n !== TEXT;
    // A block element's fiber is typed by its template, not by its tag.
    const tpl = it[TPL];
    return tpl !== undefined && o.t === tpl;
  }
  if (Array.isArray(it) || isIterable(it)) return o.t === ARRAY;
  if (it.$$typeof === PORTAL_TYPE) return o.n === PORTAL && o.d === it.containerInfo;
  if (o.t === it.type) return o.n !== TEXT;
  const tpl = it[TPL];
  // A hydrated block is a host fiber of the same tag.
  return tpl !== undefined && o.t === tpl;
}

/**
 * A child with promises unwrapped: React 19 renders a resolved promise's value, and a pending
 * one suspends (readThenable throws it). Lazy elements' types are resolved when they render.
 */
function unwrap(it: Any): Any {
  while (isThenable(it)) it = readThenable(it);
  return it;
}

// #endregion

// #region Row patching

// Patch the leading items whose keys and types match the old children, in
// place, and return the index in items where that stopped (alignedOld is
// where in old). Small on purpose: it is the loop a list re-render spends
// its time in, and the one the engine optimizes.
// alignedOld is a second return value in a module variable: returning a pair would allocate.
let alignedOld = 0;
function patchAligned(items: Any[], old: Fiber[], n: number): number {
  let i = 0,
    oi = 0;
  for (; i < n; i++) {
    let it = items[i];
    const o = old[oi];
    // The element the row already has (a memoized list's unchanged rows):
    // nothing to check or render, unless the row has an update of its own.
    // (Not a hole: a text fiber's element is null too.)
    if (it != null && o !== undefined && o.e === it && !(o.f & DIRTY)) {
      oi++;
      continue;
    }
    // Holes (null, undefined, booleans) take no fiber: skipped without using up an old child.
    if (it == null || typeof it === "boolean") continue;
    // A promise is unwrapped once and written back, so later passes see its value.
    if (typeof it === "object" && it.$$typeof !== ELEMENT && isThenable(it)) it = items[i] = unwrap(it);
    if (o === undefined) break;
    // An element of the fiber's own type (a list's rows): checked inline.
    if (typeof it === "object" && it.$$typeof === ELEMENT && o.t === it.type) {
      if (o.k !== (it.key != null ? it.key : i)) break;
    } else if (o.k !== keyOf(it, i) || !sameType(o, it)) break;
    oi++;
    patchRow(o, it);
  }
  alignedOld = oi;
  return i;
}

// Patch a list row: React's bailout for a memoized function component given
// the element it rendered or one with shallowly equal props, else its render,
// with one props compare and none of patch()'s calls in between. A list
// re-render does this for each row; anything else goes to patch().
function patchRow(o: Fiber, it: Any): void {
  if (o.e === it && !(o.f & DIRTY)) return;
  if (o.q === shallowEqual && o.n === FUNC && !(o.f & DIRTY) && o.e !== null) {
    const n = sameProps(o.p, it.props, o.pk);
    if (n >= 0) {
      // React keeps the old props object on a bailout: its key count stays known.
      o.pk = n;
      o.e = it;
      return;
    }
    // The props differ: render, without update() comparing them again.
    const old = o.p;
    o.e = it;
    o.p = it.props;
    o.pk = -1;
    run(o, old, false);
    return;
  }
  patch(o, it);
}

// shallowEqual(a, b) for a memoized row, walking only b when a's key count
// na is known (else -1): b's key count if equal, else -1.
// Returning the count lets the caller cache it in Fiber.pk, so the next compare of the same
// props object skips walking a.
function sameProps(a: Any, b: Any, na: number): number {
  let nb = 0;
  for (const k in b) {
    const x = b[k],
      y = a[k];
    // Object.is, inline: NaN equals NaN, 0 and -0 differ.
    if (x !== y ? x === x || y === y : x === 0 && 1 / x !== 1 / y) return -1;
    if (x === undefined && !Object.hasOwn(a, k)) return -1;
    nb++;
  }
  if (na < 0) {
    na = 0;
    for (const _ in a) na++;
  }
  return na === nb ? nb : -1;
}

// #endregion

// #region reconcile

/**
 * Render `children` as the children of fiber `p`: patch, create, move and unmount child fibers
 * so `p.c` matches them. Sets STRUCT on the current host when its DOM children need placing.
 * On a throw, every live fiber stays in `p.c` and `p` is marked DIRTY, so the boundary that
 * catches it can retry or unmount the whole subtree.
 */
function reconcile(p: Fiber, children: Any): void {
  const old = p.c;
  if (children == null || typeof children === "boolean") {
    if (old.length) removeAll(p);
    return;
  }
  // One element (what most components render): no arrays, no loop.
  if (typeof children === "object" && children.$$typeof === ELEMENT && old.length <= 1) {
    const key: Key = children.key != null ? children.key : 0;
    const o = old[0];
    try {
      if (o === undefined) {
        const f = create(children, p, key);
        p.c = [f];
        curHost.f |= STRUCT;
        return;
      }
      if (o.k === key && sameType(o, children)) {
        patch(o, children);
        return;
      }
    } catch (e) {
      // As in the general path's catch below: p re-renders on retry and its host re-places.
      p.f |= DIRTY;
      curHost.f |= STRUCT;
      throw e;
    }
  }
  // Anything else (an array, an iterable, text, one element where there were several) is
  // handled as a list.
  const items: Any[] = Array.isArray(children)
    ? children
    : isIterable(children)
      ? Array.from(children as Iterable<Any>)
      : [children];
  const n = items.length,
    m = old.length;
  if (n === 0) {
    // An empty list: no lookups, one clear where the list is all there is.
    if (m) removeAll(p);
    return;
  }
  let nc: Fiber[] = NO_FIBERS,
    oi = 0,
    i = 0,
    moved = false;
  try {
    // Keys and types line up (the common case): update in place. When they
    // do all the way, the children array stays as it is.
    i = patchAligned(items, old, n);
    oi = alignedOld;
    if (i === n && oi === m) return;
    nc = old.slice(0, oi);
    // The fast paths below that touch the DOM themselves need p to be the host whose children
    // are these nodes (p === curHost); a fragment's or component's children share their host
    // with siblings, so they take the general path and place().
    if (oi === m && p === curHost && !hydrating) {
      // Only additions at the end (appending, or filling an empty list):
      // insert the new nodes before the end, with no placement pass.
      createRun(items, i, n - 1, p, nc);
      p.c = nc;
      append(p, nc, m);
      return;
    }
    // The common suffix, found here and updated after the middle, so
    // siblings still render in order.
    const ne = matchSuffix(items, old, i, oi, n, m),
      oe = suffixOld;
    const tail = oe + 1;
    if (i > ne && oi <= oe && p === curHost && n - i === m - tail) {
      // Only removals (a row deleted): their nodes go, the children array
      // drops them in place, and the rows after them are patched where they
      // now sit; nothing else is visited or copied. Indexes after the cut
      // stay increasing, which is all reordering asks of them.
      for (let j = oi; j <= oe; j++) unmount(old[j]!, true);
      old.splice(oi, tail - oi);
      for (let j = i, o = oi; j < n; j++, o++) patchRow(old[o]!, items[j]);
      return;
    }
    if (ne > i && ne - i === oe - oi && p === curHost && swapped(items, old, i, ne, oi, oe)) {
      if (swapSame && n === m && i === oi) {
        // Only the two ends changed (a memoized list's swap): the children
        // array is kept and its two entries trade places; nothing between
        // them is visited again.
        const x = old[oi]!,
          y = old[oe]!;
        old[oi] = y;
        old[oe] = x;
        y.i = oi;
        x.i = oe;
        patchRow(y, items[i]);
        patchRow(x, items[ne]);
        for (let j = ne + 1, o = tail; j < n; j++, o++) patchRow(old[o]!, items[j]);
        return;
      }
      // The middle's two ends traded places and the rest stayed: two moves,
      // made here, with no map and no placement pass.
      take(old[oe]!, items[i], nc);
      patchRun(items, i + 1, ne - 1, old, oi + 1, nc);
      take(old[oi]!, items[ne], nc);
    } else if (i <= ne || oi <= oe) {
      // The general case: old children of the middle by key, reused where the key and type
      // match; what is left in the map afterwards is unmounted.
      const map = oi <= oe ? keyMap(old, oi, oe) : null;
      moved = middle(p, items, i, ne, map, nc);
      if (map !== null && map.size) {
        if (map.size === m) {
          // Nothing old survived (a full replacement): one native clear
          // beats a removal per node. New nodes are placed after this.
          removeAll(p, old);
          if (nc.length === 0) return;
        } else for (const o of map.values()) unmount(o, true);
      }
    }
    patchRun(items, ne + 1, n - 1, old, tail, nc);
  } catch (e) {
    // Keep every live fiber tracked, so the boundary that catches this can
    // retry (suspense) or unmount (errors) the whole subtree.
    p.f |= DIRTY;
    const kept = new Set(nc);
    p.c = nc.concat(old.filter((o) => !kept.has(o) && !(o.f & DEAD)));
    for (let j = 0; j < p.c.length; j++) p.c[j]!.i = j;
    curHost.f |= STRUCT;
    throw e;
  }
  p.c = nc;
  if (moved) curHost.f |= STRUCT;
}

// #endregion

// #region reconcile's loops

// The loops of reconcile, each in a function of its own: they run over every
// row of a list, and small functions are the ones the engine optimizes
// within a few runs. Inlined in reconcile they would stay unoptimized.

// The last index in items (and in old, as suffixOld) before the common
// suffix: the items and old children that match from the end.
// suffixOld is a second return value, kept in a module variable so no pair is allocated.
let suffixOld = 0;
function matchSuffix(items: Any[], old: Fiber[], i: number, oi: number, n: number, m: number): number {
  let ne = n - 1,
    oe = m - 1;
  while (ne >= i && oe >= oi) {
    let it = items[ne];
    // Its own element again (a memoized row): the same key and type.
    if (it != null && old[oe]!.e === it) {
      ne--;
      oe--;
      continue;
    }
    if (it == null || typeof it === "boolean") {
      ne--;
      continue;
    }
    if (typeof it === "object" && it.$$typeof !== ELEMENT && isThenable(it)) it = items[ne] = unwrap(it);
    const o = old[oe]!;
    if (o.k !== keyOf(it, ne) || !sameType(o, it)) break;
    ne--;
    oe--;
  }
  suffixOld = oe;
  return ne;
}

/** Keep old fiber `o` as the next new child: record its new index, append it, patch it. */
function take(o: Fiber, it: Any, nc: Fiber[]): void {
  o.i = nc.length;
  nc.push(o);
  patchRow(o, it);
}

// Update old[ofrom...] with items[from..to] in order (holes skipped).
function patchRun(items: Any[], from: number, to: number, old: Fiber[], ofrom: number, nc: Fiber[]): void {
  for (let j = from, os = ofrom; j <= to; j++) {
    const it = items[j];
    if (it == null || typeof it === "boolean") continue;
    take(old[os++]!, it, nc);
  }
}

// Create fibers for items[from..to].
function createRun(items: Any[], from: number, to: number, p: Fiber, nc: Fiber[]): void {
  for (let i = from; i <= to; i++) {
    let it = items[i];
    if (it == null || typeof it === "boolean") continue;
    if (typeof it === "object" && it.$$typeof !== ELEMENT && isThenable(it)) it = items[i] = unwrap(it);
    const o = create(it, p, keyOf(it, i));
    o.i = nc.length;
    nc.push(o);
  }
}

/** old[from..to] by key, for the unordered middle of a list. */
function keyMap(old: Fiber[], from: number, to: number): Map<Key, Fiber> {
  const map = new Map<Key, Fiber>();
  for (let j = from; j <= to; j++) map.set(old[j]!.k, old[j]!);
  return map;
}

// The differing middle, items[i..ne]: reuse old children by key (taking
// them out of map) or create them. Whether anything moved or was created.
function middle(p: Fiber, items: Any[], i: number, ne: number, map: Map<Key, Fiber> | null, nc: Fiber[]): boolean {
  let last = -1,
    moved = false;
  for (; i <= ne; i++) {
    let it = items[i];
    if (it == null || typeof it === "boolean") continue;
    if (typeof it === "object" && it.$$typeof !== ELEMENT && isThenable(it)) it = items[i] = unwrap(it);
    const key = keyOf(it, i);
    let o = map === null ? undefined : map.get(key);
    if (o !== undefined && sameType(o, it)) {
      map!.delete(key);
      // Old indexes still increasing means the reused fibers kept their order: no move yet.
      if (o.i < last) moved = true;
      else last = o.i;
      take(o, it, nc);
    } else {
      o = create(it, p, key);
      o.i = nc.length;
      nc.push(o);
      moved = true;
    }
  }
  return moved;
}

// Insert the nodes of host p's children from index `from` on at the end of
// its children (before a slot's anchor), detaching p for a big fill of an
// empty host.
function append(p: Fiber, kids: Fiber[], from: number): void {
  const nodes: Node[] = [];
  for (let k = from; k < kids.length; k++) collect(kids[k]!, nodes);
  if (nodes.length === 0) return;
  const parent = p.d as Node,
    end = p.n === SLOT && p.s.parentNode !== null ? p.s : null;
  // Only a fill of an empty host (from === 0: every child is new) detaches it; detach() itself
  // refuses when that could lose state.
  const out = from === 0 && nodes.length >= DETACH_MIN ? detach(p) : null;
  if (out === null && nodes.length >= DETACH_MIN && parent.isConnected) {
    // Many nodes into a live parent (an append to a long list): gathered in
    // a fragment first, the document takes them in one insertion.
    const frag = parent.ownerDocument!.createDocumentFragment();
    for (let ix = 0; ix < nodes.length; ix++) frag.appendChild(nodes[ix]!);
    parent.insertBefore(frag, end);
    return;
  }
  for (let ix = 0, xs = nodes; ix < xs.length; ix++) {
    const x = xs[ix]!;
    parent.insertBefore(x, end);
  }
  if (out !== null) out[0].insertBefore(parent, out[1]);
}

// Whether items[i..ne] are old[oi..oe] with the two ends swapped, each end a
// single node; if so, swap the nodes. swapSame: every row between them was
// given its own element again (a second return value, kept in a module variable).
// Swapping two rows (drag to reorder) is a common list update; this makes it two DOM moves with
// no key map.
let swapSame = false;
function swapped(items: Any[], old: Fiber[], i: number, ne: number, oi: number, oe: number): boolean {
  const a = items[i],
    b = items[ne];
  if (a == null || b == null || typeof a === "boolean" || typeof b === "boolean") return false;
  const x = old[oi]!,
    y = old[oe]!;
  if (x.k !== keyOf(b, ne) || y.k !== keyOf(a, i) || !sameType(x, b) || !sameType(y, a)) return false;
  let same = true;
  for (let j = 1; j < ne - i; j++) {
    const it = items[i + j],
      o = old[oi + j]!;
    // Its own element again (a memoized row): the same key, nothing to render.
    if (it != null && o.e === it && !(o.f & DIRTY)) continue;
    same = false;
    if (it == null || typeof it === "boolean" || o.k !== keyOf(it, i + j)) return false;
  }
  swapSame = same;
  const nx = single(x),
    ny = single(y);
  if (nx === null || ny === null) return false;
  // y's node goes before x's; then x's node goes where y's was, unless they were adjacent (the
  // first move already put x after y).
  const parent = curHost.d as Node,
    after = ny.nextSibling;
  move(parent, ny, nx);
  if (ne - i > 1) move(parent, nx, after);
  return true;
}

// The one DOM node a fiber places, or null when it places none or several.
function single(f: Fiber): Node | null {
  for (;;) {
    // A hoisted node lives in <head> and a hidden one is mid-suspense: neither moves here.
    if (f.f & BOX) return f.f & (HOIST | HIDDEN) ? null : f.d;
    if (f.n === PORTAL || f.c.length !== 1) return null;
    f = f.c[0]!;
  }
}

// Remove every child of p. A host whose only content they are is cleared at once.
function removeAll(p: Fiber, old: Fiber[] = p.c): void {
  p.c = NO_FIBERS;
  if (p === curHost) {
    // A slot's nodes share their parent with its anchor, which goes back.
    let count = 0;
    for (let ix = 0, xs = old; ix < xs.length; ix++) {
      const o = xs[ix]!;
      // A node of its own (a row) counts inline; anything else is walked.
      count += o.f & BOX ? (o.f & HOIST ? 0 : 1) : tally(o);
    }
    const anchored = p.n === SLOT && p.s.parentNode !== null;
    // Only when the host holds nothing else (no nodes of another root, a portal or a library)
    // may textContent wipe it.
    if (count + (anchored ? 1 : 0) === p.d.childNodes.length) {
      for (let ix = 0, xs = old; ix < xs.length; ix++) {
        const o = xs[ix]!;
        // A row with nothing to clean up (a component hosting its block, no
        // hooks, no slots) is only marked: no call per row.
        if (o.n === FUNC && o.h === null && o.c === NO_FIBERS && o.f & BOX) o.f |= DEAD;
        else unmount(o, false);
      }
      p.d.textContent = "";
      if (anchored) p.d.appendChild(p.s);
      return;
    }
  }
  for (let ix = 0, xs = old; ix < xs.length; ix++) {
    const o = xs[ix]!;
    unmount(o, true);
  }
}

// #endregion

// #region Patching, creating and running fibers

/** Update old fiber `o` (already matched by key and type) with child `it`. */
function patch(o: Fiber, it: Any): void {
  switch (o.n) {
    case TEXT: {
      const s = "" + it;
      if (o.p !== s) {
        o.p = s;
        // A hidden text node is emptied (see setHidden); it gets o.p back when shown.
        if (!(o.f & HIDDEN)) o.d.data = s;
      }
      return;
    }
    case FRAG:
      if (o.t === ARRAY) {
        reconcile(o, (o.p = it));
        return;
      }
      break;
    case PORTAL:
      o.p = it;
      runPortal(o, false);
      return;
  }
  update(o, it, false);
}

/**
 * A new fiber for child `it` under `p`, mounted: its DOM nodes are created (or claimed while
 * hydrating) but not inserted; the caller's host places them. Hoisted <head> metadata is the
 * exception: it goes straight into document.head.
 */
function create(it: Any, p: Fiber, key: Key): Fiber {
  let f: Fiber;
  // Text: strings, numbers and bigints (holes were skipped by the caller).
  if (typeof it !== "object") {
    f = new Fiber(TEXT, null, key, p, p.o);
    f.p = "" + it;
    f.d = (hydrating && claimText(f.p)) || document.createTextNode(f.p);
    f.d[OWN] = curHost;
    return f;
  }
  // Elements first: a list mount creates one per row.
  const tt = it.$$typeof;
  if (tt === ELEMENT || tt === LEGACY_ELEMENT) {
    // A block mounts as a template, except while hydrating: then it is the
    // host element it describes, so it claims the server's nodes.
    const tpl = it[TPL];
    if (tpl !== undefined && !hydrating) f = new Fiber(BLOCK, tpl, key, p, p.o);
    else {
      // A list's rows share a type: what it is to render is worked out once.
      const type = it.type;
      if (type !== lastType) {
        const k = kindOf(type);
        lastType = type;
        lastKind = k;
        if (k === FUNC) setupFunc(type);
      }
      f = new Fiber(lastKind, type, key, p, p.o);
      if (lastKind === FUNC) {
        f.q = lastQ;
        f.s = lastRender;
        if (lastForward) f.f |= FORWARD;
      }
    }
  } else if (Array.isArray(it) || isIterable(it)) {
    f = new Fiber(FRAG, ARRAY, key, p, p.o);
    f.p = it;
  } else if (tt === PORTAL_TYPE) {
    f = new Fiber(PORTAL, null, key, p, p.o);
    f.p = it;
    f.d = it.containerInfo;
  } else {
    throw new Error(
      `Objects are not valid as a React child (found: object with keys {${Object.keys(it).join(", ")}}). If you meant to render a collection of children, use an array instead.`,
    );
  }
  try {
    if (f.n === FRAG && f.t === ARRAY) reconcile(f, Array.isArray(it) ? it : (f.p = Array.from(it as Iterable<Any>)));
    else if (f.n === PORTAL) runPortal(f, true);
    else update(f, it, true);
  } catch (e) {
    // A child that fails to mount is dropped: nothing of it is committed.
    unmount(f, true);
    throw e;
  }
  return f;
}

// Render an element into fiber f: mount it, or update it unless nothing changed.
function update(f: Fiber, el: ReactElement, mount: boolean): void {
  let old: Props | null = null;
  if (!mount) {
    // The identity bailout: the same element object and no update of its own.
    if (el === f.e && !(f.f & DIRTY)) return;
    old = f.p;
    if (f.q !== null && (f.n === FUNC || f.n === MEMO) && !(f.f & DIRTY) && f.e !== null) {
      // A custom compare does not see ref changes; shallowEqual compares it with the rest.
      const q = f.q;
      if (q(old, el.props) && (q === shallowEqual || old!["ref"] === el.props["ref"])) {
        f.e = el;
        return;
      }
    }
  }
  f.e = el;
  if (f.n === BLOCK) {
    f.b = el as Any;
    f.p = (el as Any)[VALS];
  } else {
    f.p = el.props;
    f.pk = -1;
  }
  run(f, old, mount);
}

/**
 * Render fiber `f` by kind, with `f.p` already set to its new props and `old` its previous ones
 * (null on mount). Clears DIRTY first, so an update scheduled during the render marks it again.
 */
function run(f: Fiber, old: Props | null, mount: boolean): void {
  f.f &= ~DIRTY;
  switch (f.n) {
    case HOST:
      return runHost(f, old, mount);
    case FUNC:
      return runFunc(f, mount);
    case CLASS:
      if (classes === null) throw noClasses(f.t);
      return classes.run(f, old, mount);
    case FRAG:
      return reconcile(f, f.t === ARRAY ? f.p : f.p.children);
    case PROVIDER: {
      // A new value re-renders every reader (subscribed by readContext), even below a memo
      // bailout, as React propagates context. Dead readers are dropped on the way.
      if (old !== null && !Object.is(old["value"], f.p.value) && f.s !== null) {
        for (const s of f.s as Set<Fiber>) {
          if (s.f & DEAD) f.s.delete(s);
          else schedule(s);
        }
      }
      return reconcile(f, f.p.children);
    }
    case CONSUMER: {
      const render = f.p.children;
      return reconcile(f, typeof render === "function" ? render(readContext(f, f.t._context)) : null);
    }
    case PORTAL:
      return runPortal(f, mount);
    case SUSPENSE:
      return runSuspense(f);
    case ACTIVITY:
      return runActivity(f);
    case LAZY: {
      // Throws the load's promise until it resolves; the nearest Suspense catches it.
      const type = f.t._init(f.t._payload);
      return reconcile(f, element(type, null, f.p));
    }
    case MEMO:
      if (f.q === null) f.q = f.t.compare ?? shallowEqual;
      return reconcile(f, element(f.t.type, null, f.p));
    case ROOT:
      return runRoot(f);
    case BLOCK:
      return runBlock(f, f.p, old as Any, mount);
  }
}

// #endregion

// #endregion

// #region Placing DOM nodes

// Only host-level fibers (BOX) own DOM nodes. Everything between them (components, fragments,
// providers, boundaries) is transparent: its nodes are its children's, placed by the nearest
// host above. These walks find those nodes.

// The top-level DOM nodes of f's children, in order (portals place their own).
function collect(f: Fiber, out: Node[]): void {
  if (f.f & BOX) {
    if (!(f.f & HOIST)) out.push(f.d);
  } else if (f.n !== PORTAL)
    for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
      const c = xs[ix]!;
      collect(c, out);
    }
}

// How many nodes collect() would list for f, without the list.
function tally(f: Fiber): number {
  if (f.f & BOX) return f.f & HOIST ? 0 : 1;
  if (f.n === PORTAL) return 0;
  let n = 0;
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    n += tally(c);
  }
  return n;
}

// The host-level fibers (elements and text) at the top of f's subtree.
function tops(f: Fiber, out: Fiber[]): void {
  if (f.f & BOX) {
    if (!(f.f & HOIST)) out.push(f);
  } else if (f.n !== PORTAL)
    for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
      const c = xs[ix]!;
      tops(c, out);
    }
}

/** The first node from `x` on (inclusive) that host `h` places; foreign nodes are skipped. */
function next(x: Any, h: Fiber): Any {
  while (x !== null && x[OWN] !== h) x = x.nextSibling;
  return x;
}
/** The last node from `x` back (inclusive) that host `h` places. */
function prev(x: Any, h: Fiber): Any {
  while (x !== null && x[OWN] !== h) x = x.previousSibling;
  return x;
}

// A fill of this many nodes into a host that holds none of its own detaches
// the host first (as vanillajs does), so style and layout run once, not as
// the document changes under them.
const DETACH_MIN = 64;

// Take host h's element out of the document for a fill and return where it
// goes back, or null when that could lose state: the root's or a portal's
// container (not ours), focus inside it, or iframes and media in it, which a
// detach resets.
function detach(h: Fiber): [Node, Node | null] | null {
  if (h.n !== HOST && h.n !== SLOT) return null;
  const el = h.d as Element,
    up = el.parentNode;
  if (up === null || !el.isConnected) return null;
  const active = el.ownerDocument.activeElement;
  if (active !== null && el.contains(active)) return null;
  if (el.firstElementChild !== null && el.querySelector("iframe,video,audio,object,embed") !== null) return null;
  const at = el.nextSibling;
  up.removeChild(el);
  return [up, at];
}

/** A node that may have the newer moveBefore() method. */
type Movable = Node & { moveBefore?: (node: Node, child: Node | null) => void };

// Move a node already in parent: keep its state where the browser can.
function move(parent: Node, node: Node, ref: Node | null): void {
  const m = parent as Movable;
  // moveBefore() keeps focus, selection, iframes and animations. It is for connected trees,
  // where that state exists; a parent outside the document (detached for a fill) uses
  // insertBefore().
  if (m.moveBefore !== undefined && parent.isConnected) m.moveBefore(node, ref);
  else parent.insertBefore(node, ref);
}

// Make host h's DOM children match its fibers' top-level nodes with the
// fewest moves: keep the common prefix and suffix, keep the longest run of
// the rest that is already in order, and move or insert everything else.
// Nodes h does not own (another root's, a portal's, a library's) are left alone.
function place(h: Fiber): void {
  h.f &= ~STRUCT;
  const parent = h.d as Node;
  const want: Node[] = [];
  for (let ix = 0, xs = h.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    collect(c, want);
  }
  const n = want.length;
  // The common prefix: nodes already where they should be.
  let node = next(parent.firstChild, h),
    i = 0;
  while (i < n && node === want[i]) {
    i++;
    node = next(node.nextSibling, h);
  }
  if (i === n) {
    // Everything wanted is in place: any of h's nodes after it are stale.
    while (node !== null) {
      const nx = next(node.nextSibling, h);
      parent.removeChild(node);
      node = nx;
    }
    return;
  }
  // The common suffix, from the end.
  let tail = prev(parent.lastChild, h),
    j = n - 1;
  while (j >= i && tail === want[j]) {
    j--;
    tail = prev(tail.previousSibling, h);
  }
  // Wanted nodes i..j go before `end`: the first suffix node, else a slot's anchor, else the end.
  const end = j + 1 < n ? want[j + 1]! : h.n === SLOT && h.s.parentNode !== null ? h.s : null;
  // h's nodes now between the prefix and the suffix.
  const old: Node[] = [];
  for (let x = node; x !== null && x !== end; x = next(x.nextSibling, h)) old.push(x);
  const len = j - i + 1;
  if (old.length === 0) {
    // Nothing to reorder, only insertions.
    const out = i === 0 && j === n - 1 && n >= DETACH_MIN ? detach(h) : null;
    for (let k = i; k <= j; k++) parent.insertBefore(want[k]!, end);
    if (out !== null) out[0].insertBefore(parent, out[1]);
    return;
  }
  // src[k]: where wanted node i + k sits among the old ones, or -1 for a new node. Nodes left in
  // pos afterwards are wanted no more.
  const pos = new Map<Node, number>();
  for (let k = 0; k < old.length; k++) pos.set(old[k]!, k);
  const src = new Int32Array(len);
  for (let k = 0; k < len; k++) {
    const at = pos.get(want[i + k]!);
    if (at === undefined) src[k] = -1;
    else {
      src[k] = at;
      pos.delete(want[i + k]!);
    }
  }
  for (const stale of pos.keys()) parent.removeChild(stale);
  // The longest run already in order stays put; the rest move. Walking backwards, each node is
  // inserted before the one placed after it, so `ref` is always in its final position.
  const keep = lis(src);
  let li = keep.length - 1,
    ref = end;
  for (let k = len - 1; k >= 0; k--) {
    const x = want[i + k]!;
    if (src[k] === -1) parent.insertBefore(x, ref);
    else if (li >= 0 && keep[li] === k) li--;
    else move(parent, x, ref);
    ref = x;
  }
}

// #endregion

// #region Host elements

// #region Creating and rendering host elements

/** The namespace children of container `d` are created in (HTML inside a foreignObject). */
function nsOfContainer(d: Any): number {
  const uri = d.namespaceURI;
  return uri === NS_URI[SVG_NS] && d.localName !== "foreignObject"
    ? SVG_NS
    : uri === NS_URI[MATH_NS]
      ? MATH_NS
      : HTML_NS;
}

// Roots, portals and slots keep their container's namespace (worked out
// when they first run): a re-render reads nothing from the DOM for it.
function hostNs(h: Fiber): number {
  return h.n === HOST ? (h.t === "foreignObject" ? HTML_NS : h.ns) : h.ns;
}

/**
 * Render a host element: create (or claim) its DOM element on mount, set changed props, render
 * its children with it as the current host, place them if they changed, then queue its ref.
 */
function runHost(f: Fiber, old: Props | null, mount: boolean): void {
  const p = f.p;
  let dom = f.d;
  if (mount) {
    const type: string = f.t;
    f.ns = type === "svg" ? SVG_NS : type === "math" ? MATH_NS : curNs;
    dom = hydrating ? claimElement(f, type) : null;
    if (dom === null) {
      // `is` must be given at creation: a customized built-in cannot be upgraded later.
      dom =
        f.ns === HTML_NS
          ? document.createElement(type, p.is ? { is: p.is } : undefined)
          : document.createElementNS(NS_URI[f.ns]!, type);
      // Set before options are added, as React does: a select's mode decides how the browser
      // picks the selected option as children arrive.
      if (type === "select") {
        if (p.multiple) dom.multiple = true;
        else if (p.size) dom.size = p.size;
      }
    } else f.f |= CLAIMED;
    f.d = dom;
    dom[FIBER] = f;
    if (hoistable(f, p)) {
      // React 19 document metadata: rendered anywhere, placed in <head>.
      f.f |= HOIST;
      dom[OWN] = null;
      document.head.appendChild(dom);
    } else dom[OWN] = curHost;
  }
  setProps(f, dom, old ?? NO_PROPS, p, mount);
  const ph = curHost,
    pn = curNs;
  curHost = f;
  curNs = hostNs(f);
  try {
    hostChildren(f, dom, p, old);
  } finally {
    curHost = ph;
    curNs = pn;
  }
  if (f.f & CLAIMED) {
    // Hydration: nodes the server rendered that nothing claimed go.
    f.f &= ~CLAIMED;
    if (f.tx === null && p.dangerouslySetInnerHTML == null) removeUnclaimed(dom, f);
  }
  if (f.f & STRUCT) place(f);
  // After the children: the options must exist before the value can select one.
  if (f.t === "select") setSelect(dom, p, mount);
  // Refs attach with layout effects (after the whole render), detach at once.
  const ref = p.ref,
    oref = old === null ? undefined : old["ref"];
  if (ref !== oref) {
    if (oref != null) detachRef(f, oref);
    if (ref != null) later(f, () => attachRef(f, ref, dom));
  }
  if (mount && p.autoFocus && typeof dom.focus === "function") later(f, () => dom.focus());
}

/**
 * Whether a host element is React 19 document metadata that belongs in <head>: <title>, <meta>
 * and <link>, by React's rules. Not in SVG or MathML or with itemProp (microdata stays put), and
 * not a <link> with load handlers or a stylesheet without `precedence`.
 */
function hoistable(f: Fiber, p: Any): boolean {
  const t = f.t;
  if (f.ns !== HTML_NS || p.itemProp != null || (t !== "title" && t !== "meta" && t !== "link")) return false;
  if (t === "link") return p.onLoad == null && p.onError == null && (p.rel !== "stylesheet" || p.precedence != null);
  return true;
}

/**
 * A host's children: raw HTML, a single text (kept in Fiber.tx, with no text fiber), or child
 * fibers through reconcile.
 */
function hostChildren(f: Fiber, dom: Any, p: Any, old: Props | null): void {
  const html = p["dangerouslySetInnerHTML"];
  if (html != null) {
    if (f.c.length) removeAll(f);
    const s = html.__html ?? "";
    if (old === null || old["dangerouslySetInnerHTML"]?.__html !== s || f.tx !== null) {
      // Server HTML that already matches is left alone, so its nodes keep their identity.
      if (!(hydrating && dom.innerHTML === s)) dom.innerHTML = s;
    }
    f.tx = null;
    return;
  }
  // A textarea's children are its default value (see setProps), not content.
  const ch = f.t === "textarea" ? null : p.children;
  const t = typeof ch;
  if (t === "string" || t === "number" || t === "bigint") {
    // Text-only content (`<b>{name}</b>`) is written straight to the element: no fiber and no
    // text node to track, the cheapest form of the most common child.
    const s = "" + ch;
    if (f.c.length) {
      removeAll(f);
      dom.textContent = s;
    } else if (f.tx !== s || (old !== null && old["dangerouslySetInnerHTML"] != null)) {
      // Rewrite the one text node's data when there is one: cheaper than textContent, which
      // replaces the node.
      const fc = dom.firstChild;
      if (fc !== null && fc.nodeType === 3 && fc.nextSibling === null) {
        if (fc.data !== s) fc.data = s;
      } else dom.textContent = s;
    }
    f.tx = s;
    return;
  }
  // Leaving text-only or raw HTML content: clear it before child fibers take over. While
  // hydrating the server's nodes stay, to be claimed.
  if (f.tx !== null || (old !== null && old["dangerouslySetInnerHTML"] != null)) {
    if (!hydrating) dom.textContent = "";
    f.tx = null;
  }
  // React renders a noscript's children only as text: with scripting on, the browser reads its
  // content as text anyway, so element children (a fallback <style>, say) are left out.
  if (f.t === "noscript") return;
  reconcile(f, ch);
}

// #endregion

// #region Prop tables and setProps

// Attributes that are present or absent (true sets "", false removes), lower case.
const BOOL_ATTRS = new Set(
  (
    "allowfullscreen async autofocus autoplay controls default defer disabled disablepictureinpicture " +
    "disableremoteplayback formnovalidate hidden inert loop nomodule novalidate open playsinline readonly " +
    "required reversed scoped seamless itemscope capture download multiple muted selected"
  ).split(" "),
);
// Props whose attribute takes the strings "true" and "false", so a boolean is written as text.
const BOOLEANISH = new Set([
  "contentEditable",
  "draggable",
  "spellCheck",
  "value",
  "autoReverse",
  "externalResourcesRequired",
  "focusable",
  "preserveAlpha",
]);
// Props whose attribute has another name, in every namespace (React's table):
// the HTML ones below, and the presentation attributes SVG spells in
// kebab-case. Every other prop is set under its own name, so camelCase SVG
// attributes (viewBox, gradientUnits, ...) keep their case.
const ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  acceptCharset: "accept-charset",
  tabIndex: "tabindex",
  crossOrigin: "crossorigin",
  xmlnsXlink: "xmlns:xlink",
};
for (const name of (
  "accentHeight alignmentBaseline arabicForm baselineShift capHeight clipPath clipRule colorInterpolation " +
  "colorInterpolationFilters colorProfile colorRendering dominantBaseline enableBackground fillOpacity fillRule " +
  "floodColor floodOpacity fontFamily fontSize fontSizeAdjust fontStretch fontStyle fontVariant fontWeight glyphName " +
  "glyphOrientationHorizontal glyphOrientationVertical horizAdvX horizOriginX imageRendering letterSpacing " +
  "lightingColor markerEnd markerMid markerStart maskType overlinePosition overlineThickness paintOrder " +
  "pointerEvents renderingIntent shapeRendering stopColor stopOpacity strikethroughPosition strikethroughThickness " +
  "strokeDasharray strokeDashoffset strokeLinecap strokeLinejoin strokeMiterlimit strokeOpacity strokeWidth " +
  "textAnchor textDecoration textRendering transformOrigin underlinePosition underlineThickness unicodeBidi " +
  "unicodeRange unitsPerEm vAlphabetic vHanging vIdeographic vMathematical vectorEffect vertAdvY vertOriginX " +
  "vertOriginY wordSpacing writingMode xHeight"
).split(" "))
  ALIASES[name] = name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
// Props that are never attributes: React handles them itself (children, key, ref, raw HTML,
// dev-only flags) or applies them elsewhere (autoFocus on mount, defaults in setInput and
// setProps).
const RESERVED = new Set([
  "children",
  "key",
  "ref",
  "dangerouslySetInnerHTML",
  "suppressHydrationWarning",
  "suppressContentEditableWarning",
  "innerHTML",
  "autoFocus",
  "defaultValue",
  "defaultChecked",
]);
// The `action` React writes for a function action: submitting the form any way but through
// the submit event throws this error instead of navigating. The message is React's.
const ACTION_URL =
  "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')";
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
// Style properties that take plain numbers (Preact's test, which covers React's unitless list).
const UNITLESS = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;

/**
 * Write the difference between old props `o` and new props `p` to `dom`: removed props first,
 * then changed ones, then the form-field values React sets last.
 */
function setProps(f: Fiber, dom: Any, o: Props, p: Any, mount: boolean): void {
  const tag: string = f.t;
  // Inputs take type, value, checked and name after their other attributes, in
  // that order, as React sets them; textareas and selects take their value.
  const skip = tag === "input" ? INPUT_LAST : tag === "textarea" || tag === "select" ? VALUE_LAST : null;
  for (const k in o) {
    if (!(k in p) && !RESERVED.has(k) && (skip === null || !skip.has(k))) setAttr(f, dom, k, null, o[k]);
  }
  for (const k in p) {
    const v = p[k];
    if (v === o[k] || RESERVED.has(k) || (skip !== null && skip.has(k))) continue;
    setAttr(f, dom, k, v, o[k]);
  }
  if (tag === "input") setInput(dom, p, o, mount);
  // Tracked after the initial value is written, so the tracker starts from it.
  if (mount && (tag === "input" || tag === "textarea")) track(dom);
  if (tag === "textarea") {
    // A controlled textarea also keeps defaultValue in step (unless one is given), as React
    // does, so a form reset returns to the last rendered value.
    const v = p.value;
    if (v != null) {
      const s = toStr(v);
      if (mount) dom.defaultValue = s;
      else {
        if (dom.value !== s) dom.value = s;
        if (p.defaultValue == null && dom.defaultValue !== s) dom.defaultValue = s;
      }
    } else if (mount) {
      // React accepts the initial text as children too (a one-item array included).
      const d = p.defaultValue ?? p.children;
      if (d != null) dom.defaultValue = toStr(Array.isArray(d) ? d[0] : d);
    }
  }
}

// #endregion

// #region Form fields

// Props of form fields that setProps leaves to setInput and the textarea and select code.
const INPUT_LAST = new Set(["type", "value", "checked", "name"]);
const VALUE_LAST = new Set(["value"]);
// Strings for type and name: functions, symbols and booleans are left out.
const plain = (v: Any): boolean =>
  v != null && typeof v !== "function" && typeof v !== "symbol" && typeof v !== "boolean";

/**
 * An input's type, value, checked and name, in React's order and by React's rules (ReactDOMInput):
 * type first, since it decides how the browser parses the value; value and defaultValue kept in
 * step; checked through the property, not the attribute.
 */
function setInput(dom: Any, p: Any, o: Props, mount: boolean): void {
  const type = p.type,
    v = p.value,
    dv = p.defaultValue,
    button = type === "submit" || type === "reset";
  if (mount) {
    if (plain(type)) dom.type = type;
    // A submit or reset button with no value keeps the browser's label ("Submit", "Reset").
    if ((v != null || dv != null) && !(button && v == null)) {
      const d = dv != null ? toStr(dv) : "";
      const s = v != null ? toStr(v) : d;
      if (dom.value !== s) dom.value = s;
      dom.defaultValue = s;
    }
    const c = p.checked ?? p.defaultChecked;
    dom.checked = dom.defaultChecked = !!c && typeof c !== "function" && typeof c !== "symbol";
    if (plain(p.name)) dom.name = p.name;
    return;
  }
  if (type !== o["type"]) {
    if (plain(type)) dom.type = type;
    else dom.removeAttribute("type");
  }
  if (v != null) {
    const s = toStr(v);
    // Number inputs compare loosely, as React does: while the user types "1." or "1e" the
    // field's text differs from the value's string but means the same number, and writing it
    // back would move the caret and drop what they typed.
    if (type === "number" ? (v === 0 && dom.value === "") || dom.value != v : dom.value !== s) dom.value = s;
    const d = type === "number" && dom.value == v ? dom.value : s;
    if (dom.defaultValue !== d) dom.defaultValue = d;
  } else {
    if (button) dom.removeAttribute("value");
    if (dv != null) {
      if (dom.defaultValue !== toStr(dv)) dom.defaultValue = toStr(dv);
    } else if (o["defaultValue"] != null) dom.removeAttribute("value");
  }
  if (p.checked == null && p.defaultChecked != null) dom.defaultChecked = !!p.defaultChecked;
  if (p.checked != null) dom.checked = !!p.checked && typeof p.checked !== "function" && typeof p.checked !== "symbol";
  if (p.name !== o["name"]) {
    if (plain(p.name)) dom.name = "" + p.name;
    else dom.removeAttribute("name");
  }
}

/** A field value as React stringifies it: functions, symbols and booleans become "". */
const toStr = (v: Any): string =>
  typeof v === "function" || typeof v === "symbol" || typeof v === "boolean" ? "" : "" + v;

/**
 * Select the options matching a select's value (an array for `multiple`), or its defaultValue on
 * mount. With no match, a single select falls back to its first option, as React's does.
 */
function setSelect(dom: Any, p: Any, mount: boolean): void {
  const v = p.value != null ? p.value : mount ? p.defaultValue : undefined;
  if (v == null) return;
  const opts = dom.options;
  if (p.multiple) {
    const want = new Set((v as Any[]).map(toStr));
    for (let i = 0; i < opts.length; i++) {
      const sel = want.has(opts[i].value);
      if (opts[i].selected !== sel) opts[i].selected = sel;
    }
    return;
  }
  const s = toStr(v);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i].value === s) {
      if (!opts[i].selected) opts[i].selected = true;
      return;
    }
  }
  if (opts.length) opts[0].selected = true;
}

// #endregion

// #region Attributes and styles

/**
 * Set one prop on an element by React's rules: event props register listeners, `style` goes to
 * setStyle, custom elements get properties, and everything else becomes an attribute (aliased,
 * namespaced in SVG, booleans and nulls handled). `f` only needs `ns` and `t`, so blocks pass a
 * small info object in its place.
 */
function setAttr(f: Fiber, dom: Any, name: string, v: Any, old: Any): void {
  // "on" followed by an upper-case letter, by char codes: this runs for every prop of every
  // element, and the test allocates nothing.
  if (name.length > 2 && name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110 && name.charCodeAt(2) < 91) {
    // onX: events read the fiber's props when they fire; only listening is set up here.
    if (v != null) listenFor(dom, name);
    return;
  }
  if (name === "style") return setStyle(dom, v, old);
  if ((name === "action" || name === "formAction") && typeof v === "function") {
    // Submitting runs the function (see submitAction); the URL React puts here
    // stops a submission that bypasses the submit event.
    ensure("submit", false);
    dom.setAttribute(name.toLowerCase(), ACTION_URL);
    return;
  }
  // React 19's custom element rule: a non-string value goes to a property the element defines,
  // so objects, arrays and functions reach it intact.
  if (f.ns === HTML_NS && f.t.includes("-") && name in dom && typeof v !== "string" && v != null) {
    dom[name] = v; // custom element property
    return;
  }
  let attr = ALIASES[name] ?? name;
  let ns: string | null = null;
  // xlinkHref and xmlLang style props live in the XLink and XML namespaces.
  if (f.ns === SVG_NS) {
    if (name.startsWith("xlink") && name.length > 5) ((ns = XLINK), (attr = "xlink:" + name.slice(5).toLowerCase()));
    else if (name.startsWith("xml") && name.length > 3 && name.charCodeAt(3) < 91 && name !== "xmlnsXlink")
      ((ns = XML), (attr = "xml:" + name.slice(3).toLowerCase()));
  }
  if (v == null || typeof v === "function" || typeof v === "symbol") return removeAttr(dom, ns, attr);
  // Booleans: written as text for data-, aria- and booleanish props, as presence for boolean
  // attributes, and dropped elsewhere (React warns and omits them).
  if (typeof v === "boolean") {
    if (name.startsWith("data-") || name.startsWith("aria-") || BOOLEANISH.has(name)) v = "" + v;
    else if (BOOL_ATTRS.has(attr.toLowerCase())) {
      if (!v) return removeAttr(dom, ns, attr);
      v = "";
    } else return removeAttr(dom, ns, attr);
  }
  // The muted attribute only sets the initial state; the property mutes a playing video.
  if (attr === "muted" && f.t === "video") dom.muted = !!v;
  if (ns !== null) dom.setAttributeNS(ns, attr, "" + v);
  else dom.setAttribute(attr, "" + v);
}

/** Remove an attribute; a namespaced one is removed by its local name (after the prefix). */
function removeAttr(dom: Any, ns: string | null, attr: string): void {
  if (ns !== null) dom.removeAttributeNS(ns, attr.slice(attr.indexOf(":") + 1));
  else dom.removeAttribute(attr);
}

/**
 * Apply a style prop: a string as cssText, an object property by property, touching only the
 * properties that changed from `old`.
 */
function setStyle(dom: Any, v: Any, old: Any): void {
  const s = dom.style;
  if (typeof v === "string") {
    s.cssText = v;
    return;
  }
  // From a string to an object: start clean, since the string's properties are not known by name.
  if (typeof old === "string") {
    s.cssText = "";
    old = null;
  }
  if (old != null) for (const k in old) if (v == null || !(k in v)) styleProp(s, k, null);
  if (v != null) for (const k in v) if (old == null || v[k] !== old[k]) styleProp(s, k, v[k]);
}

/**
 * Set one style property. Numbers get "px" unless the property is unitless or the number is 0;
 * custom properties (`--x`, char code 45 is '-') take any value through setProperty.
 */
function styleProp(s: Any, k: string, v: Any): void {
  const val =
    v == null || typeof v === "boolean" || v === ""
      ? ""
      : typeof v === "number" && v !== 0 && k.charCodeAt(0) !== 45 && !UNITLESS.test(k)
        ? v + "px"
        : "" + v;
  if (k.charCodeAt(0) === 45) s.setProperty(k, val);
  else s[k === "float" ? "cssFloat" : k] = val;
}

// #endregion

// #endregion

// #region Blocks: compiled templates (@reactre/compat/compiler)

// The compiler turns a JSX tree of host elements into a template, built once
// per namespace and cloned per instance, and a values array with one value
// per hole: an attribute, a style, an event handler, or a child. Holes have
// React's semantics (setAttr, setStyle, delegated events, children
// reconciled like any others), so a block renders what the JSX would.
//
// Mounting writes the values into the template's own prototype (only where
// they differ from what it holds) and deep-clones it, so the clone is born
// with its attributes and texts. Its hole nodes are looked up on the first
// update, event or element child, never for a row that never changes.

// #region Templates

// The $$typeof of a Template, so kindOf() tells a template type from a component.
const TEMPLATE_TYPE = Symbol.for("reactre-compat.template");

// Hole kinds (Template.kinds).
const H_ATTR = 0;
const H_STYLE = 1;
const H_EVENT = 2;
const H_CHILD = 3;

/**
 * A compiled template: `[tag, props, ...children]`. Props keep their JSX
 * order; a hole's value is `{ h: index }`, any other value is static. A child
 * is static text, a hole index, or an element.
 */
export type TemplateNode = readonly [string, Record<string, Any> | 0, ...(string | number | TemplateNode)[]];

/** Whether a template prop value is a hole (`{ h: index }`); static values are never objects. */
const isHole = (x: Any): boolean => typeof x === "object" && x !== null;
// What a reserved attribute holds before its first value: never equal to a value.
const UNWRITTEN = Symbol("unwritten");

// The document templates build their prototypes in: a <template>'s contents
// owner, which has no browsing context, so its nodes clone without the live
// document's bookkeeping (about a fifth cheaper per clone and insert); the
// clones are adopted when inserted, as nodes are. The page's document where
// there is no such thing.
let inert: Document | null = null;
function inertDocument(): Document {
  if (inert === null) {
    const t: Any = document.createElement("template");
    inert = (t.content?.ownerDocument as Document | undefined) ?? document;
  }
  return inert;
}

/**
 * A compiled template: the analysed description, plus a prototype element per namespace that
 * every block of it clones. One is made per JSX tree at module load (hoisted by the compiler)
 * and shared by every instance.
 */
class Template {
  readonly $$typeof: symbol = TEMPLATE_TYPE;
  /** The compiler's description of the tree. */
  readonly desc: TemplateNode;
  /** How many holes (one more than the highest hole index). */
  n = 0;
  /** Each hole's kind (H_ATTR...), packed: the loop over a block's holes reads it per row. */
  readonly kinds: Uint8Array;
  /** Each hole's prop name (onClick, className, style), or null for a child hole. */
  readonly names: (string | null)[] = [];
  /** Each hole's node as child indexes from the root: an element for props, the anchor for a child. */
  readonly paths: number[][] = [];
  /** Event hole indexes. */
  readonly events: Int32Array;
  // Per namespace (indexed by HTML_NS, SVG_NS, MATH_NS): the prototype, its hole nodes, the
  // element info of each hole and what each hole holds. A template rendered inside <svg> needs
  // its own prototype, since the same tag makes a different element there.
  /** The prototype element, built on first use in that namespace. */
  readonly proto: (Element | null)[] = [null, null, null];
  /** The prototype's hole nodes, by hole index. */
  readonly nodes: Any[][] = [];
  /** Per hole, the `{ ns, t }` of its element, which setAttr reads in place of a fiber. */
  readonly infos: Any[][] = [];
  /** Per hole, the value the prototype holds now, so a mount writes only values that differ. */
  readonly cur: Any[][] = [];
  constructor(desc: TemplateNode) {
    this.desc = desc;
    const kinds: number[] = [];
    this.scan(desc, [], kinds);
    this.kinds = Uint8Array.from(kinds);
    const events: number[] = [];
    for (let i = 0; i < kinds.length; i++) if (kinds[i] === H_EVENT) events.push(i);
    this.events = Int32Array.from(events);
  }
  /** Record each hole under `d` (at `path`): its kind, name and path. */
  private scan(d: TemplateNode, path: number[], kinds: number[]): void {
    const props = d[1];
    if (props) {
      for (const name in props) {
        if (!isHole(props[name])) continue;
        const i: number = props[name].h;
        this.n = Math.max(this.n, i + 1);
        kinds[i] = name === "style" ? H_STYLE : /^on[A-Z]/.test(name) ? H_EVENT : H_ATTR;
        this.names[i] = name;
        this.paths[i] = path;
      }
    }
    for (let c = 2; c < d.length; c++) {
      const x = d[c] as string | number | TemplateNode;
      const p = path.concat(c - 2);
      if (typeof x === "number") {
        this.n = Math.max(this.n, x + 1);
        kinds[x] = H_CHILD;
        this.names[x] = null;
        this.paths[x] = p;
      } else if (typeof x !== "string") this.scan(x, p, kinds);
    }
  }
  /**
   * Build the prototype for namespace ns: static props with React's rules,
   * an empty text node as each child hole's anchor.
   */
  build(ns: number): Element {
    const doc = inertDocument();
    const infos: Any[] = (this.infos[ns] = []);
    const make = (d: TemplateNode, ns0: number): Element => {
      const tag = d[0];
      const own = tag === "svg" ? SVG_NS : tag === "math" ? MATH_NS : ns0;
      const el: Any = own === HTML_NS ? doc.createElement(tag) : doc.createElementNS(NS_URI[own]!, tag);
      // What setAttr reads of a fiber (its namespace and tag), so props go through the same
      // rules as a host element's.
      const info = { ns: own, t: tag };
      const props = d[1];
      if (props) {
        // In prop order, as React sets them: a hole's attribute is reserved
        // here, so its value later lands in the same place.
        for (const k in props) {
          const x = props[k];
          if (!isHole(x)) setAttr(info as Any, el, k, x, undefined);
          else {
            infos[x.h] = info;
            if (/^on[A-Z]/.test(k)) listenFor(el, k);
            // Not style: the browser writes its attribute when it is first
            // serialized, after the others, as React's output has it.
            else if (k !== "style") setAttr(info as Any, el, k, "", undefined);
          }
        }
      }
      const inner = tag === "foreignObject" ? HTML_NS : own;
      for (let c = 2; c < d.length; c++) {
        const x = d[c] as string | number | TemplateNode;
        el.appendChild(
          typeof x === "string"
            ? doc.createTextNode(x)
            : typeof x === "number"
              ? doc.createTextNode("")
              : make(x, inner),
        );
      }
      return el;
    };
    const root = make(this.desc, ns);
    this.proto[ns] = root;
    this.nodes[ns] = this.locate(root);
    // Filled by push: an array with no holes, which the engine keeps packed.
    const cur: Any[] = (this.cur[ns] = []);
    for (let i = 0; i < this.n; i++) cur.push(this.kinds[i] === H_CHILD ? "" : UNWRITTEN);
    return root;
  }
  /** The node of each hole in a tree cloned from the prototype, found by walking its path. */
  locate(root: Node): Any[] {
    const out: Any[] = [];
    for (let i = 0; i < this.n; i++) {
      let node: Any = root;
      for (let ix = 0, xs = this.paths[i]!; ix < xs.length; ix++) {
        const k = xs[ix]!;
        node = node.firstChild;
        for (let j = 0; j < k; j++) node = node.nextSibling;
      }
      out.push(node);
    }
    return out;
  }
}

/** Internal: a template from the compiler's description; the compiler hoists one per JSX tree. */
export function __template(desc: TemplateNode): object {
  return new Template(desc);
}

// #endregion

// #region Block elements

// Symbol keys for a block element's runtime fields, so they never show up as element fields
// to code that inspects elements.
const TPL: unique symbol = Symbol("template");
const VALS: unique symbol = Symbol("values");
const PROPS: unique symbol = Symbol("props");

// An element of a compiled template. To any code that reads it, it is the
// element the JSX would have made: `type` is the tag, and `props` (built on
// first read) the props, children included. Only the runtime reads the
// template and values, under symbols.
// Its own fields are only the key, template and values: one is made per row
// per render. $$typeof, ref and type are read through the prototype.
class BlockElement {
  readonly key: string | null;
  readonly [TPL]: Template;
  readonly [VALS]: Any[];
  [PROPS]: Props | undefined;
  constructor(t: Template, key: string | null, values: Any[]) {
    this.key = key;
    this[TPL] = t;
    this[VALS] = values;
    // Every field set here, in one order: one hidden class for all of them.
    this[PROPS] = undefined;
  }
  // Shared by every block element through the prototype: no per-element field.
  get $$typeof(): symbol {
    return ELEMENT;
  }
  get ref(): null {
    return null;
  }
  get type(): string {
    return this[TPL].desc[0];
  }
  get props(): Props {
    return (this[PROPS] ??= propsOf(this[TPL].desc, this[VALS]));
  }
  // Getters live on the prototype, so JSON.stringify would see only the key: this gives the
  // plain element's fields instead.
  toJSON(): object {
    return { type: this.type, key: this.key, ref: this.ref, props: this.props };
  }
}

/**
 * The props a JSX element would have had for template node `d` with hole values `v`, nested
 * host elements built as ordinary elements. Only made when some code reads `props`.
 */
function propsOf(d: TemplateNode, v: Any[]): Props {
  const props: Props = {};
  const ps = d[1];
  if (ps) for (const k in ps) props[k] = isHole(ps[k]) ? v[ps[k].h] : ps[k];
  const kids: Any[] = [];
  for (let c = 2; c < d.length; c++) {
    const x = d[c] as string | number | TemplateNode;
    kids.push(typeof x === "string" ? x : typeof x === "number" ? v[x] : element(x[0], null, propsOf(x, v)));
  }
  if (kids.length === 1) props["children"] = kids[0];
  else if (kids.length > 1) props["children"] = kids;
  return props;
}

/** Internal: an element of a compiled template with its hole values (@reactre/compat/compiler). */
export function __block(template: object, key: Any, values: Any[]): ReactElement {
  return new BlockElement(template as Template, key == null ? null : "" + key, values) as Any;
}

// #endregion

// #region Rendering blocks

/** A child hole's text: null, undefined and booleans render nothing, as in React. */
const textOf = (v: Any): string => (v == null || typeof v === "boolean" ? "" : "" + v);
/** Whether a child hole's value needs fibers (elements, arrays, promises) rather than text. */
const isNodes = (v: Any): boolean => typeof v === "object" && v !== null;

// Render block f (a block fiber, or a component hosting its block) with
// values v, after values o; its template is f.b's.
function runBlock(f: Fiber, v: Any[], o: Any[] | null, mount: boolean): void {
  const t: Template = f.b![TPL],
    n = t.n,
    kinds = t.kinds;
  if (mount) {
    const ns = curNs;
    const proto: Any = t.proto[ns] ?? t.build(ns);
    const pn = t.nodes[ns]!,
      cur = t.cur[ns]!,
      infos = t.infos[ns]!;
    let nodes = false;
    // Write this block's values into the prototype, skipping each one it already holds (rows of
    // a list often share most values), then clone: one native deep clone instead of a write
    // per hole on the new tree. Events are never written; they are read when they fire.
    for (let i = 0; i < n; i++) {
      const k = kinds[i],
        x = v[i];
      if (k === H_CHILD) {
        // An element child leaves its anchor empty; it is rendered into a slot after the clone.
        const s = isNodes(x) ? ((nodes = true), "") : textOf(x);
        if (cur[i] !== s) pn[i].data = cur[i] = s;
      } else if (k === H_ATTR) {
        if (cur[i] !== x) {
          setAttr(infos[i], pn[i], t.names[i]!, x, cur[i]);
          cur[i] = x;
        }
      } else if (k === H_STYLE && cur[i] !== x) {
        setStyle(pn[i], x, cur[i] === UNWRITTEN ? null : cur[i]);
        cur[i] = x;
      }
    }
    const dom = proto.cloneNode(true);
    if (hydrating) {
      // The server's node for this block is replaced, not claimed.
      const h = curHost;
      if (h.hc !== null) {
        const x = cursor(h);
        if (x !== null) h.hc = x.nextSibling;
      }
    }
    f.d = dom;
    f.ns = ns;
    dom[FIBER] = f;
    dom[OWN] = curHost;
    if (nodes) {
      // Element children change the clone's structure: look up every hole first.
      f.bs = t.locate(dom);
      for (let i = 0; i < n; i++) if (kinds[i] === H_CHILD && isNodes(v[i])) setChild(f, i, v[i], "");
    }
    return;
  }
  // An update compares each value with the last one and writes only what changed. The clone's
  // hole nodes are looked up the first time anything does.
  const again = o === v; // rendered again with the same values: a retry of its children
  let s: Any[] | null = f.bs;
  const infos = t.infos[f.ns]!;
  for (let i = 0; i < n; i++) {
    const k = kinds[i],
      x = v[i];
    // An unchanged value is skipped, except a slot's on a retry: its children must render again.
    if (o![i] === x && !(again && k === H_CHILD && s !== null && s[n + i] !== undefined)) continue;
    if (k === H_EVENT) continue; // read when the event fires
    if (s === null) s = f.bs = t.locate(f.d);
    if (k === H_ATTR) setAttr(infos[i], s[i], t.names[i]!, x, o![i]);
    else if (k === H_STYLE) setStyle(s[i], x, o![i]);
    else setChild(f, i, x, o![i]);
  }
}

// A child hole: text goes into its anchor; anything else is reconciled in a
// slot fiber that places its nodes before the anchor.
// `old` is the hole's last value: what the anchor holds is known from it, so
// the DOM is only written, never read.
function setChild(f: Fiber, i: number, x: Any, old: Any): void {
  const s = f.bs!,
    at = f.b![TPL].n + i;
  let sf: Fiber | undefined = s[at];
  const anchor = s[i];
  if (!isNodes(x)) {
    // From elements back to text: the slot goes, and the anchor (if it left) comes back.
    if (sf !== undefined) {
      const ph = curHost;
      curHost = sf;
      try {
        removeAll(sf);
      } finally {
        curHost = ph;
      }
      if (anchor.parentNode === null) sf.d.appendChild(anchor);
      sf.f |= DEAD;
      s[at] = undefined;
      f.c = f.c.filter((c) => c !== sf);
    }
    const t = textOf(x);
    // After element children the anchor is empty; after text it holds that text.
    if (isNodes(old) ? t !== "" : textOf(old) !== t) anchor.data = t;
    return;
  }
  if (!isNodes(old) && textOf(old) !== "") anchor.data = "";
  if (sf === undefined) {
    sf = new Fiber(SLOT, null, i, f, f.o);
    sf.d = anchor.parentNode;
    sf.ns = nsOfContainer(sf.d);
    sf.s = anchor;
    s[at] = sf;
    f.c = f.c === NO_FIBERS ? [sf] : f.c.concat(sf);
    // The parent's only content (a list in its <tbody>): its nodes are all
    // the parent holds, so the anchor leaves while they are there. Clearing
    // then empties the parent in one write, as a hand-written list does.
    if (anchor.previousSibling === null && anchor.nextSibling === null) sf.d.removeChild(anchor);
  }
  const ph = curHost,
    pn = curNs;
  curHost = sf;
  curNs = sf.ns;
  // A slot's e is the list it last rendered, while its rows match that list
  // one to one; a retry's mark (DIRTY) or a throw clears the match.
  const last = sf.e;
  sf.e = null;
  try {
    // The list loop reported which rows changed since the list this slot holds: patch just
    // those. Anything that does not line up exactly goes through reconcile.
    if (x === deltaOut && last === deltaPrev && last !== null && !(sf.f & DIRTY) && !hydrating && patchDelta(sf, x)) {
      sf.e = x;
    } else {
      reconcile(sf, x);
      sf.f &= ~DIRTY;
      // Rows match the list one to one only when it has no holes: then a later delta applies.
      sf.e = Array.isArray(x) && sf.c.length === x.length ? x : null;
    }
  } catch (e) {
    // The block re-renders on retry, which renders this slot again (see `again` in runBlock).
    f.f |= DIRTY;
    throw e;
  } finally {
    curHost = ph;
    curNs = pn;
  }
  if (sf.f & STRUCT) place(sf);
}

// #endregion

// #region List deltas

// A compiled list loop's report (@reactre/compat/compiler): its new list is
// the list it made last time except at the indexes in deltaIdx.
// setChild uses the report only for the slot whose last list is `deltaPrev` and whose new one
// is `deltaOut`, both compared by identity, so a stale report never matches another list.
let deltaOut: Any[] | null = null,
  deltaPrev: Any[] | null = null,
  deltaIdx: number[] = [];

/** Internal: list `out` equals `prev` but at `idx` (@reactre/compat/compiler). */
export function __delta(out: Any[], prev: Any[], idx: number[]): void {
  deltaOut = out;
  deltaPrev = prev;
  deltaIdx = idx;
}

// Update slot p's rows from the list loop's report, visiting only the rows
// whose elements changed: each patched where it is, or two that traded
// places (a swap) moved. False, having changed nothing out of order, when
// the report does not fit; reconcile then does the whole list.
function patchDelta(p: Fiber, items: Any[]): boolean {
  const old = p.c,
    idx = deltaIdx;
  // Consumed: a report applies to one render only.
  deltaOut = deltaPrev = null;
  if (old.length !== items.length) return false;
  // Two changed rows that hold each other's keys: a swap, done as two DOM moves.
  if (idx.length === 2) {
    const a = idx[0]!,
      b = idx[1]!,
      x = old[a]!,
      y = old[b]!,
      ia = items[a],
      ib = items[b];
    if (
      ia != null &&
      ib != null &&
      typeof ia === "object" &&
      typeof ib === "object" &&
      x.k === keyOf(ib, b) &&
      y.k === keyOf(ia, a) &&
      sameType(x, ib) &&
      sameType(y, ia)
    ) {
      const nx = single(x),
        ny = single(y);
      if (nx === null || ny === null) return false;
      const parent = p.d as Node,
        after = ny.nextSibling;
      move(parent, ny, nx);
      if (b - a > 1) move(parent, nx, after);
      old[a] = y;
      old[b] = x;
      y.i = a;
      x.i = b;
      patchRow(y, ia);
      patchRow(x, ib);
      return true;
    }
  }
  // Otherwise each changed row must keep its key and type, to be patched where it is. The
  // checks run before each patch, so a bail-out leaves only already-correct rows patched.
  for (let ix = 0; ix < idx.length; ix++) {
    const j = idx[ix]!,
      o = old[j]!,
      it = items[j];
    if (it == null || typeof it !== "object" || it.$$typeof !== ELEMENT || o.t !== it.type) return false;
    if (o.k !== (it.key != null ? it.key : j)) return false;
    patchRow(o, it);
  }
  return true;
}

// #endregion

// #region Block events

// Delegated handlers of block f's elements for `prop`, innermost first, on
// the DOM path from `from` up to the block's root.
// The handlers are read from the block's current values when the event fires, so a new handler
// each render costs no DOM write.
function blockHandlers(f: Fiber, prop: string, from: Any, out: Any[]): void {
  const t: Template = f.b![TPL];
  if (t.events.length === 0) return;
  const s = f.bs ?? (f.bs = t.locate(f.d));
  const v = f.b![VALS];
  for (let node = from; node != null; node = node.parentNode) {
    for (let ix = 0, xs = t.events; ix < xs.length; ix++) {
      const i = xs[ix]!;
      if (s[i] === node && t.names[i] === prop) {
        const h = v[i];
        if (typeof h === "function") out.push(node, h);
      }
    }
    if (node === f.d) return;
  }
}

// #endregion

// #endregion

// #region Hydration

// Hydration walks the server's nodes alongside the first render: each host (and the root)
// keeps a cursor (Fiber.hc) at its next unclaimed child. A matching element or text is claimed
// and patched; a mismatch is left for removeUnclaimed and a new node is created in its place.

// The next server node in the host being hydrated, skipping comments.
// Comments (React's text separators and Suspense markers) and doctypes are never claimed.
function cursor(h: Fiber): Any {
  let x = h.hc;
  while (x !== null && (x.nodeType === 8 || x.nodeType === 10)) x = x.nextSibling;
  return x;
}

/**
 * The server's element for host fiber `f` if the cursor is on one with its tag, else null (and
 * `f` creates its own). A claimed element's own children get a cursor of their own.
 */
function claimElement(f: Fiber, type: string): Any {
  const h = curHost;
  if (h.hc === null) return null;
  const x = cursor(h);
  // HTML tags compare in lower case (the parser lower-cases them); SVG keeps camelCase tags.
  if (x === null || x.nodeType !== 1 || x.localName !== (f.ns === HTML_NS ? type.toLowerCase() : type)) {
    // A mismatch does not advance the cursor: a later sibling may still claim this node.
    h.hc = x;
    return null;
  }
  h.hc = x.nextSibling;
  f.hc = x.firstChild;
  return x;
}

/** The server's text node for text `s` if the cursor is on one (patched to `s`), else null. */
function claimText(s: string): Any {
  const h = curHost;
  if (h.hc === null) return null;
  const x = cursor(h);
  if (x === null || x.nodeType !== 3) {
    h.hc = x;
    return null;
  }
  if (x.data !== s) {
    // Adjacent texts (`{a}{b}`) arrive from the server as one node: split off this one's part,
    // and the rest is left for the next text to claim.
    if (s !== "" && x.data.startsWith(s)) x.splitText(s.length);
    else x.data = s;
  }
  h.hc = x.nextSibling;
  return x;
}

/** After hydrating host `h`: remove the server's children nothing claimed (comments stay). */
function removeUnclaimed(dom: Any, h: Fiber): void {
  for (let x = dom.firstChild; x !== null;) {
    const nx = x.nextSibling;
    if (x[OWN] !== h && x.nodeType !== 8) dom.removeChild(x);
    x = nx;
  }
  h.hc = null;
}

// #endregion

// #region Roots and portals

/** What createRoot and hydrateRoot return. */
export interface Root {
  /** Render `children` into the root, replacing what it rendered before. Batched like any update. */
  render(children: Any): void;
  /** Remove everything the root rendered, run cleanups and stop listening. Synchronous. */
  unmount(): void;
}

/**
 * Options for createRoot and hydrateRoot. `identifierPrefix` prefixes useId's ids,
 * `onUncaughtError` receives an error no boundary caught, and `onCaughtError` one an error
 * boundary caught (class support reports it). `onRecoverableError` is accepted and never called:
 * hydration patches mismatches instead of recovering from them.
 */
export interface RootOptions {
  identifierPrefix?: string;
  onUncaughtError?: (error: unknown, info: { componentStack?: string }) => void;
  onCaughtError?: (error: unknown, info: { componentStack?: string }) => void;
  onRecoverableError?: (error: unknown, info: { componentStack?: string }) => void;
}

/** A root: its ROOT fiber, its options, its useId counter and its event listeners. */
class RootImpl implements Root {
  /** The ROOT fiber; its `d` is the container. */
  readonly f: Fiber;
  /** identifierPrefix, for useId. */
  readonly prefix: string;
  readonly opts: RootOptions;
  /** The next useId number. */
  ids = 0;
  /** Whether the first render hydrates the container's server HTML. */
  hydrate = false;
  /** Whether the first render has started (it clears or hydrates the container once). */
  mounted = false;
  /** The event listener on each element this root listens on: its container and portals'. */
  readonly listeners = new Map<Node, Listener>();
  constructor(container: Any, opts: RootOptions) {
    this.opts = opts;
    this.prefix = opts.identifierPrefix ?? "";
    this.f = new Fiber(ROOT, null, 0, null, this);
    this.f.d = container;
    this.f.p = null;
    listenOn(container, this);
  }
  /** Schedule a render of `children`; throws after unmount, as React does. */
  render(children: Any): void {
    if (this.f.f & DEAD) throw new Error("Cannot update an unmounted root.");
    this.f.p = children;
    schedule(this.f);
  }
  /** Remove what the root rendered and its listeners. A second call does nothing. */
  unmount(): void {
    if (this.f.f & DEAD) return;
    const f = this.f;
    // In flushSync, as React's unmount is: cleanups run and pending updates settle before it
    // returns.
    flushSync(() => {
      const ph = curHost;
      curHost = f;
      try {
        removeAll(f);
      } finally {
        curHost = ph;
      }
    });
    f.f |= DEAD;
    for (const l of this.listeners.values()) l.remove();
    this.listeners.clear();
    roots.delete(this);
  }
}

// Every live root.
const roots = new Set<RootImpl>();

/**
 * A root that renders into `container`, replacing its content on the first render.
 * `root.render()` renders in a microtask, batched with other updates (or at once in flushSync).
 */
export function createRoot(container: Element | DocumentFragment, options: RootOptions = {}): Root {
  const r = new RootImpl(container, options);
  roots.add(r);
  return r;
}

/**
 * A root that adopts the server-rendered HTML in `container`: the first
 * render claims matching nodes in order, patches text and attributes that
 * differ, and replaces nodes that do not match. Unlike React, the first render runs before
 * hydrateRoot returns.
 */
export function hydrateRoot(container: Element | Document, children: Any, options: RootOptions = {}): Root {
  const r = new RootImpl(container, options);
  roots.add(r);
  r.hydrate = true;
  r.render(children);
  // Hydrate now, so the server's nodes are claimed before code after this call can change them.
  flushWork(true);
  return r;
}

/**
 * Render a root: on the first run clear the container (or start hydrating it), then render its
 * children. A value thrown to the root (no boundary caught it) unmounts everything and is
 * reported, as React does; a promise retries the root when it settles.
 */
function runRoot(f: Fiber): void {
  const r = f.o;
  const ph = curHost,
    pn = curNs,
    ph2 = hydrating;
  curHost = f;
  curNs = f.ns = nsOfContainer(f.d);
  let thrown = f.x;
  f.x = null;
  if (!r.mounted) {
    r.mounted = true;
    if (r.hydrate) {
      hydrating = true;
      f.hc = f.d.firstChild;
    } else f.d.textContent = "";
  }
  try {
    if (thrown === null) {
      try {
        reconcile(f, f.p);
      } catch (e) {
        thrown = e;
      }
    }
    if (hydrating) {
      hydrating = ph2;
      // A whole document keeps its unclaimed nodes: browser extensions and third-party scripts
      // add nodes to it that must stay.
      if (f.d.nodeType !== 9) removeUnclaimed(f.d, f);
    }
    if (thrown !== null) {
      if (isThenable(thrown)) thrown.then(retry(f), retry(f));
      else {
        removeAll(f);
        const report = r.opts.onUncaughtError;
        if (report) report(thrown, { componentStack: "" });
        else reportError(thrown);
      }
    }
  } finally {
    curHost = ph;
    curNs = pn;
    hydrating = ph2;
  }
  if (f.f & STRUCT) place(f);
}

/**
 * Render a portal: its children are placed in its container, with the portal as their host.
 * The root listens on the container too, so events inside reach handlers through the fiber tree.
 */
function runPortal(f: Fiber, mount: boolean): void {
  if (mount) listenOn(f.d, f.o);
  const ph = curHost,
    pn = curNs;
  curHost = f;
  curNs = f.ns = nsOfContainer(f.d);
  try {
    reconcile(f, f.p.children);
  } finally {
    curHost = ph;
    curNs = pn;
  }
  if (f.f & STRUCT) place(f);
}

// #endregion

// #region Components

// #region Function components

/**
 * Render a function component: call it (again while it sets state during its own render), then
 * reconcile what it returned, or render the block it returns directly when it hosts one.
 */
function runFunc(f: Fiber, mount = false): void {
  const fn = f.s,
    props = f.p,
    prevCur = cur,
    prevHi = hi;
  let out: Any,
    tries = 0;
  cur = f;
  try {
    let args: Any = props,
      ref: Any;
    // forwardRef: the render function gets the ref as its second argument and props without it.
    if (f.f & FORWARD) {
      if ("ref" in props) {
        ref = props.ref;
        args = { ...props };
        delete args.ref;
      } else ref = null;
    }
    // State set during render re-runs the component at once, before its children, as React
    // does; React's limit of 25 passes stops an endless loop.
    do {
      if (++tries > 25)
        throw new Error("Too many re-renders. React limits the number of renders to prevent an infinite loop.");
      f.f &= ~(RERENDER | DIRTY);
      hi = 0;
      // Effects collected by an abandoned pass are dropped.
      f.x = null;
      out = ref === undefined ? fn(args) : fn(args, ref);
    } while (f.f & RERENDER);
  } catch (e) {
    f.f |= DIRTY;
    throw e;
  } finally {
    cur = prevCur;
    hi = prevHi;
  }
  // A component whose render is one compiled block (a list's row) hosts the
  // block itself: no child fiber, one fiber per row. It stays so while it
  // renders that template with that key, and unfuses for good otherwise.
  if (f.f & BOX) {
    const prev = f.b!;
    if (out !== null && typeof out === "object" && out[TPL] === prev[TPL] && out.key === prev.key) {
      f.b = out;
      runBlock(f, out[VALS], prev[VALS], false);
    } else {
      unfuse(f);
      reconcile(f, out);
    }
  } else if (f.c === NO_FIBERS && out !== null && typeof out === "object" && out[TPL] !== undefined && !hydrating) {
    f.f |= BOX;
    f.b = out;
    runBlock(f, out[VALS], null, true);
    // A mount is placed by whoever created it; a component that fuses later
    // (after rendering nothing) has its host place the new node.
    if (!mount) curHost.f |= STRUCT;
  } else reconcile(f, out);
  // After the children: React runs a child's effects before its parent's.
  if (f.x !== null) commitEffects(f);
}

// A component that hosted its block renders something else: the block goes,
// and the component's children are reconciled as anyone's.
function unfuse(f: Fiber): void {
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    unmount(c, false);
  }
  f.c = NO_FIBERS;
  if (f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
  f.f &= ~BOX;
  f.d = null;
  f.b = null;
  f.bs = null;
}

// #endregion

// #region Class components

/** A class component instance. */
export interface Component<P = Props, S = Any> {
  props: P;
  context: Any;
  state: S;
  refs: Record<string, Any>;
  /** Merge `partial` (or what it returns, given state and props) into state, then re-render. */
  setState(partial: Any, callback?: () => void): void;
  /** Re-render, skipping shouldComponentUpdate. */
  forceUpdate(callback?: () => void): void;
  render?(): Any;
  componentDidMount?(): void;
  shouldComponentUpdate?(nextProps: P, nextState: S, nextContext: Any): boolean;
  getSnapshotBeforeUpdate?(prevProps: P, prevState: S): Any;
  componentDidUpdate?(prevProps: P, prevState: S, snapshot?: Any): void;
  componentWillUnmount?(): void;
  componentDidCatch?(error: Any, info: { componentStack?: string }): void;
}

/** The type of Component and PureComponent: classes extend them. */
export interface ComponentClass {
  // Generic over props and state, so `class A extends Component<P, S>` types this.props.
  new <P = Props, S = Any>(props: P, context?: Any): Component<P, S>;
  readonly prototype: Component;
}

// Constructor functions, as React's are: libraries compiled to ES5 subclass
// them with `Component.call(this, props, context)`, which an ES class forbids.
function ComponentFn(this: Any, props: Any, context?: Any): void {
  this.props = props;
  this.context = context;
  this.refs = {};
}
// The marker kindOf() (and React-aware libraries) test to tell a class from a function.
ComponentFn.prototype.isReactComponent = {};
// Without class support loaded, no class component can mount, so there is nothing to update.
ComponentFn.prototype.setState = function (this: Any, partial: Any, callback?: () => void): void {
  if (classes !== null) classes.enqueue(this, partial, callback, false);
};
ComponentFn.prototype.forceUpdate = function (this: Any, callback?: () => void): void {
  if (classes !== null) classes.enqueue(this, null, callback, true);
};

// PureComponent: Component's prototype chain plus React's pure marker.
function PureComponentFn(this: Any, props: Any, context?: Any): void {
  ComponentFn.call(this, props, context);
}
PureComponentFn.prototype = Object.create(ComponentFn.prototype);
PureComponentFn.prototype.constructor = PureComponentFn;
// React's marker: class support compares props and state shallowly for such classes.
PureComponentFn.prototype.isPureReactComponent = true;

/** Base class for class components. */
export const Component: ComponentClass = ComponentFn as Any;
/** A class component that re-renders only when its props or state change (shallowly). */
export const PureComponent: ComponentClass = PureComponentFn as Any;

// Class support is a separate module (@reactre/compat/classes), so
// apps without class components do not ship it. Its entry installs it here.

/**
 * Internal: what class support uses of the runtime. Fibers are opaque to it. Passed as one
 * object, so class support needs no import of this module's internals.
 */
export interface ClassCore {
  readonly DIRTY: number;
  readonly FORCE: number;
  readonly RERENDER: number;
  readonly DEAD: number;
  readonly NO_CONTEXT: object;
  reconcile(f: Any, children: Any): void;
  removeAll(f: Any): void;
  readContext(f: Any, ctx: Any): Any;
  later(f: Any, fn: () => void): void;
  attachRef(f: Any, ref: Any, v: Any): void;
  detachRef(f: Any, ref: Any): void;
  schedule(f: Any): void;
  /** Run fn with f as the component rendering now. */
  rendering<T>(f: Any, fn: () => T): T;
  /** Whether f is the component rendering now. */
  isRendering(f: Any): boolean;
}

/** Internal: what class support provides. */
export interface ClassSupport {
  /** Render class fiber `f` (mount or update), lifecycles included. */
  run(f: Any, old: Props | null, mount: boolean): void;
  /** setState (`force` false) or forceUpdate (`force` true) on an instance. */
  enqueue(inst: Any, partial: Any, cb: (() => void) | undefined, force: boolean): void;
  /** Whether class fiber `f` is an error boundary (getDerivedStateFromError or componentDidCatch). */
  boundary(f: Any): boolean;
  /** componentWillUnmount and ref cleanup for class fiber `f`. */
  unmount(f: Any): void;
}

// Installed class support, or null when the app does not load it.
let classes: ClassSupport | null = null;

/** Internal: installs class support; @reactre/compat/classes calls it when it loads. Once only. */
export function __installClasses(make: (core: ClassCore) => ClassSupport): void {
  // Installed once: a second call keeps the support already in use.
  classes ??= make({
    DIRTY,
    FORCE,
    RERENDER,
    DEAD,
    NO_CONTEXT,
    reconcile,
    removeAll: (f) => removeAll(f),
    readContext,
    later,
    attachRef,
    detachRef,
    schedule,
    rendering(f, fn) {
      const prev = cur;
      cur = f;
      try {
        return fn();
      } finally {
        cur = prev;
      }
    },
    isRendering: (f) => f === cur,
  });
}

/** The error for a class component rendered while class support is not loaded. */
function noClasses(type: Any): Error {
  return new Error(
    `${type.displayName ?? type.name ?? "A class component"} is a class component, and this build leaves class support out. Alias react to @reactre/compat/classes to include it.`,
  );
}

// #endregion

// #region Refs

/**
 * Point `ref` (a callback or an object) at `v`. A callback ref may return a cleanup function
 * (React 19); it is kept in `f.rx` and called instead of `ref(null)` on detach.
 */
function attachRef(f: Fiber, ref: Any, v: Any): void {
  if (typeof ref === "function") {
    const r = ref(v);
    if (typeof r === "function" && f.n !== CLASS) f.rx = r;
  } else if (ref !== null && typeof ref === "object") ref.current = v;
}

/** Detach `ref`: run its cleanup if it returned one, else call it with null or clear `current`. */
function detachRef(f: Fiber, ref: Any): void {
  if (f.n !== CLASS && typeof f.rx === "function") {
    const r = f.rx;
    f.rx = null;
    r();
  } else if (typeof ref === "function") ref(null);
  else if (ref !== null && typeof ref === "object") ref.current = null;
}

// #endregion

// #region Context

/**
 * The value of `ctx` for fiber `f`: the nearest provider above, found by walking up, else the
 * default. The provider records `f` as a reader, so a new value re-renders it (see run).
 * The walk costs only where a context is read; no provider stack is pushed on every render.
 */
function readContext(f: Fiber, ctx: Any): Any {
  for (let p = f.r; p !== null; p = p.r) {
    if (p.n === PROVIDER && p.t === ctx) {
      (p.s ??= new Set<Fiber>()).add(f);
      return p.p.value;
    }
  }
  return ctx._currentValue;
}

// #endregion

// #region Suspense and Activity

// Hide or show the top-level nodes of f's subtree, as React does: elements
// get display: none !important; text is emptied.
function setHidden(f: Fiber, hide: boolean): void {
  const list: Fiber[] = [];
  tops(f, list);
  for (let ix = 0, xs = list; ix < xs.length; ix++) {
    const h = xs[ix]!;
    if (hide === ((h.f & HIDDEN) !== 0)) continue;
    h.f ^= HIDDEN;
    if (h.n === TEXT) h.d.data = hide ? "" : h.p;
    else if (hide) h.d.style.setProperty("display", "none", "important");
    else {
      // Showing again restores the element's own display from its style prop, if it has one.
      h.d.style.removeProperty("display");
      const d = h.n === HOST && h.p.style != null && typeof h.p.style === "object" ? h.p.style.display : undefined;
      if (d != null && d !== "") h.d.style.display = d;
    }
  }
}

/** An internal fragment fiber under `p`: the wrapper Suspense and Activity keep content in. */
function frag(p: Fiber, k: Key): Fiber {
  return new Fiber(FRAG, Fragment, k, p, p.o);
}

/**
 * Render a Suspense boundary. Its primary content lives in a fragment (f.s) and its fallback in
 * another (f.q), so each keeps its state across switches. A promise thrown below (or routed here
 * in f.x) shows the fallback until it settles, then the boundary renders again.
 */
function runSuspense(f: Fiber): void {
  let thrown = f.x;
  f.x = null;
  let primary: Fiber | null = f.s;
  if (thrown === null) {
    try {
      if (primary === null) {
        primary = frag(f, 0);
        try {
          reconcile(primary, f.p.children);
        } catch (e) {
          unmount(primary, true);
          throw e;
        }
        f.s = primary;
      } else reconcile(primary, f.p.children);
      f.f |= SHOWN;
      // Resolved: the fallback goes and the kept content is shown again.
      if (f.q !== null) {
        setHidden(primary, false);
        unmount(f.q, true);
        f.q = null;
        curHost.f |= STRUCT;
      }
      if (f.c.length !== 1 || f.c[0] !== primary) {
        f.c = [primary];
        curHost.f |= STRUCT;
      }
      return;
    } catch (e) {
      // Errors pass through to an error boundary; only promises suspend.
      if (!isThenable(e)) throw e;
      thrown = e;
    }
  }
  // Suspended: keep shown content hidden with its state; drop content never shown.
  // The boundary itself is done; its primary stays DIRTY so the retry renders it again.
  f.f &= ~DIRTY;
  primary = f.s;
  if (primary !== null && !(f.f & SHOWN)) {
    unmount(primary, true);
    primary = f.s = null;
  }
  if (primary !== null) {
    primary.f |= DIRTY;
    setHidden(primary, true);
  }
  let fb: Fiber | null = f.q;
  if (fb === null) {
    fallbackShownAt = performance.now();
    fb = f.q = frag(f, 1);
    try {
      reconcile(fb, f.p.fallback);
    } catch (e) {
      f.q = null;
      unmount(fb, true);
      throw e;
    }
  } else reconcile(fb, f.p.fallback);
  f.c = primary !== null ? [primary, fb] : [fb];
  for (let i = 0, cs = f.c; i < cs.length; i++) cs[i]!.i = i;
  curHost.f |= STRUCT;
  const again = retry(f);
  thrown.then(again, again);
}

/** When a boundary last switched to its fallback (performance.now()), for retry's throttle. */
let fallbackShownAt = -Infinity;
/** React's FALLBACK_THROTTLE_MS. */
const FALLBACK_THROTTLE = 300;

/**
 * A callback that re-renders `f`: what a suspended boundary attaches to the promise.
 *
 * As React does, content a settled promise reveals waits until 300 ms after the last fallback
 * appeared, so content arriving in quick succession shows at once instead of in pieces. React
 * skips the wait when it is 10 ms or less.
 */
function retry(f: Fiber): () => void {
  return () => {
    const ms = fallbackShownAt + FALLBACK_THROTTLE - performance.now();
    if (ms > 10) setTimeout(() => schedule(f), ms);
    else schedule(f);
  };
}

/**
 * Render an Activity. Hidden content stays mounted and keeps rendering (state intact), but its
 * nodes are hidden and its effects cleaned up until it is shown again, as React's does.
 */
function runActivity(f: Fiber): void {
  const hide = f.p.mode === "hidden";
  let inner: Fiber | null = f.s;
  if (inner === null) {
    inner = f.s = frag(f, 0);
    f.c = [inner];
    curHost.f |= STRUCT;
  }
  const was = (f.f & HIDDEN) !== 0;
  reconcile(inner, f.p.children);
  if (hide !== was) {
    f.f ^= HIDDEN;
    setHidden(inner, hide);
    if (hide) disconnect(inner);
    else reconnect(inner);
  }
}

// Clean up and later re-run the effects of a hidden Activity's subtree.
function disconnect(f: Fiber): void {
  if (f.h !== null) {
    for (let ix = 0, xs = f.h; ix < xs.length; ix++) {
      const h = xs[ix]!;
      if (h.k !== 0 && h.x !== undefined) {
        const x = h.x;
        h.x = undefined;
        safely(f, x);
      }
    }
  }
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    disconnect(c);
  }
}

/**
 * Queue the effects of a shown Activity's subtree to run again: children first, and all layout
 * effects of a fiber before its passive ones, the order a mount runs them in.
 */
function reconnect(f: Fiber): void {
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    reconnect(c);
  }
  if (f.h !== null)
    for (let ix = 0, xs = f.h; ix < xs.length; ix++) {
      const h = xs[ix]!;
      if (h.k === LAYOUT) layoutQ.push(h);
    }
  if (f.h !== null)
    for (let ix = 0, xs = f.h; ix < xs.length; ix++) {
      const h = xs[ix]!;
      if (h.k === PASSIVE) passiveQ.push(h);
    }
}

// #endregion

// #endregion

// #region Unmounting

/**
 * Unmount fiber `f` and its subtree: mark it DEAD, detach refs, run effect cleanups and class
 * unmounts. `rm` says whether its nodes must leave the DOM; below a removed node they need not,
 * so only the top nodes of the subtree are removed.
 */
function unmount(f: Fiber, rm: boolean): void {
  f.f |= DEAD;
  switch (f.n) {
    case HOST:
      // A hoisted node sits in <head>, not inside its parent: it is always removed itself.
      if ((rm || f.f & HOIST) && f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
      if (f.p.ref != null) safely(f, () => detachRef(f, f.p.ref));
      for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
        const c = xs[ix]!;
        unmount(c, false);
      }
      return;
    case TEXT:
      if (rm && f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
      return;
    case BLOCK:
      if (rm && f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
      for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
        const c = xs[ix]!;
        unmount(c, false);
      }
      return;
    case FUNC:
      if (f.h !== null) {
        for (let ix = 0, xs = f.h; ix < xs.length; ix++) {
          const h = xs[ix]!;
          if (h.x === undefined) continue;
          // Layout and insertion cleanups run now; passive ones wait for the passive flush, as
          // in React.
          if (h.k !== PASSIVE) safely(f, h.x);
          else if (h.k === PASSIVE) passiveUnmountQ.push(h.x);
          h.x = undefined;
        }
      }
      if (f.f & BOX) {
        // Its block: one node, its slots' nodes inside it.
        if (rm && f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
        for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
          const c = xs[ix]!;
          unmount(c, false);
        }
        return;
      }
      break;
    case CLASS:
      if (classes !== null) safely(f, () => classes!.unmount(f));
      break;
    case PORTAL:
      // A portal's nodes live in its own container, which is not being removed.
      for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
        const c = xs[ix]!;
        unmount(c, true);
      }
      return;
  }
  // Transparent kinds (components, fragments, providers, boundaries) own no node: their
  // children's nodes are the top ones, so `rm` passes down unchanged.
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    unmount(c, rm);
  }
}

// #endregion

// #region Scheduling

// #region Update queue and flushing

let queue: Fiber[] = []; // fibers with a pending update, in the order they were scheduled
let spareQueue: Fiber[] = []; // the other of the two swapped queue arrays (see flushWork)
let flushing = false; // inside flushWork: updates made now join this flush
let batch = 0; // depth of event handlers, flushSync, batchedUpdates and act: no flush until 0
let micro = false; // a microtask flush is queued
let passiveTimer = false; // a passive-effect flush is queued after paint

/**
 * Mark `f` for re-render and queue it once. Outside a batch or a flush, a microtask flush is
 * queued, so several updates in one task render together.
 */
function schedule(f: Fiber): void {
  if (f.f & DEAD) return;
  f.f |= DIRTY;
  if (!(f.f & QUEUED)) {
    f.f |= QUEUED;
    queue.push(f);
  }
  if (!batch && !flushing) flushSoon(false);
}

// Flush in a microtask. `sync`: updates from an event, whose passive
// effects also run before the microtask ends (React's sync lane).
let microSync = false;
function flushSoon(sync: boolean): void {
  if (sync) microSync = true;
  if (micro) return;
  micro = true;
  void RESOLVED.then(runMicro);
}
// One function for every flush: no closure made per update.
function runMicro(): void {
  micro = false;
  const s = microSync;
  microSync = false;
  try {
    flushWork(s);
  } catch (e) {
    // As an error thrown in a queueMicrotask callback is: reported, not a rejection.
    reportUncaught(e);
  }
}
// A resolved promise's then queues a microtask in the same queue, in the same
// order, as queueMicrotask, without leaving the engine for the browser's API.
const RESOLVED = Promise.resolve();
/** Report an error the way an uncaught one is: reportError, or a throw from a fresh task. */
function reportUncaught(e: Any): void {
  if (typeof reportError === "function") reportError(e);
  else
    setTimeout(() => {
      throw e;
    }, 0);
}

// Parents render before children: queued fibers sort by depth, counted when
// more than one is queued (rare) instead of stored in every fiber.
function depth(f: Fiber): number {
  let d = 0;
  for (let p = f.r; p !== null; p = p.r) d++;
  return d;
}
const byDepth = (a: Fiber, b: Fiber): number => depth(a) - depth(b);

/**
 * Render every queued fiber, parents first, then run layout effects, repeating while those
 * queue more work. `sync` also runs passive effects before returning (events, flushSync, act);
 * otherwise they run after paint.
 */
function flushWork(sync: boolean): void {
  // Reentrant calls (flushSync inside an effect) leave the work to the flush already running.
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length || layoutQ.length) {
      while (queue.length) {
        // Effects of the last commit run before the next render, as in React: its refs and
        // layout effects first, so its passive effects never see a ref still unset.
        flushLayout();
        flushPassive();
        // Two queue arrays, swapped: updates made while this one renders go
        // to the other, and neither is allocated again.
        const q = queue;
        queue = spareQueue;
        if (q.length > 1) q.sort(byDepth);
        for (let ix = 0; ix < q.length; ix++) {
          const f = q[ix]!;
          f.f &= ~QUEUED;
          // Skipped when a parent's render already rendered it (DIRTY cleared) or removed it.
          if ((f.f & (DIRTY | DEAD)) === DIRTY) rerender(f);
        }
        q.length = 0;
        spareQueue = q;
      }
      flushLayout();
    }
    if (sync) flushPassive();
  } finally {
    flushing = false;
  }
  // Updates made by the passive effects just run (or left by a throw) get a flush of their own.
  if (queue.length) flushSoon(false);
  if ((passiveQ.length || passiveUnmountQ.length) && !passiveTimer) {
    passiveTimer = true;
    afterPaint(() => {
      passiveTimer = false;
      if (!flushing) {
        flushing = true;
        try {
          flushPassive();
        } finally {
          flushing = false;
        }
        if (queue.length) flushWork(false);
      }
    });
  }
}

// After paint: a MessageChannel message runs as a separate task, so the browser can paint
// first, and it has none of setTimeout's minimum delay.
// One channel for the life of the page (a channel per call would make two ports
// each time); callbacks queued while a message is in flight run with it.
let paintChannel: MessageChannel | null = null;
const paintQ: (() => void)[] = [];
function afterPaint(fn: () => void): void {
  if (typeof MessageChannel !== "function") return void setTimeout(fn, 0);
  if (paintChannel === null) {
    paintChannel = new MessageChannel();
    paintChannel.port1.onmessage = () => {
      const fns = paintQ.splice(0);
      for (let i = 0; i < fns.length; i++) fns[i]!();
    };
  }
  paintQ.push(fn);
  if (paintQ.length === 1) paintChannel.port2.postMessage(null);
}

// Re-render a fiber from the update queue, in its place in the tree.
function rerender(f: Fiber): void {
  // The nearest fiber above that places nodes: f's new nodes are placed in it.
  let h = f.r;
  while (h !== null && h.n !== HOST && h.n !== ROOT && h.n !== PORTAL && h.n !== SLOT) h = h.r;
  const ph = curHost,
    pn = curNs;
  curHost = h ?? f;
  curNs = h === null ? HTML_NS : hostNs(h);
  try {
    run(f, f.p, false);
  } catch (e) {
    throwTo(f, e);
  } finally {
    const host = curHost;
    curHost = ph;
    curNs = pn;
    if (host.f & STRUCT) place(host);
  }
}

// #endregion

// #region Errors and boundaries

// Route a value thrown while rendering (or from an effect) of f to the
// nearest boundary above it, marking the path so a retry renders it again.
function throwTo(f: Fiber, e: Any): void {
  const promise = isThenable(e);
  f.f |= DIRTY;
  // Promises go to the nearest Suspense, errors to the nearest error boundary class; the root
  // takes whatever nothing else does.
  let p = f.r;
  for (; p !== null; p = p.r) {
    if (p.n === ROOT || (promise ? p.n === SUSPENSE : p.n === CLASS && classes !== null && classes.boundary(p))) break;
    p.f |= DIRTY;
  }
  if (p === null) {
    if (f.n === ROOT) p = f;
    else throw e;
  }
  p.x = e;
  schedule(p);
}

/** Run `fn` (an effect, a cleanup, a ref), routing anything it throws to f's boundary. */
function safely(f: Fiber, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    throwTo(f, e);
  }
}

// #endregion

// #region Batching APIs

/**
 * Run `fn` and render every update it makes before returning, passive effects included. With
 * no `fn`, flushes what is pending.
 */
export function flushSync<T>(fn?: () => T): T {
  batch++;
  let r: Any;
  try {
    if (fn) r = fn();
  } finally {
    batch--;
  }
  flushWork(true);
  return r;
}

/** Run `fn` with its updates batched (they are batched anyway). */
export function unstable_batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  batch++;
  try {
    return fn(a);
  } finally {
    if (--batch === 0) flushWork(true);
  }
}

/**
 * Run `callback` and flush every update and effect it causes, as tests expect. An async
 * callback is awaited first. Always returns a promise, so `await act(...)` works either way.
 */
export function act(callback: () => Any): Promise<void> {
  batch++;
  let r: Any;
  try {
    r = callback();
  } finally {
    batch--;
  }
  // Until nothing is pending; capped, so an effect that always schedules cannot hang a test.
  const settle = (): void => {
    for (let i = 0; i < 100 && (queue.length || passiveQ.length || passiveUnmountQ.length || layoutQ.length); i++)
      flushWork(true);
  };
  if (isThenable(r)) return Promise.resolve(r).then(settle);
  settle();
  return Promise.resolve();
}

// #endregion

// #endregion

// #region Effects

// Effect kinds of a hook (Hook.k).
const LAYOUT = 1;
const PASSIVE = 2;
const INSERTION = 3;

// Deps of an effect that has not run yet: never equal to any deps array, so it runs.
const NO_DEPS: unknown[] = [];

/**
 * One hook slot of a function component, also used for a queued effect or `later` callback.
 * Like Fiber, one class with short field names for every hook kind, so all hooks share a shape;
 * each field's meaning depends on the hook that owns it.
 */
class Hook {
  /** The fiber whose hook this is. */
  readonly f: Fiber;
  /** Effect kind, 0 for other hooks. */
  k = 0;
  /** The hook's value: state, ref object, memoized value, cache array. */
  v: Any = undefined;
  /** Committed deps. */
  d: Any = NO_DEPS;
  /** Effect create, or a callback queued by `later`. */
  c: Any = null;
  /** Effect cleanup. */
  x: Any = undefined;
  /** Setter or other per-hook function; null until first render. */
  s: Any = null;
  /** Reducer. */
  r: Any = null;
  constructor(f: Fiber) {
    this.f = f;
  }
}

let layoutQ: Hook[] = []; // layout effects and refs, run before the flush returns
let passiveQ: Hook[] = []; // passive effects, run after paint or before the next render
let passiveUnmountQ: (() => void)[] = []; // passive cleanups of unmounted components

// Queue fn to run with layout effects, in order.
// A Hook of kind 0 serves as the queue entry, so layoutQ holds one type.
function later(f: Fiber, fn: () => void): void {
  const h = new Hook(f);
  h.c = fn;
  layoutQ.push(h);
}

/** Run queued layout effects and refs. The queue is swapped first: effects may queue more. */
function flushLayout(): void {
  const q = layoutQ;
  if (!q.length) return;
  layoutQ = [];
  runEffects(q);
}

/** Run passive cleanups of unmounted components, then queued passive effects. */
function flushPassive(): void {
  const un = passiveUnmountQ;
  if (un.length) {
    passiveUnmountQ = [];
    for (let ix = 0, xs = un; ix < xs.length; ix++) {
      const x = xs[ix]!;
      // The component is gone, so there is no boundary to route to: reported as uncaught.
      try {
        x();
      } catch (e) {
        reportError(e);
      }
    }
  }
  const q = passiveQ;
  if (!q.length) return;
  passiveQ = [];
  runEffects(q);
}

/**
 * Run a queue of effects as React commits them: every cleanup first, then every setup. Effects
 * of fibers that died meanwhile are skipped. A kind-0 entry is a `later` callback, run as is.
 */
function runEffects(q: Hook[]): void {
  for (let ix = 0, xs = q; ix < xs.length; ix++) {
    const h = xs[ix]!;
    if (h.k !== 0 && h.x !== undefined && !(h.f.f & DEAD)) {
      const x = h.x;
      h.x = undefined;
      safely(h.f, x);
    }
  }
  for (let ix = 0, xs = q; ix < xs.length; ix++) {
    const h = xs[ix]!;
    if (h.f.f & DEAD) continue;
    const c = h.c;
    if (h.k === 0) safely(h.f, c);
    else
      safely(h.f, () => {
        const r = c();
        h.x = typeof r === "function" ? r : undefined;
      });
  }
}

// After a function component rendered: commit its effects whose deps changed.
// f.x holds flat triples (hook, create, deps): one array per render, not one object per effect.
function commitEffects(f: Fiber): void {
  const fx: Any[] = f.x;
  f.x = null;
  for (let i = 0; i < fx.length; i += 3) {
    const h: Hook = fx[i],
      deps = fx[i + 2];
    h.c = fx[i + 1];
    h.d = deps;
    // Insertion effects run at once, before any layout effect reads the DOM (React's order for
    // CSS-in-JS); the others wait in their queues.
    if (h.k === INSERTION) {
      if (h.x !== undefined) safely(f, h.x);
      safely(f, () => {
        const r = h.c();
        h.x = typeof r === "function" ? r : undefined;
      });
    } else (h.k === LAYOUT ? layoutQ : passiveQ).push(h);
  }
}

// #endregion

// #region Hooks

// #region Core hooks

// Hooks are matched to their slots by call order, as in React: the component's hooks live in
// f.h and `hi` counts the calls of the current render.

/** The current component's next hook slot, created on its first render. */
function hook(): Hook {
  const f = cur;
  if (f === null)
    throw new Error("Invalid hook call. Hooks can only be called inside of the body of a function component.");
  const hs = (f.h ??= []);
  let h = hs[hi];
  if (h === undefined) hs[hi] = h = new Hook(f);
  hi++;
  return h;
}

/** Whether deps `b` differ from committed deps `a` by Object.is; missing deps always differ. */
function depsChanged(a: Any, b: Any): boolean {
  if (a === NO_DEPS || b == null || a == null || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return true;
  return false;
}

/**
 * Declare an effect of `kind`. When its deps changed (or it has none) it is collected in f.x,
 * to commit after the component's children render; the deps are committed with it then, so an
 * abandoned render commits nothing.
 */
function effect(kind: number, create: () => Any, deps: Any): void {
  const f = cur!,
    h = hook();
  h.k = kind;
  if (deps == null || depsChanged(h.d, deps)) (f.x ??= []).push(h, create, deps ?? null);
}

/** Run `effect` after the browser paints, again whenever `deps` change; its returned function cleans up. */
export function useEffect(create: () => Any, deps?: readonly unknown[]): void {
  effect(PASSIVE, create, deps);
}
/** Like useEffect, but before the browser paints. */
export function useLayoutEffect(create: () => Any, deps?: readonly unknown[]): void {
  effect(LAYOUT, create, deps);
}
/** Like useEffect, but as soon as the component's render completes (for injecting styles). */
export function useInsertionEffect(create: () => Any, deps?: readonly unknown[]): void {
  effect(INSERTION, create, deps);
}

// useState is useReducer with this reducer: an action is the new state or a function of it.
const basicReducer = (s: Any, a: Any): Any => (typeof a === "function" ? a(s) : a);

/** A state value and its setter. The setter is stable for the component's life. */
export function useState<S>(init: S | (() => S)): [S, (action: S | ((prev: S) => S)) => void] {
  return useReducer(basicReducer, init, typeof init === "function" ? (init as () => S) : undefined) as Any;
}

/**
 * State updated through a reducer. Unlike React, dispatch applies the action at once (with the
 * reducer of the latest render) instead of queueing it for the next render, and an action that
 * yields the same state (Object.is) schedules nothing.
 */
export function useReducer<S, A>(
  reducer: (s: S, a: A) => S,
  initArg: Any,
  init?: (arg: Any) => S,
): [S, (a: A) => void] {
  const f = cur!,
    h = hook();
  if (h.s === null) {
    h.v = init !== undefined ? init(initArg) : initArg;
    h.s = (a: A) => {
      // A setter called after unmount does nothing, as in React.
      if (f.f & DEAD) return;
      const next = h.r(h.v, a);
      if (Object.is(next, h.v)) return;
      h.v = next;
      // Set during its own render: runFunc runs the component again before its children.
      if (f === cur) f.f |= RERENDER;
      else schedule(f);
    };
  }
  // Kept current, so the stable dispatch always uses this render's reducer.
  h.r = reducer;
  return [h.v, h.s];
}

/** A mutable object that lives as long as the component. */
export function useRef<T>(init?: T): RefObject<T> {
  const h = hook();
  // h.s set to 1 marks the slot initialized (its value may be anything, undefined included).
  if (h.s === null) {
    h.s = 1;
    h.v = { current: init };
  }
  return h.v;
}

/** `compute()`, recomputed only when `deps` change. */
export function useMemo<T>(compute: () => T, deps?: readonly unknown[]): T {
  const h = hook();
  if (h.s === null || deps == null || depsChanged(h.d, deps)) {
    h.s = 1;
    h.v = compute();
    h.d = deps ?? null;
  }
  return h.v;
}

/** `fn`, replaced only when `deps` change. */
export function useCallback<T>(fn: T, deps?: readonly unknown[]): T {
  const h = hook();
  if (h.s === null || deps == null || depsChanged(h.d, deps)) {
    h.s = 1;
    h.v = fn;
    h.d = deps ?? null;
  }
  return h.v;
}

/** The value of the nearest provider of `ctx` above, or its default. Uses no hook slot. */
export function useContext<T>(ctx: Context<T>): T {
  if (cur === null) throw new Error("Invalid hook call.");
  return readContext(cur, ctx);
}

/**
 * Set `ref` to what `create` returns, with layout effects. A change of `ref` re-runs it, as in
 * React, since the ref is added to the deps.
 */
export function useImperativeHandle(ref: Any, create: () => Any, deps?: readonly unknown[]): void {
  effect(
    LAYOUT,
    () => {
      if (typeof ref === "function") {
        const r = ref(create());
        return () => (typeof r === "function" ? r() : ref(null));
      }
      if (ref != null) {
        ref.current = create();
        return () => {
          ref.current = null;
        };
      }
      return undefined;
    },
    deps != null ? [...deps, ref] : undefined,
  );
}

/** Does nothing: there are no development tools to label. */
export function useDebugValue(_value: unknown, _format?: (v: Any) => Any): void {}

/**
 * A unique id, stable for the component's life. A per-root counter in React 19's format
 * (`_r_0_`, with the root's identifierPrefix after the first `_`). It is not derived from the
 * tree position, so it need not match the id the server rendered.
 */
export function useId(): string {
  const h = hook();
  if (h.s === null) {
    h.s = 1;
    const r = h.f.o;
    h.v = "_" + r.prefix + "r_" + (r.ids++).toString(32) + "_";
  }
  return h.v;
}

/**
 * A value read from an external store, re-rendering when it changes. The server snapshot is
 * ignored: hydration reads the client's snapshot.
 */
export function useSyncExternalStore<T>(
  subscribe: (cb: () => void) => () => void,
  getSnapshot: () => T,
  _server?: () => T,
): T {
  const f = cur!;
  const v = getSnapshot();
  const h = hook();
  // A box the subscription reads, updated each render: the latest snapshot and getter, without
  // resubscribing when only getSnapshot changes.
  if (h.s === null) h.s = { v, g: getSnapshot };
  const box = h.s;
  box.v = v;
  box.g = getSnapshot;
  effect(PASSIVE, () => {
    // A throwing getSnapshot counts as a change, as in React: the re-render rethrows it to the
    // nearest boundary.
    const check = (): void => {
      let changed = true;
      try {
        changed = !Object.is(box.g(), box.v);
      } catch {}
      if (changed) schedule(f);
    };
    // The store may have changed between render and subscribing.
    check();
    return subscribe(check);
  }, [subscribe]);
  return v;
}

/**
 * The store hook with a selector, as use-sync-external-store/with-selector exports it: the
 * selection is recomputed only for a new snapshot, and kept while `isEqual` says it is equal.
 */
export function useSyncExternalStoreWithSelector<S, T>(
  subscribe: (cb: () => void) => () => void,
  getSnapshot: () => S,
  getServerSnapshot: (() => S) | undefined | null,
  selector: (s: S) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const memo = useRef<{ s: S; t: T } | null>(null);
  const select = useCallback(() => {
    const s = getSnapshot();
    const m = memo.current;
    if (m !== null && Object.is(m.s, s)) return m.t;
    const t = selector(s);
    if (m !== null && isEqual !== undefined && isEqual(m.t, t)) {
      memo.current = { s, t: m.t };
      return m.t;
    }
    memo.current = { s, t };
    return t;
  }, [getSnapshot, selector, isEqual]);
  void getServerSnapshot;
  return useSyncExternalStore(subscribe, select);
}

/** A stable function that always calls the latest `fn` (for effects that must not re-run when it changes). */
export function useEffectEvent<F extends (...args: Any[]) => Any>(fn: F): F {
  const h = hook();
  if (h.s === null) {
    h.v = fn;
    h.s = (...args: Any[]) => h.v(...args);
  }
  // Updated during render, not in an effect: rendering is synchronous, so the effects that call
  // the function run after the render that set it.
  h.v = fn;
  return h.s;
}

/**
 * The React Compiler's per-component cache (`react/compiler-runtime`): an array of `size` slots
 * that outlives renders. Elements the compiler keeps in it come back as the same objects, which
 * is what lets the identity bailout skip their subtrees.
 */
export function c(size: number): Any[] {
  const h = hook();
  if (h.s === null) {
    h.s = 1;
    // Filled with React's sentinel, which compiled code tests for "not computed yet".
    h.v = new Array(size).fill(MEMO_SENTINEL);
  }
  return h.v;
}
export { c as useMemoCache };

/** `{ c }`, which `react/compiler-runtime` re-exports. */
export const __COMPILER_RUNTIME: { c: typeof c } = { c };

// #endregion

// #region use and thenables

// Thenables, as React 19 tracks them on the promise itself.
// status, value and reason are written on the thenable, so every component (and React-aware
// libraries) reading the same promise share one result, and a settled one reads synchronously.
function readThenable(t: Any): Any {
  switch (t.status) {
    case "fulfilled":
      return t.value;
    case "rejected":
      throw t.reason;
  }
  if (t.status !== "pending") {
    t.status = "pending";
    t.then(
      (v: Any) => {
        if (t.status === "pending") ((t.status = "fulfilled"), (t.value = v));
      },
      (e: Any) => {
        if (t.status === "pending") ((t.status = "rejected"), (t.reason = e));
      },
    );
    // A thenable that resolves synchronously is read at once.
    if (t.status === "fulfilled") return t.value;
    if (t.status === "rejected") throw t.reason;
  }
  throw t;
}

/**
 * Read a context, or a promise's value (suspending until it settles). Uses no hook slot, so it
 * may be called conditionally, as React allows.
 */
export function use<T>(usable: PromiseLike<T> | Context<T>): T {
  if ((usable as Any).$$typeof === CONTEXT_TYPE) {
    if (cur === null) throw new Error("Invalid hook call.");
    return readContext(cur, usable);
  }
  return readThenable(usable);
}

// #endregion

// #region Transitions and actions

// Rendering is synchronous, so a transition changes no render priority: what it tracks is the
// async work it started, to know when it is over (pending flags, optimistic state, form status).

/** A running transition or action. */
interface Transition {
  /** Callbacks run when it finishes: clear pending flags and optimistic updates. */
  readonly done: (() => void)[];
  /** Async work started inside the transition (queued actions), which it waits for. */
  readonly wait?: PromiseLike<unknown>[];
}
// The transition whose callback is running now, so updates and actions made in it join it.
let transition: Transition | null = null;

/** Run `fn` with `t` as the current transition. */
function inTransition(t: Transition, fn: () => Any): Any {
  const prevT = transition;
  transition = t;
  try {
    return fn();
  } finally {
    transition = prevT;
  }
}

/**
 * Finish transition `t` once `r` (its callback's result) and the work it queued settle; a
 * rejection goes to `onError`, or is reported.
 */
function settle(t: Transition, r: Any, onError?: (e: Any) => void): void {
  const fin = (): void => {
    for (const d of t.done) d();
  };
  if (t.wait !== undefined && t.wait.length) r = Promise.all([r, ...t.wait]);
  if (isThenable(r))
    r.then(fin, (e: Any) => {
      fin();
      if (onError) onError(e);
      else reportError(e);
    });
  else fin();
}

/** Run `fn` as a transition. Rendering is synchronous, so its updates render at once. */
export function startTransition(fn: () => Any): void {
  const t: Transition = { done: [], wait: [] };
  settle(t, inTransition(t, fn));
}

/**
 * `[isPending, startTransition]`; pending lasts while an async transition runs. An error from
 * the transition goes to the component's nearest error boundary, as in React.
 */
export function useTransition(): [boolean, (fn: () => Any) => void] {
  const [pending, setPending] = useState(false);
  const f = cur!;
  const h = hook();
  if (h.s === null) {
    h.s = (fn: () => Any) => {
      setPending(true);
      const t: Transition = { done: [() => setPending(false)], wait: [] };
      let r: Any;
      try {
        r = inTransition(t, fn);
      } catch (e) {
        setPending(false);
        throw e;
      }
      settle(t, r, (e) => throwTo(f, e));
    };
  }
  return [pending, h.s];
}

/**
 * The value; `initial` on the first render, then the value right after. With synchronous
 * rendering there is no background render to defer to, so later renders return `value` itself.
 */
export function useDeferredValue<T>(value: T, initial?: T): T {
  const h = hook();
  if (h.s === null) {
    h.s = 1;
    if (initial !== undefined) {
      // h.v is true while `initial` shows; a layout callback switches to the value at once.
      h.v = true;
      const f = h.f;
      later(f, () => {
        h.v = false;
        schedule(f);
      });
      return initial;
    }
  }
  return h.v === true ? (initial as T) : value;
}

/**
 * State shown optimistically while an action or transition runs, then dropped. Each pending
 * update is replayed over the current `passthrough` on every render, so the real state shows
 * through as soon as it arrives.
 */
export function useOptimistic<S, A>(passthrough: S, reducer?: (s: S, a: A) => S): [S, (a: A) => void] {
  const h = hook();
  if (h.s === null) {
    const f = h.f;
    // The pending updates, each in its own box so clear() removes exactly that one.
    h.v = [];
    h.s = (a: A) => {
      const entry = { a };
      h.v = [...h.v, entry];
      schedule(f);
      const clear = (): void => {
        h.v = h.v.filter((x: Any) => x !== entry);
        schedule(f);
      };
      // Outside a transition there is nothing to wait for: dropped right after this task's
      // updates.
      if (transition !== null) transition.done.push(clear);
      else queueMicrotask(clear);
    };
  }
  let s = passthrough;
  for (const x of h.v) s = reducer ? reducer(s, x.a) : x.a;
  return [s, h.s];
}

/** `[state, dispatch, isPending]`: dispatch runs `action(state, payload)`, one at a time, and keeps its result. */
export function useActionState<S, P>(
  action: (state: S, payload: P) => S | Promise<S>,
  initialState: S,
  _permalink?: string,
): [S, (payload: P) => void, boolean] {
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState(false);
  const f = cur!;
  const h = hook();
  if (h.s === null) {
    // a: the latest action; s: the state the next call starts from; n: calls running or queued;
    // p: the tail of the chain that runs calls one after another, as React queues them.
    const box = (h.v = { a: action, s: initialState, n: 0, p: Promise.resolve() as Promise<unknown> });
    h.s = (payload: P) => {
      box.n++;
      setPending(true);
      const t: Transition = { done: [] };
      const outer = transition;
      box.p = box.p
        .then(() => inTransition(t, () => box.a(box.s, payload)))
        .then(
          (next) => {
            box.s = next as S;
            setState(() => next as S);
          },
          (e) => throwTo(f, e),
        )
        .finally(() => {
          for (const d of t.done) d();
          if (--box.n === 0) setPending(false);
        });
      // A form action or transition that queued this waits for it.
      if (outer !== null && outer.wait !== undefined) outer.wait.push(box.p);
    };
  }
  h.v.a = action;
  return [state, h.s, pending];
}
export { useActionState as useFormState };

// #endregion

// #region Forms

/** Status of the nearest `<form>` above while its action runs. */
export interface FormStatus {
  readonly pending: boolean;
  readonly data: FormData | null;
  readonly method: string | null;
  readonly action: Any;
}
const IDLE: FormStatus = { pending: false, data: null, method: null, action: null };

/**
 * The status of the form this component renders inside. The form records the component, so a
 * status change re-renders it. Uses no hook slot.
 */
export function useFormStatus(): FormStatus {
  const f = cur!;
  for (let p = f.r; p !== null; p = p.r) {
    if (p.n === HOST && p.t === "form") {
      (p.q ??= new Set<Fiber>()).add(f);
      return p.s ?? IDLE;
    }
  }
  return IDLE;
}

/** Set a form fiber's status and re-render the components that read it. */
function setFormStatus(form: Fiber, st: FormStatus): void {
  form.s = st;
  if (form.q !== null) for (const s of form.q as Set<Fiber>) schedule(s);
}

/**
 * Run a form's function action as a transition: pending status while it runs, then the form is
 * reset (React 19 resets a form after its action), unless it unmounted meanwhile.
 */
function runFormAction(form: Fiber, action: Any, data: FormData): void {
  const el = form.d as HTMLFormElement;
  setFormStatus(form, { pending: true, data, method: el.method, action });
  const t: Transition = {
    done: [
      () => {
        setFormStatus(form, IDLE);
        if (!(form.f & DEAD)) el.reset();
      },
    ],
    wait: [],
  };
  settle(
    t,
    inTransition(t, () => action(data)),
    (e) => throwTo(form, e),
  );
}

/** Reset a form when its running action finishes (forms with actions reset anyway). */
export function requestFormReset(form: HTMLFormElement): void {
  const f = (form as Any)[FIBER] as Fiber | undefined;
  // While an action runs the reset is due anyway when it finishes.
  if (f === undefined || f.s === null || !f.s.pending) form.reset();
}

// #endregion

// #region Server-only APIs and stubs

/** The client has no cache: the function itself. */
export function cache<F>(fn: F): F {
  return fn;
}
/** Always null on the client. */
export function cacheSignal(): null {
  return null;
}
/** Always null: there are no owner stacks outside development builds. */
export function captureOwnerStack(): null {
  return null;
}
/** A function that does nothing: there is no cache to refresh. */
export function unstable_useCacheRefresh(): () => void {
  return noop;
}
const noop = (): void => {};

// #endregion

// #endregion

// #region Events

// #region Listening

// Events that do not bubble: one listener on the element itself.
const DIRECT = new Set(
  (
    "scroll scrollend load error abort toggle beforetoggle " +
    "invalid cancel close canplay canplaythrough durationchange emptied encrypted ended loadeddata " +
    "loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend " +
    "timeupdate volumechange waiting"
  ).split(" "),
);
// Native type -> React prop name, recorded as props use them.
const PROP_OF = new Map<string, string>([
  ["dblclick", "onDoubleClick"],
  ["focusin", "onFocus"],
  ["focusout", "onBlur"],
]);
// The `type` a synthetic event reports when it differs from the native event's: React's
// onFocus and onBlur listen to focusin and focusout but say focus and blur, and onChange says
// change whatever native event fired it.
const SYN_TYPE: Record<string, string> = { onChange: "change", onFocus: "focus", onBlur: "blur" };
// Every native type some prop has used, for bubbling and capture handlers. Each root listens to
// all of them; a new type is added to every root (see ensure).
const bubbleTypes: string[] = [];
const captureTypes: string[] = [];
const listeners = new Set<Listener>();

/**
 * The native type behind a React event prop (without "Capture"). onFocus and onBlur use focusin
 * and focusout, which bubble, as React's do.
 */
function eventType(base: string): string {
  switch (base) {
    case "onDoubleClick":
      return "dblclick";
    case "onFocus":
      return "focusin";
    case "onBlur":
      return "focusout";
  }
  return base.slice(2).toLowerCase();
}

// Make sure events for prop `name` (onClick, onKeyDownCapture, ...) reach dom.
// Listeners are only ever added: removing a prop leaves them, and dispatch finds no handler.
function listenFor(dom: Any, name: string): void {
  // onGotPointerCapture and onLostPointerCapture end in "Capture" but are bubble-phase props.
  const capture = name.endsWith("Capture") && name !== "onGotPointerCapture" && name !== "onLostPointerCapture";
  const base = capture ? name.slice(0, -7) : name;
  // React's onChange fires on input for text fields, click for checkboxes and radios, and
  // change for the rest (see propsFor), so it needs all three.
  if (base === "onChange") {
    ensure("input", capture);
    ensure("change", capture);
    ensure("click", capture);
    return;
  }
  if (ENTER_LEAVE.has(base)) {
    // Derived from over and out events, as React does: they fire per element
    // entered or left, outermost first for enter, innermost first for leave.
    const kind = base.startsWith("onMouse") ? "mouse" : "pointer";
    ensure(kind + "over", false);
    ensure(kind + "out", false);
    return;
  }
  const type = eventType(base);
  if (!PROP_OF.has(type)) PROP_OF.set(type, base);
  if (DIRECT.has(type)) {
    const set: Set<string> = (dom[LISTENS] ??= new Set<string>());
    if (!set.has(type)) {
      set.add(type);
      dom.addEventListener(type, direct);
    }
    return;
  }
  ensure(type, capture);
}

/** Make every root and portal container listen for native `type` in one phase. */
function ensure(type: string, capture: boolean): void {
  const list = capture ? captureTypes : bubbleTypes;
  // Arrays, not sets: Listener.sync walks them by index to add only the types it lacks.
  if (list.includes(type)) return;
  list.push(type);
  for (const l of listeners) l.sync();
}

/**
 * A root's delegated listeners on one element (its container, or a portal's). It keeps up with
 * bubbleTypes and captureTypes by count, so sync() adds only types added since the last call.
 */
class Listener {
  readonly el: Node;
  readonly root: RootImpl;
  /** How many of bubbleTypes and captureTypes it listens to so far. */
  nb = 0;
  nc = 0;
  /** The bubble and capture handlers, made once so they can be removed. */
  readonly b: (e: Event) => void;
  readonly cp: (e: Event) => void;
  constructor(el: Node, root: RootImpl) {
    this.el = el;
    this.root = root;
    this.b = (e) => dispatch(e, root, false);
    this.cp = (e) => dispatch(e, root, true);
    this.sync();
  }
  /** Add listeners for the types added to bubbleTypes and captureTypes since the last sync. */
  sync(): void {
    for (; this.nb < bubbleTypes.length; this.nb++) this.el.addEventListener(bubbleTypes[this.nb]!, this.b);
    for (; this.nc < captureTypes.length; this.nc++) this.el.addEventListener(captureTypes[this.nc]!, this.cp, true);
  }
  /** Remove every listener it added (the root unmounted). */
  remove(): void {
    for (let i = 0; i < this.nb; i++) this.el.removeEventListener(bubbleTypes[i]!, this.b);
    for (let i = 0; i < this.nc; i++) this.el.removeEventListener(captureTypes[i]!, this.cp, true);
    listeners.delete(this);
  }
}

/** Make `root` listen on `el` (its container or a portal's), once. */
function listenOn(el: Node, root: RootImpl): void {
  if (root.listeners.has(el)) return;
  const l = new Listener(el, root);
  root.listeners.set(el, l);
  listeners.add(l);
}

// Native event expandos: the roots that already dispatched it in each phase. A portal's
// container inside its own root's container gets the event twice; the second is ignored.
const SEEN_B = Symbol("seen");
const SEEN_C = Symbol("seen capture");

// #endregion

// #region Change tracking

// Inputs whose onChange follows `input` events; checkboxes and radios follow
// `click` (when their checked state changed), selects and files `change`.
function textLike(el: Any): boolean {
  const tag = el.nodeName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const t = el.type;
  return t !== "checkbox" && t !== "radio" && t !== "file";
}

// React's value tracker: an input or textarea records the value last set
// through its own `value` property (`checked` for checkboxes and radios), by
// code or by render. onChange fires only when the field's value differs from
// it, so a script that sets `el.value` and dispatches an input event causes
// no onChange, as in React.
function track(dom: Any): void {
  const key = checkable(dom) ? "checked" : "value";
  const proto = Object.getPrototypeOf(dom);
  const desc = Object.getOwnPropertyDescriptor(proto, key);
  // Already tracked (an own property, defined by another tracker): leave it.
  if (desc === undefined || desc.set === undefined || Object.hasOwn(dom, key)) return;
  dom[TRACKED] = "" + dom[key];
  Object.defineProperty(dom, key, {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    get(this: Any): Any {
      return desc.get!.call(this);
    },
    set(this: Any, v: Any): void {
      this[TRACKED] = "" + v;
      desc.set!.call(this, v);
    },
  });
}

// Whether the field's value moved since the tracker last saw it; records it
// unless `peek` (the capture phase looks without taking the change).
function changed(el: Any, peek: boolean): boolean {
  if (el[TRACKED] === undefined) return true;
  const v = checkable(el) ? (el.checked ? "true" : "false") : "" + el.value;
  if (v === el[TRACKED]) return false;
  if (!peek) el[TRACKED] = v;
  return true;
}

/** Whether `el` is a checkbox or radio, whose onChange tracks `checked`. */
function checkable(el: Any): boolean {
  return el.nodeName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
}

// #endregion

// #region Dispatch

// Lists of the props a native event fires, shared and never written, so a dispatch allocates
// none.
const PROP_LIST = new Map<string, string[]>();
const ON_INPUT = ["onInput"],
  ON_INPUT_CHANGE = ["onInput", "onChange"],
  ON_CHANGE = ["onChange"];

// The React props native event `type` fires on `target`, or null for none.
// `f` is the target's fiber: only a host <input> can be a checkbox (blocks
// never hold inputs), so a click elsewhere reads nothing from the DOM.
function propsFor(type: string, target: Any, capture: boolean, f: Fiber): string[] | null {
  if (type === "input") return textLike(target) && changed(target, capture) ? ON_INPUT_CHANGE : ON_INPUT;
  if (type === "change") return textLike(target) || checkable(target) ? null : ON_CHANGE;
  const name = PROP_OF.get(type);
  if (type === "click" && f.n === HOST && f.t === "input" && checkable(target) && changed(target, capture)) {
    return name === undefined ? ON_CHANGE : [name, "onChange"];
  }
  if (name === undefined) return null;
  // One read-only list per prop name, made once.
  let one = PROP_LIST.get(name);
  if (one === undefined) PROP_LIST.set(name, (one = [name]));
  return one;
}

/**
 * Handle native event `e` for `root` in one phase: find the target's fiber, collect the
 * handlers on the fiber path (so events bubble through portals, as in React), and call them with
 * one synthetic event, innermost first for bubbling, outermost first for capture. Updates they
 * make are batched until the handlers return.
 */
function dispatch(e: Any, root: RootImpl, capture: boolean): void {
  const mark = capture ? SEEN_C : SEEN_B;
  const seen: RootImpl[] | undefined = e[mark];
  if (seen !== undefined) {
    if (seen.includes(root)) return;
    seen.push(root);
  } else e[mark] = [root];
  // The nearest element this root rendered (text nodes and foreign nodes have no fiber).
  let node = e.target;
  while (node != null && !(node[FIBER] !== undefined && node[FIBER].o === root)) node = node.parentNode;
  if (node == null) return;
  const target: Fiber = node[FIBER];
  const type: string = e.type;
  const names = propsFor(type, node, capture, target);
  const over = !capture && OVER_OUT.has(type);
  if (names === null && !over && type !== "submit") return;
  // Controlled fields are restored once, after the bubble phase.
  const changed = !capture && names !== null && names.includes("onChange");
  batch++;
  try {
    if (over) enterLeave(e, root, type, target);
    if (names !== null)
      for (let ix = 0, xs = names; ix < xs.length; ix++) {
        const name = xs[ix]!;
        const prop = capture ? name + "Capture" : name;
        // Element and handler pairs, innermost first: host fibers, and the
        // elements of blocks on the way (entered at the event's target, or
        // at a slot's parent element).
        const path: Any[] = [];
        let from: Any = e.target;
        for (let f: Fiber | null = target; f !== null; f = f.r) {
          if (f.f & DEAD) continue;
          if (f.n === HOST) {
            if (typeof f.p[prop] === "function") path.push(f.d, f.p[prop]);
          } else if (f.b !== null) blockHandlers(f, prop, from, path);
          else if (f.n === SLOT) from = f.d;
        }
        if (path.length === 0) continue;
        // One synthetic event per prop, made only when some handler will see it.
        const syn = synthetic(e, name);
        const last = path.length - 2;
        for (let q = 0; q <= last; q += 2) {
          if (syn._stopped) break;
          const at = capture ? last - q : q;
          syn.currentTarget = path[at];
          path[at + 1](syn);
        }
        syn.currentTarget = null;
      }
    // A form action runs after the onSubmit handlers, unless one prevented the default.
    if (!capture && e.type === "submit" && !e.defaultPrevented) submitAction(e, target);
  } finally {
    if (--batch === 0) afterEvent(changed ? target : undefined);
  }
}

// #endregion

// #region Enter and leave

// Props derived from over and out events, and the native types they come from.
const ENTER_LEAVE = new Set(["onMouseEnter", "onMouseLeave", "onPointerEnter", "onPointerLeave"]);
const OVER_OUT = new Set(["mouseover", "mouseout", "pointerover", "pointerout"]);

/** The fiber of the nearest element at or above `node` that `root` rendered, or null. */
function fiberAt(node: Any, root: RootImpl): Fiber | null {
  while (node != null && !(node[FIBER] !== undefined && node[FIBER].o === root)) node = node.parentNode;
  return node == null ? null : node[FIBER];
}

/** The host fibers from `f` up to the root, innermost first. */
function hostPath(f: Fiber | null): Fiber[] {
  const out: Fiber[] = [];
  for (; f !== null; f = f.r) if (f.n === HOST) out.push(f);
  return out;
}

// onMouseLeave on the elements left and onMouseEnter on those entered.
// `out` events carry both ends; an `over` event counts only when the pointer
// comes from outside this root (React's rule).
function enterLeave(e: Any, root: RootImpl, type: string, target: Fiber): void {
  const mouse = type.startsWith("mouse");
  let from: Fiber | null, to: Fiber | null;
  const related = e.relatedTarget;
  if (type.endsWith("over")) {
    if (related != null && fiberAt(related, root) !== null) return;
    from = null;
    to = target;
  } else {
    from = target;
    to = related == null ? null : fiberAt(related, root);
  }
  if (from === to) return;
  const a = hostPath(from),
    b = hostPath(to);
  const common = new Set(b);
  const leave = mouse ? "onMouseLeave" : "onPointerLeave",
    enter = mouse ? "onMouseEnter" : "onPointerEnter";
  const left = a.filter((f) => !common.has(f));
  const shared = new Set(a);
  const entered = b.filter((f) => !shared.has(f)).reverse();
  // An end's element: a fiber's node, or inside a block the element itself.
  const node = (f: Fiber | null, native: Any): Any =>
    f === null ? null : f.b !== null ? (native.nodeType === 1 ? native : native.parentNode) : f.d;
  const fromNode = node(from, from === target ? e.target : related),
    toNode = node(to, to === target ? e.target : related);
  const fire = (list: Fiber[], name: string, tgt: Any, rel: Any): void => {
    let syn: Any = null;
    for (let ix = 0, xs = list; ix < xs.length; ix++) {
      const f = xs[ix]!;
      const fn = f.p[name];
      if (typeof fn !== "function") continue;
      if (syn === null) {
        syn = synthetic(e, name);
        syn.type = mouse
          ? name === leave
            ? "mouseleave"
            : "mouseenter"
          : name === leave
            ? "pointerleave"
            : "pointerenter";
        syn.target = tgt;
        syn.relatedTarget = rel;
      }
      syn.currentTarget = f.d;
      fn(syn);
    }
  };
  fire(left, leave, fromNode, toNode);
  fire(entered, enter, toNode, fromNode);
}

// #endregion

// #region After handlers, and direct listeners

// After an event's handlers: React renders their updates in a microtask,
// except that a controlled field is rendered at once and shown its props again.
function afterEvent(target: Fiber | undefined): void {
  if (target !== undefined && isControlled(target)) {
    flushWork(true);
    restoreControlled(target);
  } else if (queue.length) flushSoon(true);
}

/** Whether `f` is a form field whose value or checked state comes from its props. */
function isControlled(f: Fiber): boolean {
  const t = f.t;
  return (
    f.n === HOST && (t === "input" || t === "textarea" || t === "select") && (f.p.value != null || f.p.checked != null)
  );
}

/**
 * The listener for a non-bubbling event on its own element: call that element's handler only,
 * as React does for these events. One shared function, so adding it allocates nothing.
 */
function direct(this: Any, e: Any): void {
  const f: Fiber | undefined = this[FIBER];
  const name = PROP_OF.get(e.type);
  if (f === undefined || name === undefined || f.f & DEAD) return;
  const fn = f.p[name];
  if (typeof fn !== "function") return;
  batch++;
  try {
    const syn = synthetic(e, name);
    syn.currentTarget = this;
    fn(syn);
  } finally {
    if (--batch === 0) afterEvent(undefined);
  }
}

// #endregion

// #region Synthetic events

// A synthetic event: React's methods and fields over the native event. The
// native event's fields are read only when a handler reads them, through
// accessors on a prototype made once per event class: reading them all up
// front would read layout-dependent ones (offsetX, layerX), which forces a
// synchronous layout on every click. Native methods come bound to the event.
const SYN_BASE: Any = {
  preventDefault(this: Any): void {
    this.nativeEvent.preventDefault();
    this.defaultPrevented = true;
  },
  stopPropagation(this: Any): void {
    this.nativeEvent.stopPropagation();
    this._stopped = true;
  },
  isDefaultPrevented(this: Any): boolean {
    return this.nativeEvent.defaultPrevented;
  },
  isPropagationStopped(this: Any): boolean {
    return this._stopped;
  },
  // Events are not pooled, as in React 17 and later: persist() has nothing to do.
  persist: noop,
  isPersistent: (): boolean => true,
};
// Native event class (MouseEvent, KeyboardEvent, ...) -> its synthetic prototype.
const synProtos = new Map<Any, Any>();

/** The synthetic prototype for native event `e`'s class, built on first use. */
function synProto(e: Any): Any {
  let p = synProtos.get(e.constructor);
  if (p !== undefined) return p;
  p = Object.create(SYN_BASE);
  for (const k in e) {
    // Fields every synthetic event sets are its own, not accessors: setting
    // through an accessor would redefine them on each event (a slow path).
    if (k in SYN_BASE || k === "currentTarget" || k === "type") continue;
    Object.defineProperty(p, k, {
      configurable: true,
      enumerable: true,
      get(this: Any): Any {
        const v = this.nativeEvent[k];
        return typeof v === "function" ? v.bind(this.nativeEvent) : v;
      },
      // A handler or the runtime may set a field: it becomes the event's own.
      set(this: Any, v: Any): void {
        Object.defineProperty(this, k, { value: v, writable: true, configurable: true, enumerable: true });
      },
    });
  }
  synProtos.set(e.constructor, p);
  return p;
}

/** A synthetic event over `e` for prop `name`. Its own fields are set in one fixed order. */
function synthetic(e: Any, name: string): Any {
  const s = Object.create(synProto(e));
  s.nativeEvent = e;
  s.currentTarget = null;
  s._stopped = false;
  s.type = SYN_TYPE[name] ?? e.type;
  return s;
}

// #endregion

// #region Controlled fields and form actions

// After an event: a controlled field shows its props again if the handler did not take the change.
function restoreControlled(f: Fiber): void {
  if (f.n !== HOST || f.f & DEAD) return;
  const t = f.t;
  if (t !== "input" && t !== "textarea" && t !== "select") return;
  const dom = f.d,
    p = f.p;
  if (t === "select") return setSelect(dom, p, false);
  if (p.value != null && dom.value !== toStr(p.value)) dom.value = toStr(p.value);
  if (p.checked != null) {
    dom.checked = !!p.checked;
    // Clicking a radio unchecks the others in its group natively; controlled ones in the same
    // form (or document) get their own checked prop back, as React restores them.
    if (dom.type === "radio" && dom.name) {
      const group = (dom.form ?? dom.ownerDocument).querySelectorAll(
        `input[type=radio][name="${CSS.escape(dom.name)}"]`,
      );
      for (const r of group) {
        const rf: Fiber | undefined = r[FIBER];
        if (rf !== undefined && rf !== f && rf.p.checked != null) r.checked = !!rf.p.checked;
      }
    }
  }
}

/**
 * After a submit event's handlers: run the form's function action (or the submit button's
 * formAction, which wins, as in React) with the form's data, instead of navigating.
 */
function submitAction(e: Any, target: Fiber): void {
  const form: Fiber | undefined = e.target[FIBER];
  if (form === undefined || form.t !== "form") return;
  let action = form.p.action;
  const sub = e.submitter;
  const sf: Fiber | undefined = sub != null ? sub[FIBER] : undefined;
  if (sf !== undefined && typeof sf.p.formAction === "function") action = sf.p.formAction;
  // A form of another root is that root's to handle when its own listener sees the event.
  if (typeof action !== "function" || target.o !== form.o) return;
  e.preventDefault();
  // The submitter goes to FormData, so its name and value are in the data, as a native submit
  // would send them.
  runFormAction(form, action, new FormData(e.target, sub ?? undefined));
}

// #endregion

// #endregion

// #region Resource hints (react-dom)

/**
 * Add `<link rel={rel} href={href}>` to <head> once per rel and href, with the options React's
 * resource APIs take. Does nothing without a document (a server import).
 */
function hint(rel: string, href: string, opts: Any = {}): void {
  if (typeof document === "undefined" || !href) return;
  const sel = `link[rel="${rel}"][href="${CSS.escape(href)}"]`;
  // Deduplicated, as React's are: calling these during every render is the normal use.
  if (document.head.querySelector(sel)) return;
  const l = document.createElement("link");
  l.rel = rel;
  l.href = href;
  if (opts.as) l.setAttribute("as", opts.as);
  if (opts.crossOrigin != null) l.crossOrigin = opts.crossOrigin === "use-credentials" ? "use-credentials" : "";
  if (opts.type) l.type = opts.type;
  if (opts.fetchPriority) l.setAttribute("fetchpriority", opts.fetchPriority);
  document.head.appendChild(l);
}

/** Adds `<link rel="preconnect">`. */
export function preconnect(href: string, opts?: Any): void {
  hint("preconnect", href, opts);
}
/** Adds `<link rel="dns-prefetch">`. */
export function prefetchDNS(href: string): void {
  hint("dns-prefetch", href);
}
/** Adds `<link rel="preload">`. */
export function preload(href: string, opts?: Any): void {
  hint("preload", href, opts);
}
/** Adds `<link rel="modulepreload">`. */
export function preloadModule(href: string, opts?: Any): void {
  hint("modulepreload", href, opts);
}
/** Loads a stylesheet or script now (`opts.as`), once per URL. Stylesheet precedence is not ordered. */
export function preinit(href: string, opts: Any = {}): void {
  if (opts.as === "script") {
    if (document.querySelector(`script[src="${CSS.escape(href)}"]`)) return;
    const s = document.createElement("script");
    s.src = href;
    s.async = true;
    document.head.appendChild(s);
  } else hint("stylesheet", href, opts);
}
/** Loads a module script now, once per URL. */
export function preinitModule(href: string): void {
  if (document.querySelector(`script[src="${CSS.escape(href)}"]`)) return;
  const s = document.createElement("script");
  s.type = "module";
  s.src = href;
  document.head.appendChild(s);
}

// #endregion

// #region Default export

// The default export serves `import React from "react"` and `import ReactDOM from "react-dom"`:
// one object with both packages' APIs, since one module stands in for both.

/**
 * Internals some libraries probe for; only the dispatcher's hooks are real. `H.useMemoCache`
 * serves code that reaches the compiler's cache hook through the dispatcher.
 */
export const __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Any = {
  H: { useMemoCache: c },
  A: null,
  T: null,
  S: null,
};

const React: Record<string, unknown> = {
  version,
  Fragment,
  StrictMode,
  Profiler,
  Suspense,
  SuspenseList,
  Activity,
  ViewTransition,
  addTransitionType,
  Children,
  Component,
  PureComponent,
  createElement,
  cloneElement,
  isValidElement,
  createRef,
  createContext,
  memo,
  forwardRef,
  lazy,
  use,
  useState,
  useReducer,
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useRef,
  useMemo,
  useCallback,
  useContext,
  useImperativeHandle,
  useDebugValue,
  useId,
  useSyncExternalStore,
  useTransition,
  useDeferredValue,
  useOptimistic,
  useActionState,
  useEffectEvent,
  startTransition,
  cache,
  cacheSignal,
  captureOwnerStack,
  unstable_useCacheRefresh,
  act,
  __COMPILER_RUNTIME,
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  // react-dom and react-dom/client
  createRoot,
  hydrateRoot,
  createPortal,
  flushSync,
  unstable_batchedUpdates,
  useFormStatus,
  useFormState: useActionState,
  requestFormReset,
  preconnect,
  prefetchDNS,
  preload,
  preloadModule,
  preinit,
  preinitModule,
};
export default React;

// #endregion
