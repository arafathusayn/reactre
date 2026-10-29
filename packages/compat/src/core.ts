// @reactre/compat/core: the React 19 client API on @reactre/dom, without class components.
// @reactre/compat (./index.ts) is this module with class support installed.
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
//      whichever comes first). Updates batch automatically. Those from an event handler or
//      inside flushSync flush before the handler returns; those from a discrete event's native
//      listener (a click, a key) in a microtask; any other (timers, promises, continuous events
//      such as mouseover) in a task of their own, as React's lanes order them.
//   5. Blocks: @reactre/compat/compiler turns JSX trees of host elements into templates. A block
//      clones a prebuilt prototype and on update writes only the holes whose values changed. A
//      component whose whole render is one block hosts it itself, so a list row costs one fiber.
//   6. Hot paths are written for the JavaScript engine: small objects with one shape and short
//      field names, loops split into small functions the engine optimizes early, and no
//      allocation per row where it can be avoided. Comments at each such spot say which.
//
// What differs from React: rendering is synchronous (no time slicing, so a transition renders at
// once and a suspended update shows its boundary's fallback, with the old content kept hidden
// and its state intact). The server renderer is @reactre/compat/server; the hooks here serve it
// too (see "Server rendering" in the hooks region).
//
// The file reads top down, in folding regions: elements, children utilities, fibers, child
// reconciliation, DOM placement, host elements, compiled blocks, hydration, roots and portals,
// components, unmounting, scheduling, effects, hooks, events, resource hints and the default
// export.

import { lis } from "@reactre/dom";

/** The React version this module implements, as libraries read it. */
export const version: string = "19.3.1";

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
// The fragment type as the runtime itself uses it: only the app's use of the `Fragment` export
// below keeps that export, and with it Fragment refs, in a bundle.
const FRAGMENT = Symbol.for("react.fragment");

/** Fragment refs (see FragmentInstance), once the `Fragment` export installed them. */
let fragmentRefs: FragmentRefs | null = null;
/**
 * `<>...</>`: children with no element of their own. It brings Fragment refs: an app that never
 * imports Fragment renders no `<Fragment ref>`, so its bundle leaves their code out.
 */
export const Fragment: symbol = /* @__PURE__ */ (() => {
  fragmentRefs = { of: fragmentOf, hosts: fragmentHosts };
  return FRAGMENT;
})();
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
  // React's isomorphic package keeps this message in full, even in production.
  if (el == null) throw new Error("The argument must be a React element, but you passed " + el + ".");
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

/** Whether `o` is a React element. One made by React 18 or older (`react.element`) is not. */
export function isValidElement(o: unknown): o is ReactElement {
  return typeof o === "object" && o !== null && (o as Any).$$typeof === ELEMENT;
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
  checkContainer(container);
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
  // A lazy type is read through its loader and a thenable as use() reads it (so one that has
  // not settled throws itself), as React's Children read them. Anything else that is an object
  // throws React's error, in full, even in production; a function or a symbol is passed over.
  if (items === null) {
    if (t === "object") {
      if (children.$$typeof === LAZY_TYPE)
        return mapInto(children._init(children._payload), out, prefix, name, fn, count);
      if (typeof children.then === "function") return mapInto(readThenable(children), out, prefix, name, fn, count);
      throw new Error(
        "Objects are not valid as a React child (found: " +
          found(children, String(children)) +
          "). If you meant to render a collection of children, use an array instead.",
      );
    }
    return;
  }
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
const HOOKS = 128; // function: a finished render called hooks, so a render must call as many (see hooksCalled)
const HIDDEN = 256; // suspense, activity: content hidden
const CLAIMED = 512; // host: claimed from server HTML while hydrating
const HOIST = 1024; // host: <title>, <meta> or <link> placed in document.head
// Places one DOM node of its own, f.d: host, text and block fibers, and a
// function component that hosts the block it renders (see runFunc).
const BOX = 2048;
const LATER = 4096; // queued only from outside an event (React's default lane): flushSync leaves it
// A Fragment ref's instance is near (see FragmentInstance): a host-level fiber's node has
// fragment listeners and observers; hosts created under any other look for instances above.
const FRAGREF = 8192;
// Function: a later pass of a render (state set while it rendered) with no finished render's hooks
// to match, so a hook the pass adds is an error (see again); FIRST: and it is the fiber's first.
const PASS = 16384;
const FIRST = 32768;

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
   * suspense primary; activity's inner fragment; a slot's anchor text node; a Fragment's
   * FragmentInstance, once its ref attached.
   */
  s: Any = null;
  /** Memo compare; class update queue; suspense fallback; form status subscribers. */
  q: Any = null;
  /** Pending effects of a function's render; a value thrown to this boundary. */
  x: Any = null;
  /** Callback ref cleanup (a host's or a Fragment's). */
  rx: Any = null;
  /** Host: its text content when it holds only text, else null. */
  tx: string | null = null;
  /** Namespace (HTML_NS, SVG_NS or MATH_NS) of a host, block, root, portal or slot. */
  ns = HTML_NS;
  /**
   * Hydration cursor holder: while hydrating, the next server-rendered child node this host
   * (or root) has yet to claim; null when there is nothing to claim. A dehydrated Suspense
   * boundary or Activity keeps its Dehydrated state here.
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
// Claiming server-rendered nodes instead of creating them: then what hydration does (HYDRATION,
// which hydrateRoot hands its root, so apps that never hydrate leave it out), else false.
let hydrating: Hydration | false = false;

/** Whether `v` is a promise or any object with a `then` method, as React tests for one. */
const isThenable = (v: Any): boolean => v !== null && typeof v === "object" && typeof v.then === "function";

/** The fiber kind for an element type; throws React's error for a type that is not one. */
function kindOf(type: Any): number {
  if (typeof type === "string") return HOST;
  if (typeof type === "function") return type.prototype && type.prototype.isReactComponent ? CLASS : FUNC;
  if (type === FRAGMENT || type === StrictMode || type === Profiler || type === SuspenseList || type === ViewTransition)
    return FRAG;
  if (type === Suspense) return SUSPENSE;
  if (type === Activity) return ACTIVITY;
  if (type != null) {
    switch (type.$$typeof) {
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
  throw new Error(prodMessage(130, type === null ? "null" : typeof type, ""));
}

// #region Errors

/**
 * The message of React's production error `code`, as React's client builds it
 * (formatProdErrorMessage): a link to react.dev/errors carrying each argument, which that page
 * fills into the full message. (Where React's production client throws a full message, as
 * Children does, compat throws the same text without this.) During a server render the message
 * is the full one, as React's server builds for Node, Deno, Bun and edge runtimes throw it
 * (ServerHooks.message). Only code that throws or reports an error calls this. Each site makes
 * its own Error, so the error's stack starts where it is thrown, as React's does.
 */
function prodMessage(code: number, ...args: Any[]): string {
  if (server !== null) return server.message(code, args);
  let url = "https://react.dev/errors/" + code;
  for (let i = 0; i < args.length; i++) url += (i > 0 ? "&" : "?") + "args[]=" + encodeURIComponent(args[i]);
  return (
    "Minified React error #" +
    code +
    "; visit " +
    url +
    " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
  );
}

/** React's isValidContainer: a root or portal renders into an element, a document or a fragment. */
function checkContainer(c: Any): void {
  if (!c || (c.nodeType !== 1 && c.nodeType !== 9 && c.nodeType !== 11)) throw new Error(prodMessage(299));
}

/** What React's error for an object rendered as a child names: a plain object's keys, else `tag`. */
const found = (x: Any, tag: string): string =>
  tag === "[object Object]" ? "object with keys {" + Object.keys(x).join(", ") + "}" : tag;

// #endregion

// A server component reference, which React gives no name.
const CLIENT_REFERENCE = Symbol.for("react.client.reference");

/** A component type's name, as React's getComponentNameFromType gives it. */
function nameOfType(type: Any): string | null {
  if (type == null) return null;
  if (typeof type === "function")
    return type.$$typeof === CLIENT_REFERENCE ? null : type.displayName || type.name || null;
  if (typeof type === "string") return type;
  switch (type) {
    case FRAGMENT:
      return "Fragment";
    case Profiler:
      return "Profiler";
    case StrictMode:
      return "StrictMode";
    case Suspense:
      return "Suspense";
    case SuspenseList:
      return "SuspenseList";
    case Activity:
      return "Activity";
    case ViewTransition:
      return "ViewTransition";
  }
  if (typeof type === "object")
    switch (type.$$typeof) {
      case PORTAL_TYPE:
        return "Portal";
      case CONTEXT_TYPE:
        return type.displayName || "Context";
      case CONSUMER_TYPE:
        return (type._context.displayName || "Context") + ".Consumer";
      case FORWARD_TYPE: {
        if (type.displayName) return type.displayName;
        const inner = type.render.displayName || type.render.name || "";
        return inner !== "" ? "ForwardRef(" + inner + ")" : "ForwardRef";
      }
      case MEMO_TYPE:
        return type.displayName || nameOfType(type.type) || "Memo";
      case LAZY_TYPE:
        try {
          return nameOfType(type._init(type._payload));
        } catch {
          return null;
        }
    }
  return null;
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
 * of React's public API; exported for libraries and for the class runtime in ./index.ts (PureComponent).
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
      childThrew(p, e);
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
    } else if (oi <= oe) {
      // The general case: old children of the middle by key, reused where the key and type
      // match; what is left in the map afterwards is unmounted.
      const map = keyMap(old, oi, oe);
      // Fewer keys than children: a key repeats. React's own algorithm takes the rest, when the
      // keys feature installed it (see __installKeys).
      if (map.size <= oe - oi && dupList) return dupList(p, items, old, i, oi, nc);
      moved = middle(p, items, i, ne, map, nc);
      if (map.size) {
        if (map.size === m) {
          // Nothing old survived (a full replacement): one native clear
          // beats a removal per node. New nodes are placed after this.
          removeAll(p, old);
          if (nc.length === 0) return;
        } else for (const o of map.values()) unmount(o, true);
      }
    } else if (i <= ne)
      // Only new children in the middle (an insertion, or a mount), created in order. A hydrating
      // mount also records where each one sits, for useId's tree ids.
      moved = hydrating ? hydrating.fork(p, items, children, i, ne, nc) : middle(p, items, i, ne, null, nc);
    patchRun(items, ne + 1, n - 1, old, tail, nc);
  } catch (e) {
    // Keep every live fiber tracked, so the boundary that catches this can
    // retry (suspense) or unmount (errors) the whole subtree.
    childThrew(p, e);
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

// While hydrating, the arrays whose children are mounting, innermost last: for each, the fiber
// whose children they are, their length (holes included) and the index of the child mounting
// now. useId reads them for React's tree ids (see treeId).
const forks: Any[] = [];

// The middle of a hydrating mount, items[i..ne]: created in order as middle() would, with each
// child's place recorded in `forks` while it mounts. A single child (not an array or iterable)
// takes no place: React gives tree ids only to the children of arrays.
function forkRun(p: Fiber, items: Any[], children: Any, i: number, ne: number, nc: Fiber[]): boolean {
  const at = forks.length,
    forked = items[0] !== children;
  if (forked) forks.push(p, items.length, 0);
  try {
    for (; i <= ne; i++) {
      let it = items[i];
      if (it == null || typeof it === "boolean") continue;
      if (typeof it === "object" && it.$$typeof !== ELEMENT && isThenable(it)) it = items[i] = unwrap(it);
      if (forked) forks[at + 2] = i;
      const o = create(it, p, keyOf(it, i));
      o.i = nc.length;
      nc.push(o);
    }
  } finally {
    forks.length = at;
  }
  return true;
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

// React's handling of repeated keys (dupKeys), once the default entry installed it.
let dupList: typeof dupKeys | null = null;

/**
 * The rest of a list whose old children repeat a key, from items[i] and old[oi] on, as React's
 * production build reconciles it (its development build warns about the keys). Children are
 * matched as React matches them: in place while the keys match (another type replaces the child
 * there), then through a map of the old children left, by key, where the last child with a key
 * hides the earlier ones. A hidden child is neither reused nor unmounted: its nodes stay where
 * they are, outside the list, and it never renders again. Then the nodes move as React's commit
 * moves them: children whose old order holds stay, and each new or moved one goes before the
 * next child that stayed, or else before what follows the list.
 */
function dupKeys(p: Fiber, items: Any[], old: Fiber[], i: number, oi: number, nc: Fiber[]): void {
  p.c = nc;
  const n = items.length,
    m = old.length,
    placed = new Set<Fiber>();
  // React's lastPlacedIndex: the old index of the last child that kept its place.
  let last = oi > 0 ? old[oi - 1]!.i : -1,
    it: Any,
    // What follows the list: the host's next node of its own after the old children's (React's
    // host sibling), null for the end, undefined while no old child has a node.
    end: Any;
  for (let j = m - 1; end === undefined && j >= 0; j--) {
    const xs: Any[] = [];
    collect(old[j]!, xs);
    if (xs.length) end = next(xs[xs.length - 1].nextSibling, curHost);
  }
  const put = (o: Fiber | undefined, key: Key): void => {
    if (o !== undefined && sameType(o, it)) {
      if (o.i < last) placed.add(o);
      else last = o.i;
      take(o, it, nc);
    } else {
      const f = create(it, p, key);
      f.i = nc.length;
      nc.push(f);
      placed.add(f);
    }
  };
  // In place, while the keys match: a child of another type is replaced where it is.
  for (; i < n && oi < m; i++, oi++) {
    it = items[i];
    if (typeof it === "object" && it !== null && it.$$typeof !== ELEMENT && isThenable(it)) it = items[i] = unwrap(it);
    const o = old[oi]!;
    if (it == null || typeof it === "boolean" || o.k !== keyOf(it, i)) break;
    if (!sameType(o, it)) unmount(o, true);
    put(o, o.k);
  }
  if (oi < m && i < n) {
    const map = keyMap(old, oi, m - 1);
    for (; oi < m; oi++) {
      const o = old[oi]!;
      if (map.get(o.k) !== o) {
        // Hidden by a later child with its key: left in the DOM as it is, not ours to place.
        o.f |= DEAD;
        const xs: Any[] = [];
        collect(o, xs);
        for (const x of xs) x[OWN] = null;
      }
    }
    for (; i < n; i++) {
      it = items[i];
      if (it == null || typeof it === "boolean") continue;
      if (typeof it === "object" && it.$$typeof !== ELEMENT && isThenable(it)) it = items[i] = unwrap(it);
      const key = keyOf(it, i),
        o = map.get(key);
      if (o !== undefined && sameType(o, it)) map.delete(key);
      put(o, key);
    }
    for (const o of map.values()) unmount(o, true);
  } else {
    // One side ran out: the old children left go, the new ones are created.
    for (; oi < m; oi++) unmount(old[oi]!, true);
    for (; i < n; i++) {
      it = items[i];
      if (it == null || typeof it === "boolean") continue;
      if (typeof it === "object" && it.$$typeof !== ELEMENT && isThenable(it)) it = items[i] = unwrap(it);
      put(undefined, keyOf(it, i));
    }
  }
  const h = curHost,
    parent = h.d as Node;
  // With no old node to go by, the host places the new ones.
  if (end === undefined) {
    h.f |= STRUCT;
    return;
  }
  let ref: Node | null = end ?? (h.n === SLOT && h.s.parentNode !== null ? h.s : null);
  for (let j = nc.length - 1; j >= 0; j--) {
    const f = nc[j]!,
      xs: Node[] = [];
    collect(f, xs);
    if (placed.has(f))
      for (const x of xs)
        if (x.parentNode === parent) move(parent, x, ref);
        else parent.insertBefore(x, ref);
    if (xs.length) ref = xs[0]!;
  }
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
        // hooks, no slots, no Fragment ref's listeners) is only marked: no call per row.
        if (o.n === FUNC && o.h === null && o.c === NO_FIBERS && (o.f & (BOX | FRAGREF)) === BOX) o.f |= DEAD;
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
    f.d = (hydrating && hydrating.text(f)) || document.createTextNode(f.p);
    f.d[OWN] = curHost;
    if (curHost.f & FRAGREF) fragmentRefs!.hosts(f, true);
    return f;
  }
  // Elements first: a list mount creates one per row.
  const tt = it.$$typeof;
  if (tt === ELEMENT) {
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
  } else
    throw new Error(
      tt === LEGACY_ELEMENT ? prodMessage(525) : prodMessage(31, found(it, Object.prototype.toString.call(it))),
    );
  try {
    if (f.n === FRAG && f.t === ARRAY) reconcile(f, Array.isArray(it) ? it : (f.p = Array.from(it as Iterable<Any>)));
    else if (f.n === PORTAL) runPortal(f, true);
    else update(f, it, true);
  } catch (e) {
    // A child that fails to mount is dropped: nothing of it is committed. While hydrating, the
    // server's nodes it claimed stay, for the content to hydrate again or render on the client.
    renderThrew(f, e);
    dropFailed(f);
    throw e;
  }
  // A new node under a Fragment ref gets its instance's listeners and observers.
  if (curHost.f & FRAGREF) fragmentRefs!.hosts(f, true);
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
    case FRAG: {
      if (f.t === ARRAY) return reconcile(f, f.p);
      // A Fragment's ref (React 19.3) changes before its children render: React detaches it
      // before theirs and attaches it before their refs and layout effects.
      const ref = f.p.ref,
        oref = old === null ? undefined : old["ref"];
      if (ref !== oref && f.t === FRAGMENT) swapRef(f, ref, oref);
      return reconcile(f, f.p.children);
    }
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
    case CONSUMER:
      // As React's: the children are called whatever they are.
      return reconcile(f, f.p.children(readContext(f, f.t._context)));
    case SUSPENSE:
      return runSuspense(f);
    case ACTIVITY:
      return runActivity(f);
    case LAZY: {
      // Throws the load's promise until it resolves; the nearest Suspense catches it. As React's,
      // what it loads must be a function, forwardRef, memo or context.
      const type = f.t._init(f.t._payload),
        tt = type?.$$typeof;
      if (typeof type !== "function" && tt !== FORWARD_TYPE && tt !== MEMO_TYPE && tt !== CONTEXT_TYPE)
        throw new Error(prodMessage(306, nameOfType(type) || type, ""));
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
  // Child nodes placed in a void element (one that mounts with them throws in runHost first).
  if (VOID.has(h.t)) throw new Error(prodMessage(137, h.t));
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
 * Render a host element: create its DOM element on mount (or hand a claimed server element to
 * hydration, which renders it), set changed props, render its children with it as the current
 * host, place them if they changed, then queue its ref.
 */
function runHost(f: Fiber, old: Props | null, mount: boolean): void {
  const p = f.p;
  let dom = f.d;
  if (mount) {
    const type: string = f.t;
    f.ns = type === "svg" ? SVG_NS : type === "math" ? MATH_NS : curNs;
    dom = hydrating ? hydrating.element(f, type) : null;
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
    } else return (hydrating as Hydration).host(f, dom, p);
    f.d = dom;
    dom[FIBER] = f;
    // React's void elements take no children (#137): looked up only for an element given some.
    // One that gets them on an update is caught where they change (hostChildren, place).
    if (p.children != null && VOID.has(type)) throw new Error(prodMessage(137, type));
    if (hoistable(f, p)) {
      // React 19 document metadata: rendered anywhere, placed in <head>. A <title> goes before
      // the first one there, as in React, so the newest sets the document's title.
      f.f |= HOIST;
      dom[OWN] = null;
      const head = document.head;
      let at: ChildNode | null = null;
      if (type === "title") for (at = head.firstChild; at !== null && at.nodeName !== "TITLE";) at = at.nextSibling;
      head.insertBefore(dom, at);
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
  if (f.f & STRUCT) place(f);
  // After the children: the options must exist before the value can select one.
  if (f.t === "select") setSelect(dom, p, old ?? NO_PROPS, mount);
  // Refs attach with layout effects (after the whole render), detach at once.
  const ref = p.ref,
    oref = old === null ? undefined : old["ref"];
  if (ref !== oref) swapRef(f, ref, oref);
  if (mount && p.autoFocus && AUTO_FOCUS.has(f.t)) laterShown(f, () => dom.focus());
}

// The elements React's client gives no children (#137), as its setInitialProperties lists them.
const VOID = new Set("area base br col embed hr img input keygen link meta param source track wbr menuitem".split(" "));

// The elements React focuses when they mount with autoFocus (commitMount).
const AUTO_FOCUS = new Set(["button", "input", "select", "textarea"]);

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
    // Checked as React's setProp checks it, when it changes; not on a claimed element, as
    // React's hydration checks nothing.
    if ((old === null || html !== old["dangerouslySetInnerHTML"]) && !(f.f & CLAIMED)) checkHTML(f.t, html, p.children);
    const s = html.__html;
    // With __html null or undefined there is no HTML: the children render.
    if (s != null) {
      if (f.c.length) removeAll(f);
      if (old === null || old["dangerouslySetInnerHTML"]?.__html !== s || f.tx !== null) {
        // A claimed element keeps the server's HTML, as React's production client keeps it.
        if (!(f.f & CLAIMED)) dom.innerHTML = s;
      }
      f.tx = null;
      return;
    }
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
    } else if (f.tx !== s || (old !== null && old["dangerouslySetInnerHTML"]?.__html != null)) {
      // Text in a void element mounted without it.
      if (f.tx === null && old !== null && VOID.has(f.t)) throw new Error(prodMessage(137, f.t));
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
  if (f.tx !== null || (old !== null && old["dangerouslySetInnerHTML"]?.__html != null)) {
    if (!hydrating) dom.textContent = "";
    f.tx = null;
  }
  // React renders a noscript's children only as text: with scripting on, the browser reads its
  // content as text anyway, so element children (a fallback <style>, say) are left out.
  if (f.t === "noscript") return;
  reconcile(f, ch);
}

/**
 * React's errors for dangerouslySetInnerHTML: on a textarea (#91) or a void element (#137), not
 * in the form {__html} (#61), or with HTML and children both (#60).
 */
function checkHTML(tag: string, html: Any, children: Any): void {
  if (tag === "textarea") throw new Error(prodMessage(91));
  if (VOID.has(tag)) throw new Error(prodMessage(137, tag));
  if (typeof html !== "object" || !("__html" in html)) throw new Error(prodMessage(61));
  if (html.__html != null && children != null) throw new Error(prodMessage(60));
}

// #endregion

// #region Prop tables and setProps

// Props that are present or absent: a truthy value (not a function or symbol) sets "", anything
// else removes the attribute. React's list, by prop name.
const BOOL_ATTRS = new Set(
  (
    "inert allowFullScreen async autoPlay controls credentialless default defer disabled " +
    "disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open " +
    "playsInline readOnly required reversed scoped seamless itemScope"
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
  "innerText",
  "textContent",
]);
// The `action` React writes for a function action: submitting the form any way but through
// the submit event throws this error instead of navigating. The message is React's.
const ACTION_URL =
  "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')";
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
// Style properties that take plain numbers: React's list.
const UNITLESS = new Set(
  (
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex " +
    "boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative " +
    "flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan " +
    "gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom " +
    "fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity " +
    "strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp " +
    "msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive " +
    "msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount " +
    "WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex " +
    "WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp"
  ).split(" "),
);
// React's test for a javascript: URL, which it replaces with one that throws (sanitizeURL).
const JS_URL =
  /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
const BLOCKED_URL = "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')";
const sanitize = (v: Any): string => (JS_URL.test("" + v) ? BLOCKED_URL : "" + v);

/**
 * Write the difference between old props `o` and new props `p` to `dom`: removed props first,
 * then changed ones, then the form-field values React sets last.
 */
function setProps(f: Fiber, dom: Any, o: Props, p: Any, mount: boolean): void {
  const tag: string = f.t;
  // Inputs take type, value, checked and name after their other attributes, in
  // that order, as React sets them; textareas and selects take their value; a new image takes
  // srcSet and src, so the attributes that shape its request (sizes, loading) come first.
  const skip =
    tag === "input"
      ? INPUT_LAST
      : tag === "textarea" || tag === "select"
        ? VALUE_LAST
        : tag === "img" && mount
          ? SRC_LAST
          : null;
  for (const k in o) {
    if (!(k in p) && !RESERVED.has(k) && (skip === null || !skip.has(k))) setAttr(f, dom, k, undefined, o[k]);
  }
  for (const k in p) {
    const v = p[k];
    if (v === o[k] || RESERVED.has(k) || (skip !== null && skip.has(k))) continue;
    setAttr(f, dom, k, v, o[k]);
  }
  if (skip === SRC_LAST) {
    if (p.srcSet != null) setAttr(f, dom, "srcSet", p.srcSet, undefined);
    if (p.src != null) setAttr(f, dom, "src", p.src, undefined);
  }
  if (tag === "input") setInput(dom, p, o, mount);
  // Tracked after the initial value is written, so the tracker starts from it.
  if (mount && (tag === "input" || tag === "textarea")) track(dom);
  if (tag === "textarea") {
    // React's initTextarea and updateTextarea: a controlled textarea also keeps defaultValue in
    // step (unless one is given), so a form reset returns to the last rendered value.
    const v = p.value,
      dv = p.defaultValue;
    if (mount) {
      // React's initTextarea: the initial text may be children too (a one-item array included),
      // but not with a defaultValue (#92) or as several (#93). (Raw HTML is #91, in hostChildren.)
      let d = v ?? dv;
      const ch = p.children;
      if (v == null && ch != null) {
        if (dv != null) throw new Error(prodMessage(92));
        if (Array.isArray(ch) && ch.length > 1) throw new Error(prodMessage(93));
        d = (Array.isArray(ch) ? ch[0] : ch) ?? "";
      }
      if (d != null) dom.defaultValue = toStr(d);
    } else {
      if (v != null) {
        const s = toStr(v);
        if (dom.value !== s) dom.value = s;
        if (dv == null) {
          if (dom.defaultValue !== s) dom.defaultValue = s;
          return;
        }
      }
      dom.defaultValue = dv != null ? toStr(dv) : "";
    }
  }
}

// #endregion

// #region Form fields

// Props of form fields that setProps leaves to setInput and the textarea and select code.
const INPUT_LAST = new Set(["type", "value", "checked", "name"]);
const VALUE_LAST = new Set(["value"]);
const SRC_LAST = new Set(["srcSet", "src"]);
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

/** A field value as React's getToStringValue gives it: functions and symbols become "". */
const toStr = (v: Any): string => (typeof v === "function" || typeof v === "symbol" ? "" : "" + v);

/**
 * A select's selection by React's rules (ReactDOMSelect): the value selects its options (an array
 * for `multiple`); on mount a defaultValue does, setting their defaultSelected too, and so does a
 * change of `multiple` with no value (or the selection is cleared). `o` is null when only the
 * value is restored after an event.
 */
function setSelect(dom: Any, p: Any, o: Props | null, mount: boolean): void {
  const multiple = !!p.multiple;
  if (p.value != null) return selectOptions(dom, multiple, p.value, false);
  if (o === null || (!mount && multiple === !!o["multiple"])) return;
  if (p.defaultValue != null) selectOptions(dom, multiple, p.defaultValue, true);
  else if (!mount) selectOptions(dom, multiple, multiple ? [] : "", false);
}

/** React's updateOptions. With no match, a single select falls back to its first enabled option. */
function selectOptions(dom: Any, multiple: boolean, v: Any, setDefault: boolean): void {
  const opts = dom.options;
  if (multiple) {
    const want = new Set<string>();
    for (let i = 0; i < v.length; i++) want.add("" + v[i]);
    for (let i = 0; i < opts.length; i++) {
      const sel = want.has(opts[i].value);
      if (opts[i].selected !== sel) opts[i].selected = sel;
      if (sel && setDefault) opts[i].defaultSelected = true;
    }
    return;
  }
  const s = toStr(v);
  let first = null;
  for (let i = 0; i < opts.length; i++) {
    if (opts[i].value === s) {
      opts[i].selected = true;
      if (setDefault) opts[i].defaultSelected = true;
      return;
    }
    if (first === null && !opts[i].disabled) first = opts[i];
  }
  if (first !== null) first.selected = true;
}

// #endregion

// #region Attributes and styles

/**
 * Set one prop on an element by React's rules (setProp and setPropOnCustomElement): event props
 * register listeners, `style` goes to setStyle, custom elements get properties, and everything
 * else becomes an attribute (aliased, namespaced, booleans and nulls handled). `f` only needs
 * `ns` and `t`, so blocks pass a small info object in its place.
 */
function setAttr(f: Fiber, dom: Any, name: string, v: Any, old: Any): void {
  const tag: string = f.t;
  // "on" in any case, by char codes: this runs for every prop of every element, and the test
  // allocates nothing. React never writes such a prop as an attribute of a built-in element.
  if (name.length > 2 && (name.charCodeAt(0) | 32) === 111 && (name.charCodeAt(1) | 32) === 110) {
    const custom = isCustom(tag);
    if (!custom || REACT_EVENTS.has(name)) {
      // onX: events read the fiber's props when they fire; only listening is set up here.
      if (v != null && name.charCodeAt(0) === 111 && name.charCodeAt(2) < 91) listenFor(dom, name);
      return;
    }
    if (name.charCodeAt(1) === 110 && nativeListener(dom, name, v, old)) return;
  }
  if (name === "style") return setStyle(dom, v, old);
  if (isCustom(tag)) {
    // React 19's custom element rule: any value goes to a property the element defines, so
    // objects, arrays and functions reach it intact; otherwise true is presence.
    if (name in dom) dom[name] = v;
    else if (v === true) dom.setAttribute(name, "");
    else setValue(dom, name, v);
    return;
  }
  switch (name) {
    case "action":
    case "formAction":
      if (typeof v === "function") {
        // Submitting runs the function (see submitAction); the URL React puts here
        // stops a submission that bypasses the submit event.
        ensure("submit", false);
        dom.setAttribute(name.toLowerCase(), ACTION_URL);
        return;
      }
      return setURL(dom, null, name.toLowerCase(), v);
    case "data":
    case "src":
    case "href":
      // Data is a URL only on an <object>.
      if (name === "data" && tag !== "object") break;
      // An empty URL would load the page itself, so it is left out (an <a>'s href excepted).
      if (v === "" && (tag !== "a" || name !== "href")) return dom.removeAttribute(name);
      return setURL(dom, null, name, v);
    case "xlinkHref":
      return setURL(dom, XLINK, "xlink:href", v);
    case "multiple":
    case "muted":
      // Properties only: the attributes set just the initial state.
      dom[name] = truthy(v);
      return;
    case "selected":
      if (tag !== "option") break;
      dom.selected = truthy(v);
      return;
    case "capture":
    case "download":
      if (v === true) dom.setAttribute(name, "");
      else if (v === false || !plainish(v)) dom.removeAttribute(name);
      else dom.setAttribute(name, "" + v);
      return;
    case "cols":
    case "rows":
    case "size":
    case "span":
      if (plainish(v) && !isNaN(v) && v >= 1) dom.setAttribute(name, "" + v);
      else dom.removeAttribute(name);
      return;
    case "rowSpan":
    case "start":
      if (plainish(v) && !isNaN(v)) dom.setAttribute(name, "" + v);
      else dom.removeAttribute(name);
      return;
  }
  if (BOOL_ATTRS.has(name)) {
    if (truthy(v)) dom.setAttribute(name, "");
    else dom.removeAttribute(name);
    return;
  }
  const q = NS_ATTRS[name];
  if (q !== undefined) {
    const ns = q.charCodeAt(1) === 108 ? XLINK : XML; // "xlink:" or "xml:"
    if (!plainish(v) || typeof v === "boolean") removeAttr(dom, ns, q);
    else dom.setAttributeNS(ns, q, "" + v);
    return;
  }
  if (BOOLEANISH.has(name)) {
    if (plainish(v)) dom.setAttribute(name, "" + v);
    else dom.removeAttribute(name);
    return;
  }
  setValue(dom, ALIASES[name] ?? name, v);
}

/**
 * A custom element's own on* prop (React's setPropOnCustomElement): a function is a native
 * listener for the event named after "on", case kept, with a Capture suffix meaning capture.
 * Returns false for any other value, which is then set as a property or attribute.
 */
function nativeListener(dom: Any, name: string, v: Any, old: Any): boolean {
  const capture = name.endsWith("Capture");
  const type = name.slice(2, capture ? -7 : undefined);
  if (typeof old === "function") dom.removeEventListener(type, old, capture);
  if (typeof v !== "function") return false;
  if (typeof old !== "function" && old !== null) {
    if (name in dom) dom[name] = null;
    else if (dom.hasAttribute(name)) dom.removeAttribute(name);
  }
  dom.addEventListener(type, v, capture);
  return true;
}

// React's event props, bubble and capture: on a custom element these stay synthetic, and any
// other on* prop is the element's own (onScrollEnd React listens for itself).
const REACT_EVENTS = new Set<string>();
for (const e of (
  "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd " +
  "dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error " +
  "fullscreenChange fullscreenError gotPointerCapture input invalid keyDown keyPress keyUp load loadedData " +
  "loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play " +
  "playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset " +
  "resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll " +
  "toggle touchMove waiting wheel animationEnd animationIteration animationStart doubleClick focus blur " +
  "transitionRun transitionStart transitionCancel transitionEnd change select beforeInput compositionEnd " +
  "compositionStart compositionUpdate"
).split(" ")) {
  const n = "on" + e[0]!.toUpperCase() + e.slice(1);
  REACT_EVENTS.add(n).add(n + "Capture");
}
for (const n of "onMouseEnter onMouseLeave onPointerEnter onPointerLeave onScrollEnd".split(" ")) REACT_EVENTS.add(n);

/** React's setValueForAttribute: booleans are kept as text only by data- and aria- attributes. */
function setValue(dom: Any, attr: string, v: Any): void {
  if (!plainish(v)) return dom.removeAttribute(attr);
  if (typeof v === "boolean") {
    const pre = attr.slice(0, 5).toLowerCase();
    if (pre !== "data-" && pre !== "aria-") return dom.removeAttribute(attr);
  }
  dom.setAttribute(attr, "" + v);
}

/** A URL attribute: booleans and the rest of what is not text are left out; javascript: blocked. */
function setURL(dom: Any, ns: string | null, attr: string, v: Any): void {
  if (!plainish(v) || typeof v === "boolean") removeAttr(dom, ns, attr);
  else if (ns !== null) dom.setAttributeNS(ns, attr, sanitize(v));
  else dom.setAttribute(attr, sanitize(v));
}

/**
 * Hold a block hole's attribute in the template, so its value later lands in prop order. Props
 * that are properties, not attributes, hold nothing.
 */
function reserveAttr(info: Any, el: Any, name: string): void {
  const tag: string = info.t;
  if (
    isCustom(tag) ||
    name === "multiple" ||
    name === "muted" ||
    name === "style" ||
    (name === "selected" && tag === "option")
  )
    return;
  if (name === "xlinkHref") return el.setAttributeNS(XLINK, "xlink:href", "");
  const q = NS_ATTRS[name];
  if (q !== undefined) el.setAttributeNS(q.charCodeAt(1) === 108 ? XLINK : XML, q, "");
  else el.setAttribute(name === "action" || name === "formAction" ? name.toLowerCase() : (ALIASES[name] ?? name), "");
}

// Not null, undefined, a function or a symbol.
const plainish = (v: Any): boolean => v != null && typeof v !== "function" && typeof v !== "symbol";
// Truthy, and not a function or symbol: how React reads boolean attributes and properties.
const truthy = (v: Any): boolean => !!v && typeof v !== "function" && typeof v !== "symbol";
// Custom elements by React's test: a hyphen in the tag, except SVG and MathML's hyphenated names.
const NOT_CUSTOM = new Set(
  "annotation-xml color-profile font-face font-face-src font-face-uri font-face-format font-face-name missing-glyph".split(
    " ",
  ),
);
const isCustom = (tag: string): boolean => tag.includes("-") && !NOT_CUSTOM.has(tag);
// The xlink and xml props React sets in their namespaces, on any element.
const NS_ATTRS: Record<string, string> = {};
for (const n of "Actuate Arcrole Role Show Title Type".split(" ")) NS_ATTRS["xlink" + n] = "xlink:" + n.toLowerCase();
for (const n of "Base Lang Space".split(" ")) NS_ATTRS["xml" + n] = "xml:" + n.toLowerCase();

/** Remove an attribute; a namespaced one is removed by its local name (after the prefix). */
function removeAttr(dom: Any, ns: string | null, attr: string): void {
  if (ns !== null) dom.removeAttributeNS(ns, attr.slice(attr.indexOf(":") + 1));
  else dom.removeAttribute(attr);
}

/**
 * Apply a style prop, an object, property by property, touching only the properties that changed
 * from `old`. Anything else throws, as React's setValueForStyles does.
 */
function setStyle(dom: Any, v: Any, old: Any): void {
  if (v != null && typeof v !== "object") throw new Error(prodMessage(62));
  const s = dom.style;
  if (old != null && typeof old === "object") for (const k in old) if (v == null || !(k in v)) styleProp(s, k, null);
  if (v != null) for (const k in v) if (old == null || v[k] !== old[k]) styleProp(s, k, v[k]);
}

/**
 * Set one style property, as React's setValueForStyle: numbers get "px" unless the property is
 * unitless or the number is 0, strings are trimmed; custom properties (`--x`, char code 45 is
 * '-') take any value through setProperty.
 */
function styleProp(s: Any, k: string, v: Any): void {
  const custom = k.charCodeAt(0) === 45 && k.charCodeAt(1) === 45;
  if (v == null || typeof v === "boolean" || v === "") {
    if (custom) s.setProperty(k, "");
    else s[k === "float" ? "cssFloat" : k] = "";
  } else if (custom) s.setProperty(k, "" + v);
  else if (typeof v === "number" && v !== 0 && !UNITLESS.has(k)) s[k] = v + "px";
  else if (k === "float") s.cssFloat = v;
  else s[k] = ("" + v).trim();
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
        // In prop order, as React sets them (an image's srcSet and src last, as setProps
        // writes them): a hole's attribute is reserved here, so its value later lands in the
        // same place.
        const keys = Object.keys(props);
        if (tag === "img")
          for (const k of ["srcSet", "src"]) if (k in props) keys.push(keys.splice(keys.indexOf(k), 1)[0]!);
        for (const k of keys) {
          const x = props[k];
          if (!isHole(x)) setAttr(info as Any, el, k, x, undefined);
          else {
            infos[x.h] = info;
            if (/^on[A-Z]/.test(k)) listenFor(el, k);
            // Not style: the browser writes its attribute when it is first
            // serialized, after the others, as React's output has it.
            else reserveAttr(info, el, k);
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
        else if (h) throw badListener(prop, h);
      }
    }
    if (node === f.d) return;
  }
}

// #endregion

// #endregion

// #region Hydration

// Hydration walks the server's nodes alongside a render, as React's client does: each host (and
// the root) keeps a cursor (Fiber.hc) at its next unclaimed child, and a host claimed from the
// server is marked CLAIMED while its children render. A claimed element keeps the server's
// attributes and styles until a prop next changes: only what React's hydrateInstance applies is
// applied (see claimProps). A node that does not match is a mismatch: React's error is queued for
// onRecoverableError and MISMATCH is thrown up to what recovers from it, which renders on the
// client instead.
//
// As in React, the shell hydrates first, in a render of its own (a task, or at once inside
// flushSync), and leaves each Suspense boundary and Activity it meets dehydrated: the server's
// nodes stay where they are, held by placeholder fibers, until a later pass hydrates the boundary
// (see pass), and the boundary recovers on its own from what goes wrong inside it. Boundaries the
// server could not finish render on the client in a pass of their own first; then each pass
// hydrates the boundaries the last one left, nested ones in the next. A discrete event inside a
// dehydrated boundary hydrates it first (see replay), a continuous one waits for its target (see
// keep), and an update that reaches one hydrates it first (see selective). A whole document that renders on the client keeps its <html>, <head> and
// <body>, as React's singletons do (see adopt). All of it is in HYDRATION, which only hydrateRoot
// reaches.

/** What a mismatch throws, up to the boundary or root that recovers from it. */
const MISMATCH = { hydration: "mismatch" };

// The errors hydration found, each with its component stack, until the pass reports them.
let hydrationErrors: Any[] | null = null;

/** Queue React's error for a mismatch at `f` and throw MISMATCH. */
function mismatch(f: Fiber, text: boolean): never {
  const e = new Error(prodMessage(418, text ? "text" : "HTML", ""));
  (hydrationErrors ??= []).push(e, stackOf(e, f));
  // A host that claimed nothing has no node for the unmount that follows to remove.
  f.d ??= { parentNode: null };
  throw MISMATCH;
}

/** Whether comment data `d` starts a Suspense boundary ($, $!, $?, $~) or an Activity (&). */
const opens = (d: string): boolean => d === "$" || d === "$!" || d === "$?" || d === "$~" || d === "&";

/**
 * The first node from `x` on that hydration reads, as React's getNextHydratable finds it:
 * elements, texts and the start markers of Suspense boundaries and Activities. Other comments
 * (text separators, form state markers) and doctypes are passed over; an end marker ends the
 * content, so null.
 */
function hydratable(x: Any): Any {
  for (; x !== null; x = x.nextSibling) {
    const t = x.nodeType;
    if (t === 1 || t === 3) return x;
    if (t === 8) {
      const d = x.data;
      if (opens(d)) return x;
      if (d === "/$" || d === "/&") return null;
    }
  }
  return null;
}

/** Whether host `h` passes over server nodes that do not match, as React's root and singletons do. */
const passes = (h: Fiber): boolean => h.n === ROOT || h.t === "html" || h.t === "head" || h.t === "body";

/** Whether server node `x` is an `<input type="hidden">`, which React passes over anywhere. */
const hiddenInput = (x: Any): boolean => x.nodeName === "INPUT" && x.getAttribute("type") === "hidden";

// React's normalizeMarkupForTextOrAttribute: line breaks as \n, no NUL or U+FFFD.
const normalize = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/\u0000|�/g, "");

/** Whether server text `server` stands for `client`, as React's checkForUnmatchedText compares. */
const sameText = (server: string, client: string): boolean =>
  server === client || normalize(server) === normalize(client);

/**
 * The server's element for host fiber `f`, as React's canHydrateInstance finds it: the next one,
 * or in the root and the document's singletons the next with `f`'s tag. A host that is not the
 * server's (a portal's) claims nothing, nor does metadata that goes to <head>. A claimed element
 * whose content is one text checks it, and keeps the server's text, as React does.
 */
function claimElement(f: Fiber, type: string): Any {
  const h = curHost;
  if (!(h.f & CLAIMED) || hoistable(f, f.p)) return null;
  const p = f.p,
    pass = passes(h),
    tag = type.toLowerCase();
  for (let x = hydratable(h.hc); x !== null && x.nodeType === 1; x = hydratable(x.nextSibling)) {
    const hidden = hiddenInput(x);
    if (x.nodeName.toLowerCase() !== tag) {
      if (!pass && !hidden) break;
    } else if (
      pass ||
      !hidden ||
      (p.type === "hidden" && x.getAttribute("name") === (p.name == null ? null : "" + p.name))
    ) {
      h.hc = x.nextSibling;
      f.hc = x.firstChild;
      const ch = p.children,
        t = typeof ch;
      if (
        (t === "string" || t === "number" || t === "bigint") &&
        type !== "textarea" &&
        p.dangerouslySetInnerHTML == null
      ) {
        if (p.suppressHydrationWarning !== true && !sameText(x.textContent, "" + ch)) mismatch(f, true);
        f.tx = "" + ch;
      }
      return x;
    }
  }
  return mismatch(f, false);
}

/**
 * Render host fiber `f` on the server's element `dom`, as runHost renders a new one: it takes
 * React's hydrateInstance's props (claimProps), its children claim the element's, and server nodes
 * left over are a mismatch. Its ref attaches; autoFocus, an image's src and a select's value
 * wait for an update, as in React's production client.
 */
function hydrateHost(f: Fiber, dom: Any, p: Any): void {
  f.f |= CLAIMED;
  f.d = dom;
  dom[FIBER] = f;
  if (p.children != null && VOID.has(f.t)) throw new Error(prodMessage(137, f.t));
  dom[OWN] = curHost;
  claimProps(f, dom, p);
  const ph = curHost,
    pn = curNs;
  curHost = f;
  curNs = hostNs(f);
  try {
    hostChildren(f, dom, p, null);
  } finally {
    curHost = ph;
    curNs = pn;
  }
  f.f &= ~CLAIMED;
  if (f.tx === null && p.dangerouslySetInnerHTML?.__html == null) hostDone(f);
  if (f.f & STRUCT) place(f);
  if (p.ref != null) swapRef(f, p.ref, undefined);
}

/**
 * A claimed element's props, as React's production hydrateInstance applies them: no attribute or
 * style is written, only what the element needs to work. Its event props are listened for, a
 * function action listens for submit, and an input or textarea gets its default value and value
 * tracker (initInput and initTextarea), the user's value and checked state left alone. A custom
 * element's own listeners and properties wait for an update, as in React.
 */
function claimProps(f: Fiber, dom: Any, p: Any): void {
  const tag: string = f.t,
    custom = isCustom(tag);
  for (const k in p) {
    const v = p[k];
    if (v == null) continue;
    if (k.length > 2 && (k.charCodeAt(0) | 32) === 111 && (k.charCodeAt(1) | 32) === 110) {
      if ((!custom || REACT_EVENTS.has(k)) && k.charCodeAt(0) === 111 && k.charCodeAt(2) < 91) listenFor(dom, k);
    } else if (!custom && (k === "action" || k === "formAction") && typeof v === "function") ensure("submit", false);
  }
  if (tag === "input") {
    const type = p.type,
      v = p.value,
      dv = p.defaultValue;
    if (plain(type)) dom.type = type;
    if (v != null || dv != null) {
      if ((type === "submit" || type === "reset") && v == null) return track(dom);
      const d = dv != null ? toStr(dv) : "";
      dom.defaultValue = v != null ? toStr(v) : d;
    }
    const c = p.checked ?? p.defaultChecked;
    // Written back as it is, as React's initInput does while hydrating.
    // biome-ignore lint/correctness/noSelfAssign: the browser marks the field's checkedness dirty.
    dom.checked = dom.checked;
    dom.defaultChecked = !!c && typeof c !== "function" && typeof c !== "symbol";
    if (plain(p.name)) dom.name = p.name;
    track(dom);
  } else if (tag === "textarea") {
    let v = p.value;
    if (v == null) {
      let d = p.defaultValue;
      const ch = p.children;
      if (ch != null) {
        if (d != null) throw new Error(prodMessage(92));
        if (Array.isArray(ch) && ch.length > 1) throw new Error(prodMessage(93));
        d = Array.isArray(ch) ? ch[0] : ch;
      }
      v = d ?? "";
    }
    // React's getToStringValue: functions and symbols are "", anything else as it is.
    const d = typeof v === "function" || typeof v === "symbol" ? "" : v,
      text = dom.textContent;
    dom.defaultValue = d;
    if (text === d && text !== "") dom.value = text;
    track(dom);
  }
}

/**
 * The server's text node for text fiber `f`, as React's canHydrateTextInstance finds it. Its text
 * must match (or the parent suppress the warning); the server's stays. An empty text is not the
 * server's: it writes none.
 */
function claimText(f: Fiber): Any {
  const h = curHost,
    s: string = f.p;
  if (!(h.f & CLAIMED) || s === "") return null;
  const pass = passes(h);
  let x = hydratable(h.hc);
  while (x !== null && x.nodeType !== 3) x = pass || hiddenInput(x) ? hydratable(x.nextSibling) : null;
  if (x === null) mismatch(f, false);
  if (!(h.n === HOST && h.p.suppressHydrationWarning === true) && !sameText(x.data, s)) mismatch(f, true);
  h.hc = x.nextSibling;
  return x;
}

/**
 * After a claimed host's children: a server node left over is a mismatch, except where React
 * does not look (<form>, <button>, text content, and the document's singletons).
 */
function hostDone(f: Fiber): void {
  const t = f.t;
  if (t !== "form" && t !== "button" && t !== "textarea" && t !== "noscript" && !passes(f) && hydratable(f.hc) !== null)
    mismatch(f, false);
  f.hc = null;
}

/** The end marker of the server's Suspense boundary or Activity that starts at `start`, or null. */
function boundaryEnd(start: Any): Any {
  let depth = 0,
    x = start.nextSibling;
  for (; x !== null; x = x.nextSibling)
    if (x.nodeType === 8) {
      const d = x.data;
      if (d === "/$" || d === "/&") {
        if (depth === 0) break;
        depth--;
      } else if (opens(d)) depth++;
    }
  return x;
}

/**
 * The start marker of the server boundary node `x` is in, among its siblings, as React's
 * getParentHydrationBoundary finds it, or null.
 */
function boundaryAround(x: Any): Any {
  let depth = 0;
  for (x = x.previousSibling; x !== null; x = x.previousSibling)
    if (x.nodeType === 8) {
      const d = x.data;
      if (opens(d)) {
        if (depth === 0) return x;
        depth--;
      } else if (d === "/$" || d === "/&") depth++;
    }
  return null;
}

/**
 * A dehydrated boundary, in its Fiber.hc: its start marker (null for a hidden Activity, which the
 * server did not render), the levels of useId's tree id above it (see forkRun) and whether a pass
 * is due for it (a boundary still streaming in waits for the server to finish it).
 */
interface Dehydrated {
  s: Any;
  k: Any[];
  w: boolean;
  /** Whether a continuous event waits for it: it hydrates before other boundaries. */
  u?: boolean;
}

// The boundaries left dehydrated, in the order hydration met them.
let dehydrated: Fiber[] = [];

/**
 * Mount Suspense boundary or Activity `f` on a hydrating root: a hydration render leaves it
 * dehydrated; one still dehydrated hydrates now (its pass, an update or an event reached it); any
 * other mounts as on the client.
 */
function boundaryHydration(f: Fiber): void {
  if (hydrating && curHost.f & CLAIMED) dehydrate(f);
  else if (f.hc === null) {
    if (f.n === SUSPENSE) suspense(f);
    else activity(f);
  } else if (passing || f.hc.s === null) hydrateBoundary(f);
  // An update reached it, and could not hydrate it first (see selective): as React's
  // retrySuspenseComponentWithoutHydrating, it renders on the client, the server's nodes going.
  else clientRender(f);
}

// While a pass renders: a dehydrated boundary it renders hydrates.
let passing = false;

/**
 * Before updates render: the boundaries still dehydrated below the fibers in `q` (about to render
 * again), hydrated first with the props and context they had, in a commit of their own, as
 * React's updateDehydratedSuspenseComponent schedules their hydration at a higher priority than
 * the update and renders the update after. One that cannot hydrate yet (its content suspends, or
 * the server has not finished it) renders on the client when the update reaches it.
 */
function selective(q: Fiber[]): void {
  const tried: Fiber[] = [];
  for (;;) {
    let r: RootImpl | null = null;
    const list: Fiber[] = [];
    for (let i = 0; i < dehydrated.length; i++) {
      const b = dehydrated[i]!,
        st: Dehydrated = b.hc;
      // Content that suspended is tried again; a boundary the server has yet to finish is not.
      if (st === null || st.s === null || b.f & DEAD || tried.includes(b)) continue;
      if (!st.w && st.s.data !== "$" && st.s.data !== "&") continue;
      let p = b.r;
      while (p !== null && !((p.f & (DIRTY | DEAD)) === DIRTY && q.includes(p))) p = p.r;
      if (p === null) continue;
      // One at a time, outermost first: React hydrates each in a commit of its own.
      r = b.o;
      list.push(b);
      tried.push(b);
      break;
    }
    if (r === null) return;
    runPass(r, list, true);
    flushLayout();
    flushPassive();
  }
}

/**
 * Leave boundary `f` dehydrated, as React mounts a Suspense boundary or an Activity while
 * hydrating: it claims the server's boundary (else a mismatch), whose nodes stay held by
 * placeholder fibers, so they keep their place and go if the boundary unmounts first. A hidden
 * Activity the server did not render waits for the next pass, which renders it on the client.
 */
function dehydrate(f: Fiber): void {
  const h = curHost,
    st: Dehydrated = { s: null, k: forks.slice(), w: true };
  if (f.n === ACTIVITY && f.p.mode === "hidden") {
    f.hc = st;
    dehydrated.push(f);
    return;
  }
  const start = hydratable(h.hc);
  if (start === null || start.nodeType !== 8 || (start.data === "&") !== (f.n === ACTIVITY)) return mismatch(f, false);
  const end = boundaryEnd(start),
    ph: Fiber[] = [];
  h.hc = end === null ? null : end.nextSibling;
  for (let x = start; x !== null; x = x === end ? null : x.nextSibling) {
    const el = x.nodeType === 1,
      c = new Fiber(el ? HOST : TEXT, el ? x.nodeName : null, ph.length, f, f.o);
    c.d = x;
    if (!el) c.p = x.data;
    c.i = ph.length;
    x[OWN] = h;
    ph.push(c);
  }
  f.c = ph;
  st.s = start;
  f.hc = st;
  dehydrated.push(f);
}

/**
 * Hydrate dehydrated boundary `f`, as React's updateDehydratedSuspenseComponent does. A boundary
 * the server could not finish (`<!--$!-->`, or `<!--$?-->` once the document has loaded) renders
 * on the client with React's error; one still streaming in waits for the server, through the
 * `_reactRetry` React's streaming runtime calls (and the document's load, for `<!--$?-->`). Its
 * content claims the server's nodes; if it suspends, the server's HTML stays and it hydrates
 * again once the promise settles; if it does not match, or throws, the boundary renders on the
 * client (an error other than a mismatch reported as React's #422, caused by it).
 */
function hydrateBoundary(f: Fiber): void {
  const st: Dehydrated = f.hc,
    start = st.s,
    h = curHost;
  if (start === null) {
    f.hc = null;
    return activity(f);
  }
  const data: string = start.data;
  if (data === "$~" || (data === "$?" && start.ownerDocument.readyState === "loading")) {
    st.w = false;
    const doc = start.ownerDocument,
      retry = (): void => wake(f, st);
    if (data === "$~") start._reactRetry = retry;
    else {
      const loaded = (): void => {
        retry();
        doc.removeEventListener("DOMContentLoaded", loaded);
      };
      doc.addEventListener("DOMContentLoaded", loaded);
      start._reactRetry = loaded;
    }
    return;
  }
  if (data !== "$" && data !== "&") {
    // React's error for a boundary the server could not finish, with the server's digest.
    const t = start.nextSibling,
      digest = t !== null && t.nodeType === 1 ? (t.getAttribute("data-dgst") ?? undefined) : undefined;
    if (digest !== "") {
      const e: Any = new Error(prodMessage(419));
      e.stack = "";
      e.digest = digest;
      (hydrationErrors ??= []).push(e, null);
    }
    return clientRender(f);
  }
  const ph = f.c,
    hy = hydrating,
    hc = h.hc,
    claimed = h.f & CLAIMED,
    at = forks.length,
    met = dehydrated.length,
    errors = hydrationErrors === null ? 0 : hydrationErrors.length;
  for (let i = 0; i < ph.length; i++) ph[i]!.d[OWN] = null;
  f.c = NO_FIBERS;
  f.hc = null;
  hydrating = f.o.hydrate;
  h.f |= CLAIMED;
  h.hc = start.nextSibling;
  for (let i = 0; i < st.k.length; i++) forks.push(st.k[i]);
  const content = frag(f, 0);
  let thrown: Any = null;
  try {
    reconcile(content, f.p.children);
    // Server nodes the content did not claim: a mismatch at the boundary.
    if (hydratable(h.hc) !== null) mismatch(f, false);
  } catch (e) {
    thrown = e;
  }
  hydrating = hy;
  h.hc = hc;
  forks.length = at;
  if (!claimed) h.f &= ~CLAIMED;
  // The boundaries it left dehydrated take its place in the list, so passes go in tree order.
  const inner = dehydrated.splice(met);
  dehydrated.splice(dehydrated.indexOf(f) + 1, 0, ...inner);
  if (thrown === null) {
    f.s = content;
    f.c = [content];
    h.f |= STRUCT;
    return;
  }
  discard(content);
  f.c = ph;
  if (isThenable(thrown)) {
    // Suspended: the server's HTML stays until the content can hydrate.
    if (hydrationErrors !== null) hydrationErrors.length = errors;
    for (let i = 0; i < ph.length; i++) ph[i]!.d[OWN] = h;
    f.hc = st;
    st.w = false;
    const ping = (): void => wake(f, st);
    thrown.then(ping, ping);
    return;
  }
  if (thrown !== MISMATCH) recover(thrown, f, 422);
  clientRender(f);
}

/** A boundary that waited (for the server, or for a promise) is due for a pass again. */
function wake(f: Fiber, st: Dehydrated): void {
  if (f.hc === st && !st.w) {
    st.w = true;
    post();
  }
}

/** Render dehydrated boundary `f` on the client: the server's nodes go, and its content mounts. */
function clientRender(f: Fiber): void {
  for (let i = 0, xs = f.c; i < xs.length; i++) unmount(xs[i]!, true);
  f.c = NO_FIBERS;
  f.hc = null;
  // React's render on the client is its retry: an error it throws counts (see failed).
  counting(() => (f.n === SUSPENSE ? suspense(f) : activity(f)));
}

/**
 * Queue React's #422 (a boundary) or #423 (the root) for an error thrown while hydrating, caused
 * by it, with the component stack of where it was thrown.
 */
function recover(e: Any, f: Fiber, code: number): void {
  (hydrationErrors ??= []).push(new Error(prodMessage(code), { cause: e }), stackOf(e, f, code === 423));
  // At the root, React also builds the error's own stack, for an error update it then drops.
  if (code === 423) stackOf(e, f);
}

/**
 * Drop the fibers of a hydration render that did not finish: nothing of it was committed, so no
 * cleanup or ref runs, and the server's nodes stay.
 */
function discard(f: Fiber): void {
  f.f |= DEAD;
  if (f.n === HOST) {
    if (f.d[FIBER] === f) f.d[FIBER] = undefined;
  } else if (f.n === ACTIVITY && f.f & HIDDEN) hiddenCount--;
  for (let i = 0, xs = f.c; i < xs.length; i++) discard(xs[i]!);
}

// Whether a pass is posted, and the class error boundaries' count of errors caught when the
// root's hydration render began (see failures).
let posted = false,
  failedBefore = 0;

/** Post a pass for the boundaries due for one, after paint. */
function post(): void {
  if (!posted) {
    posted = true;
    afterPaint(pass);
  }
}

/** Whether boundary marker `s` stands for content the server could not finish. */
const unfinished = (s: Any): boolean =>
  s !== null && (s.data === "$!" || (s.data === "$?" && s.ownerDocument.readyState !== "loading"));

/**
 * A pass over dehydrated boundaries, as React renders their lanes: at idle priority, after any
 * other work waiting. Boundaries the server could not finish render first, in a pass of their
 * own (React's default lane); then every boundary due hydrates in one (its offscreen lane), and
 * the boundaries inside them in the next. One root per pass.
 */
function pass(): void {
  posted = false;
  if (flushing || task || micro || queue.length !== 0) return post();
  dehydrated = dehydrated.filter((f) => f.hc !== null && !(f.f & DEAD));
  const due = dehydrated.filter((f) => f.hc.w);
  if (due.length === 0) return;
  // A boundary a continuous event waits for first, as React hydrates it at that event's priority.
  const urgent = due.filter((f) => f.hc.u),
    r = (urgent[0] ?? due[0]!).o;
  let list = urgent.filter((f) => f.o === r);
  if (list.length === 0) list = due.filter((f) => f.o === r && unfinished(f.hc.s));
  if (list.length === 0) list = due.filter((f) => f.o === r);
  runPass(r, list, false);
  if (dehydrated.some((f) => f.hc !== null && f.hc.w)) post();
}

/**
 * Render `list`'s boundaries of root `r` as one commit: the last commit's effects first, then
 * each boundary in its place, then their layout effects and, after them, what they recovered
 * from, unless an error boundary caught an error in the pass, as React drops those then. `sync`
 * runs the passive effects too, as React's sync lane does.
 */
function runPass(r: RootImpl, list: Fiber[], sync: boolean): void {
  const before = failures,
    ph = curHost,
    pn = curNs,
    hosts: Fiber[] = [];
  const was = flushing;
  routed = false;
  flushing = passing = true;
  try {
    flushLayout();
    flushPassive();
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      // A boundary hydrated meanwhile (an update reached it) or gone is passed over.
      if (f.hc === null || f.f & DEAD) continue;
      // Rendered in its place, as rerender does, but placed only once every boundary rendered,
      // as React commits the pass: a node one inserts goes where the others' then are.
      let h = f.r!;
      while (h.n !== HOST && h.n !== ROOT && h.n !== PORTAL && h.n !== SLOT) h = h.r!;
      curHost = h;
      curNs = hostNs(h);
      try {
        run(f, f.p, false);
      } catch (e) {
        unwinding = true;
        throwTo(f, e);
      }
      hosts.push(h);
    }
    for (let i = 0; i < hosts.length; i++) if (hosts[i]!.f & STRUCT) place(hosts[i]!);
  } finally {
    curHost = ph;
    curNs = pn;
    flushing = was;
    passing = false;
  }
  const errors = hydrationErrors;
  hydrationErrors = null;
  if (errors !== null && !routed && failures === before) report(r.f, errors);
  flushWork(sync);
  replayKept();
  release(r);
}

/** Report `errors` to root fiber `f`'s onRecoverableError, with the layout effects queued now. */
function report(f: Fiber, errors: Any[]): void {
  later(f, () => {
    const report = f.o.opts.onRecoverableError;
    for (let i = 0; i < errors.length; i += 2) {
      if (report) callReport(report, errors[i], { componentStack: errors[i + 1] });
      else if (typeof reportError === "function") reportError(errors[i]);
      else console.error(errors[i]);
    }
  });
}

/**
 * Once root `r` has hydrated its shell and has nothing dehydrated left, it hydrates no more: its
 * renders and events no longer look here, and it stops listening for events to replay.
 */
function release(r: RootImpl): void {
  if (!r.mounted || dehydrated.some((f) => f.o === r && f.hc !== null && !(f.f & DEAD))) return;
  r.hydrate = false;
  const i = replays.indexOf(r);
  if (i < 0) return;
  for (const t of REPLAYED.split(" ")) r.f.d.removeEventListener(t, replays[i + 1], true);
  for (const t of KEPT.split(" ")) r.f.d.removeEventListener(t, replays[i + 2], true);
  replays.splice(i, 3);
}

/** Start hydrating root fiber `f`: its cursor at the container's first node. */
function hydrateBegin(f: Fiber): void {
  f.hc = f.d.firstChild;
  f.f |= CLAIMED;
  failedBefore = failures;
}

/** Element `p`'s first child named `name`, or null. */
function child(p: Any, name: string): Any {
  let x = p.firstChild;
  while (x !== null && x.nodeName !== name) x = x.nextSibling;
  return x;
}

/**
 * After a hydrating root's first render (or its throw). A suspension keeps the server's HTML and
 * hydrates the root again once it settles. A mismatch renders the root on the client, as React
 * does, the server's nodes going first, and so does any other error, reported as React's #423,
 * caused by it. Then what hydration recovered from goes to onRecoverableError with the layout
 * effects, unless the root failed or an error boundary caught an error, and the boundaries left
 * dehydrated get their pass. Returns what the root still has to handle.
 */
function hydrateDone(f: Fiber, thrown: Any): Any {
  f.f &= ~CLAIMED;
  f.hc = null;
  if (thrown !== null && isThenable(thrown)) {
    for (let i = 0, xs = f.c; i < xs.length; i++) discard(xs[i]!);
    f.c = NO_FIBERS;
    // The server's nodes are no one's again: nothing places or removes them.
    f.f &= ~STRUCT;
    f.o.mounted = false;
    hydrationErrors = null;
    return thrown;
  }
  if (thrown !== null) {
    if (thrown !== MISMATCH) recover(thrown, f, 423);
    const d = f.d;
    let html: Any = null;
    if (d.nodeType === 9) {
      // A whole document keeps its <html>, <head> and <body>, as React's singletons do.
      for (let i = 0, xs = f.c; i < xs.length; i++) unmount(xs[i]!, false);
      f.c = NO_FIBERS;
      html = sparingly(d);
    } else {
      removeAll(f);
      d.textContent = "";
    }
    hydrating = false;
    thrown = null;
    // React's render on the client is its retry: an error it throws counts (see failed).
    counting(() => {
      try {
        reconcile(f, f.p);
      } catch (e) {
        thrown = e;
      }
    });
    if (thrown !== null && !isThenable(thrown) && d.nodeType === 9) {
      // The client render failed too: the root unmounts, and the document keeps its singletons,
      // emptied, as React releases them.
      for (let i = 0, xs = f.c; i < xs.length; i++) unmount(xs[i]!, false);
      f.c = NO_FIBERS;
      // No one's now: the root's placing leaves it be.
      if (html !== null) html[OWN] = null;
      sparingly(d);
    } else if (html !== null) {
      const top: Node[] = [];
      for (let i = 0, xs = f.c; i < xs.length; i++) collect(xs[i]!, top);
      for (const n of top) if (n.nodeName === "HTML") adopt(n, html);
    }
  }
  const errors = hydrationErrors;
  hydrationErrors = null;
  // A root that fails for good reports its error alone, as React's does.
  if (errors !== null && (thrown === null || isThenable(thrown)) && failures === failedBefore) report(f, errors);
  replayKept();
  release(f.o);
  if (dehydrated.length !== 0) post();
  return thrown;
}

/**
 * React's clearContainerSparingly: empty document or singleton `c` but for the doctype, <html>,
 * <head> and <body> (each emptied the same way), scripts, styles and stylesheet links. Returns
 * the <html> it kept.
 */
function sparingly(c: Any): Any {
  let html: Any = null,
    x = c.firstChild;
  if (x !== null && x.nodeType === 10) x = x.nextSibling;
  while (x !== null) {
    const n = x,
      name = n.nodeName;
    x = x.nextSibling;
    if (name === "HTML" || name === "HEAD" || name === "BODY") {
      if (name === "HTML") html = n;
      sparingly(n);
    } else if (name !== "SCRIPT" && name !== "STYLE" && (name !== "LINK" || n.rel.toLowerCase() !== "stylesheet"))
      c.removeChild(n);
  }
  return html;
}

/**
 * The client's singleton element `n` (<html>, or a <head> or <body> in it) takes over the
 * server's `o`, as React's singletons acquire theirs: `o` loses its attributes and gets the
 * client's props, `n`'s nodes join it after what it kept, and its fiber renders on it.
 */
function adopt(n: Any, o: Any): void {
  const f: Fiber = n[FIBER];
  for (const a = o.attributes; a.length;) o.removeAttributeNode(a[0]);
  setProps(f, o, NO_PROPS, f.p, true);
  f.d = o;
  o[FIBER] = f;
  o[OWN] = n[OWN];
  for (let x = n.firstChild; x !== null;) {
    const next = x.nextSibling,
      name = x.nodeName;
    const s = name === "HEAD" || name === "BODY" ? child(o, name) : null;
    if (s !== null) adopt(x, s);
    else o.appendChild(x);
    x = next;
  }
}

/**
 * useSyncExternalStore's snapshot while hydrating: the server's, as React's client reads it.
 * Without getServerSnapshot, React's #407, which the boundary or root that recovers reports as
 * the cause of its #422 or #423; that client render reads getSnapshot.
 */
function storeSnapshot(getServerSnapshot: (() => Any) | undefined): Any {
  if (getServerSnapshot !== undefined) return getServerSnapshot();
  throw new Error(prodMessage(407));
}

// The events React replays (its discreteReplayableEvents): one inside a dehydrated boundary, or
// on a root that has not hydrated its shell, hydrates it first.
const REPLAYED =
  "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend " +
  "dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change " +
  "contextmenu reset";

// Each hydrating root and its replay listeners (discrete, continuous), in threes, until the root
// releases.
const replays: Any[] = [];

// The continuous events React keeps while their target has not hydrated, the latest of each kind
// (its queueIfContinuousEvent), then the events that drop the one kept of their kind: focus, drag
// and mouse, and pointer and pointer capture for each pointer.
const KEPT =
  "focusin dragenter mouseover pointerover gotpointercapture focusout dragleave mouseout pointerout lostpointercapture";

// The continuous events kept, by kind: each with its root and what blocks it.
const kept = /* @__PURE__ */ new Map<string, [RootImpl, Any, Fiber]>();
let replaying = false;

/**
 * A continuous event's capture at root `r`'s container, as React's dispatchEvent handles one: if
 * its target has not hydrated, it is kept, the latest of its kind, and stopped, and what blocks
 * it hydrates before other boundaries; else, as one that drops its kind, it drops what was kept.
 */
function keep(r: RootImpl, e: Any): void {
  const at = KEPT.split(" ").indexOf(e.type),
    i = at % 5,
    kind = i > 2 ? i + " " + e.pointerId : "" + i,
    b = r.f.f & DEAD ? null : blockedOn(r, e.target);
  if (b === null || at > 4) return void kept.delete(kind);
  kept.set(kind, [r, e, b]);
  e.stopPropagation();
  if (b.hc !== null && b.n !== ROOT) {
    b.hc.u = true;
    post();
  }
}

/**
 * Once something hydrates: the kept events nothing blocks any more are dispatched again, as
 * copies, on their targets, in a task, as React's replayUnblockedEvents does; one that the
 * boundary inside blocks now waits for it, which hydrates first.
 */
function replayKept(): void {
  if (kept.size === 0 || replaying) return;
  replaying = true;
  afterPaint(() => {
    replaying = false;
    // After the commit's passive effects, as React's replay task comes after theirs.
    flushPassive();
    // Focus, drag and mouse, then each pointer's, then each pointer capture's, as React's order.
    for (const [kind, k] of [...kept].sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0))) {
      const [r, e, b] = k;
      if (b.n === ROOT ? !r.mounted : b.hc !== null && !(b.f & DEAD)) continue;
      const next = r.f.f & DEAD ? null : blockedOn(r, e.target);
      if (next === null) {
        kept.delete(kind);
        e.target.dispatchEvent(new e.constructor(e.type, e));
      } else {
        k[2] = next;
        next.hc.u = true;
        post();
      }
    }
  });
}

/**
 * Make root `r` replay discrete events: a capture listener on its container for each, ahead of
 * the root's own listeners, which go back after it.
 */
function listenForReplay(r: RootImpl): void {
  const el = r.f.d,
    own = r.listeners.get(el)!,
    fn = (e: Event): void => replay(r, e),
    cont = (e: Event): void => keep(r, e);
  own.remove();
  r.listeners.delete(el);
  replays.push(r, fn, cont);
  for (const t of REPLAYED.split(" ")) el.addEventListener(t, fn, true);
  for (const t of KEPT.split(" ")) el.addEventListener(t, cont, true);
  listenOn(el, r);
}

/**
 * A discrete event's capture at root `r`'s container, as React's dispatchEvent handles one that
 * is blocked: what blocks it (the root's shell, else the dehydrated boundary its target is in)
 * hydrates at once, outermost first, and the event goes on to the root's handlers once nothing
 * does. Content that cannot hydrate yet (it suspends, or waits for the server) stops the event.
 */
function replay(r: RootImpl, e: Any): void {
  let b = r.f.f & DEAD ? null : blockedOn(r, e.target);
  if (b === null) return;
  for (;;) {
    if (b.n === ROOT) {
      b.f &= ~LATER;
      flushSync();
    } else if (!flushing) runPass(r, [b], true);
    const next = blockedOn(r, e.target);
    if (next === b) return void e.stopPropagation();
    if (next === null) break;
    b = next;
  }
  // The capture handlers, from here: the root's capture listeners hydration just added do not
  // run for an event already at the container, and one it had already sees it dispatched.
  dispatch(e, r, true);
}

/**
 * What keeps an event at `target` from root `r`'s handlers, as React's findInstanceBlockingEvent
 * finds it: the root, before its shell hydrated, or the outermost dehydrated boundary the target
 * is in. Null when nothing does.
 */
function blockedOn(r: RootImpl, target: Any): Fiber | null {
  if (!r.mounted) return r.f;
  // The node on the target's path just below the nearest element the root rendered, or its
  // container.
  let x = target,
    up = x == null || (x[FIBER] !== undefined && x[FIBER].o === r) ? null : x.parentNode;
  for (; up != null && up !== r.f.d && !(up[FIBER] !== undefined && up[FIBER].o === r); up = up.parentNode) x = up;
  if (up == null) return null;
  for (let m = boundaryAround(x); m !== null; m = boundaryAround(m))
    for (let i = 0; i < dehydrated.length; i++) {
      const f = dehydrated[i]!;
      if (f.hc !== null && f.hc.s === m && !(f.f & DEAD)) return f;
    }
  return null;
}

/** What hydration does, which hydrateRoot hands its root (see `hydrating`). */
const HYDRATION = {
  fork: forkRun,
  element: claimElement,
  host: hydrateHost,
  text: claimText,
  boundary: boundaryHydration,
  begin: hydrateBegin,
  root: hydrateDone,
  id: treeId,
  store: storeSnapshot,
  listen: (r: RootImpl): void => {
    beforeRender = selective;
    listenForReplay(r);
  },
  /** Whether an event's target is in content of root `r` that has not hydrated. */
  blocked: (r: RootImpl, e: Any): boolean => blockedOn(r, e.target) !== null,
};
type Hydration = typeof HYDRATION;

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
 * boundary caught (class support reports it). `onRecoverableError` gets what hydration recovered from,
 * as React's does: a mismatch, or a boundary the server could not finish.
 */
export interface RootOptions {
  identifierPrefix?: string;
  onUncaughtError?: (error: unknown, info: { componentStack?: string }) => void;
  onCaughtError?: (error: unknown, info: { componentStack?: string; errorBoundary?: unknown }) => void;
  onRecoverableError?: (error: unknown, info: { componentStack?: string }) => void;
}

/** A root: its ROOT fiber, its options, its useId counter and its event listeners. */
class RootImpl implements Root {
  /** The ROOT fiber; its `d` is the container. */
  readonly f: Fiber;
  /** identifierPrefix, for useId. */
  readonly prefix: string;
  readonly opts: RootOptions;
  /**
   * What hydration does, while the root hydrates: from hydrateRoot until its shell and every
   * boundary it left dehydrated have hydrated (or rendered on the client). Else false.
   */
  hydrate: Hydration | false = false;
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
    if (this.f.f & DEAD) throw new Error(prodMessage(409));
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
  checkContainer(container);
  const r = new RootImpl(container, options);
  roots.add(r);
  return r;
}

/**
 * A root that adopts the server-rendered HTML in `container`: its first render claims the
 * server's nodes in order, as React's client does, in a task (at once inside flushSync), and
 * each Suspense boundary in a later pass (see the hydration region). Where they do not match, the
 * nearest Suspense boundary the server rendered (else the root) renders on the client instead,
 * and onRecoverableError hears of it.
 */
export function hydrateRoot(container: Element | Document, children: Any, options: RootOptions = {}): Root {
  checkContainer(container);
  const r = new RootImpl(container, options);
  roots.add(r);
  r.hydrate = HYDRATION;
  HYDRATION.listen(r);
  r.render(children);
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
  // A first render that meets an error renders again whole (see firstAgain).
  let first = false;
  if (!r.mounted) {
    r.mounted = true;
    if (r.hydrate) (hydrating = r.hydrate).begin(f);
    else {
      f.d.textContent = "";
      first = true;
      firstErrors = [];
      redo++;
    }
  }
  try {
    if (thrown === null) {
      try {
        reconcile(f, f.p);
      } catch (e) {
        thrown = e;
        // React renders a render that failed again before its error counts (see failed).
        if (!first && !isThenable(e)) {
          const errors = failed(f, e);
          if (errors !== null) thrown = rootAgain(f, errors);
        }
      }
    }
    if (hydrating) {
      thrown = hydrating.root(f, thrown);
      hydrating = ph2;
    }
    if (first) thrown = firstAgain(f, thrown);
    if (thrown !== null) {
      if (isThenable(thrown)) thrown.then(retry(f), retry(f));
      else {
        removeAll(f);
        const report = r.opts.onUncaughtError;
        if (report) callReport(report, thrown, { componentStack: stackOf(thrown, f) });
        else reportUncaught(thrown);
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
 * After a root's first render: one that met an error (caught or not) renders again whole, every
 * node anew, as React's retry mounts everything again. Returns what the root has to handle.
 */
function firstAgain(f: Fiber, thrown: Any): Any {
  const promise = thrown !== null && isThenable(thrown);
  // The root's own error is one the first pass met.
  if (thrown !== null && !promise) failed(f, thrown);
  const errors = firstErrors!;
  firstErrors = null;
  redo--;
  if (!errors.length || promise) return thrown;
  discardAll(f);
  return rootAgain(f, errors);
}

/** React's retry of a root render that threw: it renders again. Returns what that throws, else null. */
function rootAgain(f: Fiber, errors: Any[]): Any {
  const x = retryRender(f, errors, () => reconcile(f, f.p));
  if (x !== null && !isThenable(x)) captureStacks(x, f);
  return x;
}

/**
 * Render a portal: its children are placed in its container, with the portal as their host.
 * The root listens on the container too, so events inside reach handlers through the fiber tree.
 */
function runPortal(f: Fiber, mount: boolean): void {
  if (mount) {
    listenOn(f.d, f.o);
    // Hosts that mount in it look for Fragment ref instances above, as they would without it.
    if (curHost.f & FRAGREF) f.f |= FRAGREF;
  }
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
      if (++tries > 25) throw new Error(prodMessage(301));
      f.f &= ~(RERENDER | DIRTY);
      hi = 0;
      // Effects collected by an abandoned pass are dropped.
      f.x = null;
      out = ref === undefined ? fn(args) : fn(args, ref);
    } while (f.f & RERENDER && again(f, mount));
    // React's renderWithHooks compares the hooks called with the last render's: two integer
    // compares and a flag test when they match, as every render after the first does.
    const hs = f.h;
    if (hs !== null && (hi !== hs.length || !(f.f & HOOKS))) hooksCalled(f, hs.length);
  } catch (e) {
    renderThrew(f, e);
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
    // (after rendering nothing) has its host place the new node, as a new host.
    if (!mount) {
      curHost.f |= STRUCT;
      if (curHost.f & FRAGREF) fragmentRefs!.hosts(f, true);
    }
  } else reconcile(f, out);
  // After the children: React runs a child's effects before its parent's.
  if (f.x !== null) commitEffects(f);
}

/**
 * Before another pass of a render that set state while rendering (rare): with no finished
 * render's hooks to match, the hooks of the first pass are all a later pass may call, as in
 * React, where a hook it adds is #467 on a mount (#312 on the server) and #310 otherwise.
 * Returns true, to go on.
 */
function again(f: Fiber, mount: boolean): boolean {
  if (!(f.f & HOOKS)) {
    f.f |= mount ? PASS | FIRST : PASS;
    // So the render's end (hooksCalled) clears the flags even if no pass calls a hook.
    f.h ??= [];
  }
  return true;
}

/**
 * After a render whose hooks differ in number from the last's (`n`), or the first render that
 * called any, as React's renderWithHooks and finishRenderingHooks judge them: fewer than a
 * finished render's is #300 (a render that calls none is not compared: as in React, the next
 * render with hooks mounts them anew, and the old ones' effects never clean up); otherwise the
 * fiber's hooks are now the ones to match.
 */
function hooksCalled(f: Fiber, n: number): void {
  const had = f.f & HOOKS;
  f.f &= ~(PASS | FIRST);
  if (hi === 0 && (had || n === 0)) {
    f.h = null;
    f.f &= ~HOOKS;
  } else if (had && hi < n) throw new Error(prodMessage(300));
  else f.f |= HOOKS;
}

// A component that hosted its block renders something else: the block goes,
// and the component's children are reconciled as anyone's.
function unfuse(f: Fiber): void {
  if (f.f & FRAGREF) fragmentRefs!.hosts(f, false);
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
  // React's isomorphic package keeps this message in full, even in production.
  if (typeof partial !== "object" && typeof partial !== "function" && partial != null)
    throw new Error(
      "takes an object of state variables to update or a function which returns an object of state variables.",
    );
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

// Class support is a separate module (./index.ts, @reactre/compat), so
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
  /**
   * Whether a hydration render is running: what it throws goes past error boundaries to the
   * Suspense boundary or root that recovers, as in React.
   */
  hydrating(): boolean;
  reconcile(f: Any, children: Any): void;
  removeAll(f: Any): void;
  readContext(f: Any, ctx: Any): Any;
  later(f: Any, fn: () => void): void;
  /** later, unless f is hidden content, which runs it when it shows. */
  laterShown(f: Any, fn: () => void): void;
  /** How hidden f is: 0 not, 1 or 2 inside content Suspense or Activity hid. */
  hiddenLevel(f: Any): number;
  attachRef(f: Any, ref: Any, v: Any): void;
  /** Throw React's error for a ref that is neither a function nor an object. */
  checkRef(ref: Any): void;
  detachRef(f: Any, ref: Any): void;
  schedule(f: Any): void;
  /** Run fn with f as the component rendering now. */
  rendering<T>(f: Any, fn: () => T): T;
  /** Whether f is the component rendering now. */
  isRendering(f: Any): boolean;
  /** Call a root's error callback; an error it throws is thrown again from a task. */
  report(report: (e: Any, info: Any) => void, e: Any, info: Any): void;
  /** Record that `e` was thrown in f (by a lifecycle or below), unless something deeper already did. */
  thrownIn(f: Any, e: Any): void;
  /** Record that f's render threw `e`. */
  renderThrew(f: Any, e: Any): void;
  /** The component stack of error `e`, from where it was thrown (else from f). */
  componentStack(e: Any, f: Any): string;
  /**
   * A boundary's render caught error `e`: null to handle it now, an empty array when a retry above
   * renders it again, else the errors (#520's) to render again with `again`.
   */
  failed(f: Any, e: Any): Any[] | null;
  /** Render again with `fn`, errors counting now; returns what it throws, else null. */
  again(f: Any, errors: Any[], fn: () => void): Any;
  /** Run `fn`, a render only for show: a boundary that catches in it only renders its fallback. */
  forShow(fn: () => void): void;
  /** Unmount f's children, which never committed: no ref or class hears of it. */
  discard(f: Any): void;
}

/** Internal: what class support provides. */
export interface ClassSupport {
  /** Render class fiber `f` (mount or update), lifecycles included. */
  run(f: Any, old: Props | null, mount: boolean): void;
  /** setState (`force` false) or forceUpdate (`force` true) on an instance. */
  enqueue(inst: Any, partial: Any, cb: (() => void) | undefined, force: boolean): void;
  /** Whether class fiber `f` is an error boundary (getDerivedStateFromError or componentDidCatch). */
  boundary(f: Any): boolean;
  /** componentWillUnmount for class fiber `f` (its ref is detached before). */
  unmount(f: Any): void;
  /** Boundary `f` renders its fallback for error `e` only for show, then is as it was. */
  draft(f: Any, e: Any): void;
}

// Installed class support, or null when the app does not load it.
let classes: ClassSupport | null = null;

/** Internal: installs class support; @reactre/compat (./index.ts) calls it when it loads. Once only. */
export function __installClasses(make: (core: ClassCore) => ClassSupport): void {
  // Installed once: a second call keeps the support already in use.
  classes ??= make({
    DIRTY,
    FORCE,
    RERENDER,
    DEAD,
    NO_CONTEXT,
    hydrating: () => hydrating !== false,
    reconcile,
    removeAll: (f) => removeAll(f),
    readContext,
    later,
    laterShown,
    hiddenLevel,
    attachRef,
    checkRef,
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
    report: callReport,
    thrownIn: childThrew,
    renderThrew,
    // Class support asks for a stack only for an error a boundary caught: counted for hydration.
    componentStack: (e, f) => (failures++, stackOf(e, f)),
    failed,
    again: retryRender,
    forShow,
    discard: discardAll,
  });
}

/**
 * How many errors class error boundaries have caught: a hydration pass in which one did reports
 * nothing it recovered from, as React drops those of a render that errored.
 */
let failures = 0;

/** Internal: what component stacks (./features/stacks.ts) read of the runtime. */
export interface StackCore {
  readonly HOST: number;
  readonly FUNC: number;
  readonly CLASS: number;
  readonly SUSPENSE: number;
  readonly ACTIVITY: number;
  readonly LAZY: number;
  readonly SLOT: number;
  /** Run fn with no component rendering, so a hook it calls throws. */
  outside<T>(fn: () => T): T;
}

/** Internal: what component stacks provide. */
export interface StackSupport {
  /** Record that `e` was thrown in f, unless something deeper already did. */
  thrownIn(f: Any, e: Any): void;
  /**
   * The component stack of error `e`, from where it was thrown (else from f). `keep` keeps where
   * `e` was thrown, for another stack of it.
   */
  componentStack(e: Any, f: Any, keep?: boolean): string;
  /**
   * Capture the stack of `e`, an error a render threw (else from f), as React's throwException
   * does: for #520's wrapper, which is returned, then for `e` itself, kept for its report.
   */
  capture(e: Any, f: Any): string;
}

/**
 * Internal: installs component stacks in error reports; @reactre/compat/features/stacks calls it
 * when it loads. Until then, errors are reported with an empty component stack.
 */
export function __installStacks(make: (core: StackCore) => StackSupport): void {
  const s = make({
    HOST,
    FUNC,
    CLASS,
    SUSPENSE,
    ACTIVITY,
    LAZY,
    SLOT,
    outside(fn) {
      const prev = cur;
      cur = null;
      try {
        return fn();
      } finally {
        cur = prev;
      }
    },
  });
  thrownIn = s.thrownIn;
  stackOf = s.componentStack;
  captureStacks = s.capture;
}

/**
 * Internal: installs React's handling of a list whose keys repeat;
 * @reactre/compat/features/keys calls it when it loads. Until then, repeated keys are reconciled
 * by compat's own rules.
 */
export function __installKeys(): void {
  dupList = dupKeys;
}

/** The error for a class component rendered while class support is not loaded. */
function noClasses(type: Any): Error {
  return new Error(
    `${type.displayName ?? type.name ?? "A class component"} is a class component, and this build leaves class support out. Alias react to @reactre/compat, not @reactre/compat/core, to include it.`,
  );
}

// #endregion

// #region Refs

/**
 * Point `ref` (a callback or an object) at `v`. A callback ref may return a cleanup function
 * (React 19); it is kept in `f.rx` (on a class's instance, whose fiber's `rx` holds setState
 * callbacks) and called instead of `ref(null)` on detach.
 */
function attachRef(f: Fiber, ref: Any, v: Any): void {
  if (typeof ref === "function") {
    const r = ref(v);
    if (typeof r === "function") {
      if (f.n !== CLASS) f.rx = r;
      else f.s[REF_CLEANUP] = r;
    }
  } else if (ref !== null && typeof ref === "object") ref.current = v;
}
const REF_CLEANUP = Symbol("ref cleanup");

/** Detach `ref`: run its cleanup if it returned one, else call it with null or clear `current`. */
function detachRef(f: Fiber, ref: Any): void {
  const own = f.n !== CLASS ? f : f.s;
  const r = own === null ? undefined : f.n !== CLASS ? own.rx : own[REF_CLEANUP];
  if (typeof r === "function") {
    if (f.n !== CLASS) own.rx = null;
    else own[REF_CLEANUP] = null;
    r();
  } else if (typeof ref === "function") ref(null);
  else if (ref !== null && typeof ref === "object") ref.current = null;
}

/**
 * A host's or Fragment's ref changed from `oref` to `ref`: the old one detaches at once, the new
 * one attaches with layout effects. Hidden content detached its refs when it hid, and attaches
 * them when it shows.
 */
function swapRef(f: Fiber, ref: Any, oref: Any): void {
  if (oref != null && (hiddenCount === 0 || hiddenLevel(f) === 0)) detachRef(f, oref);
  if (ref != null) {
    checkRef(ref);
    laterShown(f, () => attachRef(f, ref, f.n === HOST ? f.d : fragmentRefs!.of(f)));
  }
}

/** React's markRef: a ref is a function or an object (#284), checked where it changes. */
function checkRef(ref: Any): void {
  if (typeof ref !== "function" && typeof ref !== "object") throw new Error(prodMessage(284));
}

// #endregion

// #region Fragment refs

// React 19.3's Fragment refs: `<Fragment ref={r}>` gives a FragmentInstance, which adds event
// listeners to, observes, focuses, measures and scrolls the fragment's top-level host nodes. Its
// methods follow react-dom's: the nodes are the visible ones (hidden Activity and Suspense
// content is left out), found by walking the fibers, and the fragment's parent is the nearest
// host, root or block slot above it (a portal is passed through, as React does).
//
// Hosts that come and go while an instance exists get or lose its listeners and observers, as
// React's commit gives them. While no Fragment has a ref this costs one flag test where a host
// mounts or unmounts: an instance flags (FRAGREF) the fibers from its fragment up to its parent
// host and down to its top-level hosts, and only a host created under a flagged one, or a flagged
// host that unmounts, hides or shows, looks for instances above it.

/** Whether `f` is a fragment's parent as React finds it: a host, a root, or a block's slot. */
const isParent = (f: Fiber): boolean => f.n === HOST || f.n === ROOT || f.n === SLOT;

/** Fragment `f`'s parent fiber; null once it is unmounted, as React detaches it. */
function parentOf(f: Fiber): Fiber | null {
  if (f.f & DEAD) return null;
  let p = f.r!;
  while (!isParent(p)) p = p.r!;
  return p;
}

/** The node of the nearest portal between fragment `f` and its parent, if any. */
function portalOf(f: Fiber): Any {
  for (let p = f.r!; !isParent(p); p = p.r!) if (p.n === PORTAL) return p.d;
  return null;
}

/**
 * The visible host-level nodes among `f`'s children, in order (React's
 * traverseVisibleInstancesAndTextInstances): elements and text, through portals, not into hidden
 * Activity or Suspense content; hoisted <head> nodes are not the fragment's. `deep` lists what is
 * inside each host too, a compiled block's nodes as its DOM holds them. Fiber `mark` is listed
 * where it is met, with nothing of it.
 */
function nodesOf(f: { c: Fiber[] }, deep: boolean, out: Any[] = [], mark?: Fiber): Any[] {
  for (const c of f.c) {
    if (c.f & BOX) {
      if (c.f & HOIST) continue;
      out.push(c.d);
      if (deep) {
        if (c.n === HOST) nodesOf(c, true, out);
        else if (c.n !== TEXT) domNodes(c.d, out);
      }
    } else if (c === mark) out.push(c);
    else if (!(c.f & HIDDEN)) nodesOf(c, deep, out, mark);
  }
  return out;
}
function domNodes(n: Any, out: Any[]): void {
  for (let x = n.firstChild; x !== null; x = x.nextSibling) {
    out.push(x);
    domNodes(x, out);
  }
}

/**
 * Fragment `f`'s instance, made when its ref first attaches (React's safelyAttachRef). It flags
 * the fibers up to its parent and down to its top-level hosts, hidden ones included, so hosts
 * that mount, unmount, hide or show there look for it (see fragmentHosts).
 */
function fragmentOf(f: Fiber): FragmentInstance {
  if (f.s === null) {
    const fi = (f.s = new FragmentInstance(f));
    for (const n of nodesOf(f, false)) (n.reactFragments ??= new Set()).add(fi);
    for (let p = f; ; p = p.r!) {
      p.f |= FRAGREF;
      if (isParent(p)) break;
    }
    flagDown(f);
  }
  return f.s;
}
function flagDown(f: Fiber): void {
  for (const c of f.c) {
    c.f |= FRAGREF;
    if (!(c.f & BOX)) flagDown(c);
  }
}

/**
 * Host-level fiber `f` mounted or showed (`add`), or unmounted or hid: its node gets or loses the
 * listeners and observers of each Fragment ref instance between it and its parent, innermost
 * first, as React's commit does (commitFragmentInstanceInsertionEffects and the like). A
 * fragment with an instance that unmounts or hides detaches its ref.
 */
function fragmentHosts(f: Fiber, add: boolean): void {
  if (!(f.f & BOX) || f.f & HOIST) {
    if (!add && f.s !== null && f.t === FRAGMENT && f.p.ref != null) safely(f, () => detachRef(f, f.p.ref));
    return;
  }
  for (let p = f.r!; !isParent(p); p = p.r!) {
    const fi: FragmentInstance | null = p.n === FRAG ? p.s : null;
    if (fi === null) continue;
    f.f |= FRAGREF;
    const node = f.d;
    listen(node, fi.l, add);
    if (node.nodeType === 3) continue;
    if (fi.o !== null)
      for (const ob of fi.o) {
        if (add) {
          dropUnobserves(fi, ob, node);
          ob.observe(node);
        } else if (typeof ob.rootMargin === "string") unobserveLater(fi, ob, node);
        else ob.unobserve(node);
      }
    if (add) (node.reactFragments ??= new Set()).add(fi);
    else node.reactFragments?.delete(fi);
  }
}

// An IntersectionObserver unobserves a node that left a fragment after the next paint, as React
// does, so it still reports the node leaving: flat triples of instance, observer and node.
let unobserves: Any[] = [];
function unobserveLater(fi: FragmentInstance, ob: Any, node: Any): void {
  if (unobserves.push(fi, ob, node) > 3) return;
  const frame = (fn: () => void): void =>
    void (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn));
  frame(() =>
    frame(() => {
      const q = unobserves;
      unobserves = [];
      for (let i = 0; i < q.length; i += 3) q[i + 1].unobserve(q[i + 2]);
    }),
  );
}
/** Drop the waiting unobserves of `ob` by `fi`: of `node`, or of every node, unobserved now. */
function dropUnobserves(fi: FragmentInstance, ob: Any, node: Any): void {
  const q = unobserves;
  let w = 0;
  for (let i = 0; i < q.length; i += 3) {
    if (q[i] === fi && q[i + 1] === ob && (node === null || q[i + 2] === node)) {
      if (node === null) ob.unobserve(q[i + 2]);
    } else {
      q[w++] = q[i];
      q[w++] = q[i + 1];
      q[w++] = q[i + 2];
    }
  }
  q.length = w;
}

/** Add a FragmentInstance's listeners `ls` to `node`, or take them off. */
function listen(node: Any, ls: FragmentListener[] | null, add: boolean): void {
  if (ls !== null)
    for (const l of ls) node[add ? "addEventListener" : "removeEventListener"](l.t, l.a, attachOptions(l.o));
}
/** The options a fragment's listener is added to nodes with: `once` and `signal` are the instance's. */
const attachOptions = (o: Any): Any =>
  o != null && typeof o !== "boolean" && (o.once === true || o.signal instanceof AbortSignal)
    ? { capture: o.capture, passive: o.passive }
    : o;
/** Where a listener with type `t` and options `o` is in `ls`: type, function and capture flag identify it. */
const indexOfListener = (ls: FragmentListener[], t: string, l: Any, o: Any): number =>
  ls.findIndex((x) => x.t === t && x.l === l && captures(x.o) === captures(o));
const captures = (o: Any): boolean => (typeof o === "boolean" ? o : !!o?.capture);

/**
 * Focus the first element of `nodes` that takes focus: one already focused does, else one whose
 * focus() fires a focus event (React's setFocusIfFocusable).
 */
function focusFirst(nodes: Any[], options: Any): void {
  for (const node of nodes) {
    if (node.nodeType !== 1) continue;
    const doc = node.ownerDocument;
    if (doc.activeElement === node) return;
    let did = false;
    const on = (): void => void (did = true);
    try {
      doc.addEventListener("focus", on, true);
      node.focus(options);
    } finally {
      doc.removeEventListener("focus", on, true);
    }
    if (did) return;
  }
}

/** A range over text node `n`'s contents. */
function rangeOf(n: Any): Range {
  const r = n.ownerDocument.createRange();
  r.selectNodeContents(n);
  return r;
}

/**
 * The host-level nodes just before and after fragment `f` among its parent's (null where there is
 * none), as React finds an empty fragment's siblings: one in hidden content has only the last.
 */
function siblingsOf(f: Fiber): [Any, Any] {
  const p = parentOf(f),
    ns = p === null ? [] : nodesOf(p, false, [], f);
  let i = ns.indexOf(f);
  if (i === -1) i = ns.length;
  return [ns[i - 1] ?? null, ns[i + 1] ?? null];
}

/** The fiber that rendered `node`, or the nearest node above it (React's getClosestInstanceFromNode). */
function fiberOf(node: Any): Fiber | null {
  for (let n = node; n != null; n = n.parentNode) {
    if (n[FIBER] !== undefined) return n[FIBER];
    // Text keeps no link to its fiber: it is found among the fibers its host places.
    const t = n.nodeType === 3 && n[OWN] != null ? textFiber(n[OWN], n) : null;
    if (t !== null) return t;
  }
  return null;
}
function textFiber(f: Fiber, node: Any): Fiber | null {
  for (const c of f.c) {
    const t = c.d === node ? c : c.f & BOX ? null : textFiber(c, node);
    if (t !== null) return t;
  }
  return null;
}

/** The nearest host-level fiber or root above `f` (React's getParentForFragmentAncestors). */
function hostAbove(f: Fiber): Fiber | null {
  let p = f.r;
  while (p !== null && !(p.f & BOX) && p.n !== ROOT) p = p.r;
  return p;
}
/** The lowest host-level fiber or root at or above both `a` and `b`, if they share one. */
function commonHost(a: Fiber, b: Fiber): Fiber | null {
  const above = new Set<Fiber>();
  for (let x: Fiber | null = a; x !== null; x = hostAbove(x)) above.add(x);
  for (let x: Fiber | null = b; x !== null; x = hostAbove(x)) if (above.has(x)) return x;
  return null;
}

/**
 * Whether the fiber tree agrees with document position `pos` of `other` to the fragment `frag`
 * whose first and last nodes are `first` and `last` (React's validateDocumentPositionWithFiberTree):
 * a portal can put nodes where the tree does not.
 */
function treeAgrees(pos: number, frag: Fiber, first: Any, last: Any, other: Any): boolean {
  const of = fiberOf(other);
  if (pos & 16) {
    for (let x = of; x !== null; x = x.r) if (x === frag) return true;
    return false;
  }
  if (pos & 8) {
    if (of !== null) return true;
    const doc = other.ownerDocument;
    return other === doc || other === doc.documentElement || other === doc.body;
  }
  if (!(pos & 6) || of === null) return false;
  // Preceding: `other` comes before the first node in a walk of their common host; following,
  // after the last.
  const edge = pos & 2 ? first : last,
    top = commonHost(fiberOf(edge)!, of);
  if (top === null) return false;
  const ns = nodesOf({ c: [top] }, true),
    oi = ns.indexOf(of.d),
    ei = ns.indexOf(edge);
  return pos & 2 ? oi !== -1 && (ei === -1 || oi < ei) : ei !== -1 && oi > ei;
}

/** Scroll the window to text node `n` (React's scrollTextNodeIntoView). */
function scrollToText(n: Any, top: boolean): void {
  const r = rangeOf(n).getBoundingClientRect(),
    w = window;
  w.scrollTo(w.scrollX + r.left, w.scrollY + (top ? r.top : r.bottom - w.innerHeight));
}

/** What the `Fragment` export installs: a fragment's instance, and a host's part in its fragments. */
interface FragmentRefs {
  of(f: Fiber): FragmentInstance;
  hosts(f: Fiber, add: boolean): void;
}

/**
 * A listener added through a FragmentInstance: its type, listener and options, the function nodes
 * get (a wrapper for `once`), and the removal of its abort signal's listener.
 */
interface FragmentListener {
  t: string;
  l: Any;
  o: Any;
  a: Any;
  x: (() => void) | null;
}

/**
 * What a ref on a Fragment receives (React 19.3's FragmentInstance): one per fragment, made when
 * its ref first attaches and kept for the fragment's life.
 */
class FragmentInstance {
  /** The fragment's fiber. */
  readonly f: Fiber;
  /** Listeners added, in order; null until the first. */
  l: FragmentListener[] | null = null;
  /** Observers observing its nodes; null until the first. */
  o: Set<Any> | null = null;
  constructor(f: Fiber) {
    this.f = f;
  }
  /** Its visible host-level nodes (see nodesOf); none once it is unmounted. */
  private n(deep: boolean): Any[] {
    return this.f.f & DEAD ? [] : nodesOf(this.f, deep);
  }

  addEventListener(type: string, listener: Any, options?: Any): void {
    const obj = options != null && typeof options !== "boolean";
    const signal = obj ? options.signal || null : null;
    if (signal !== null && signal.aborted) return;
    const ls = (this.l ??= []);
    if (indexOfListener(ls, type, listener, options) !== -1) return;
    let a = listener,
      x: (() => void) | null = null;
    if (obj && options.once === true) {
      const fi = this;
      a = function (this: Any, e: Any): void {
        fi.removeEventListener(type, listener, options);
        if (typeof listener === "function") listener.call(this, e);
        else listener.handleEvent(e);
      };
    }
    if (signal !== null) {
      const off = (): void => this.removeEventListener(type, listener, options);
      signal.addEventListener("abort", off, { once: true });
      x = () => signal.removeEventListener("abort", off);
    }
    ls.push({ t: type, l: listener, o: options, a, x });
    const ao = attachOptions(options);
    for (const n of this.n(false)) n.addEventListener(type, a, ao);
  }

  removeEventListener(type: string, listener: Any, options?: Any): void {
    const ls = this.l;
    const i = ls === null ? -1 : indexOfListener(ls, type, listener, options);
    if (i === -1) return;
    const l = ls![i]!,
      ao = attachOptions(l.o);
    for (const n of this.n(false)) n.removeEventListener(type, l.a, ao);
    ls!.splice(i, 1);
    if (l.x !== null) l.x();
  }

  /**
   * Dispatch `event` as the fragment's own: on its parent, or (when the fragment has listeners or
   * the event does not bubble) on a node put in the parent for the dispatch, which carries the
   * fragment's listeners and lets the event bubble on from there.
   */
  dispatchEvent(event: Event): boolean {
    const p = parentOf(this.f);
    if (p === null) return true;
    const parent = p.d,
      ls = this.l;
    if ((ls === null || ls.length === 0) && event.bubbles) return parent.dispatchEvent(event);
    const tmp = parent.nodeType === 9 ? parent.createComment("") : document.createTextNode("");
    listen(tmp, ls, true);
    parent.appendChild(tmp);
    const ok = tmp.dispatchEvent(event);
    listen(tmp, ls, false);
    parent.removeChild(tmp);
    return ok;
  }

  /** Focus the first element in the fragment that takes focus, searching inside its hosts. */
  focus(options?: FocusOptions): void {
    focusFirst(this.n(true), options);
  }

  /** Focus the last element in the fragment that takes focus. */
  focusLast(options?: FocusOptions): void {
    focusFirst(this.n(true).reverse(), options);
  }

  /** Blur the focused element if it is one of the fragment's nodes or inside one. */
  blur(): void {
    const p = parentOf(this.f);
    if (p === null) return;
    const active = (p.d.nodeType === 9 ? p.d : p.d.ownerDocument).activeElement;
    if (active === null) return;
    for (const n of this.n(false))
      if (n.nodeType !== 3 && (n === active || n.contains(active))) return void active.blur();
  }

  observeUsing(observer: Any): void {
    (this.o ??= new Set()).add(observer);
    for (const n of this.n(false)) if (n.nodeType !== 3) observer.observe(n);
  }

  unobserveUsing(observer: Any): void {
    if (this.o === null || !this.o.delete(observer)) return;
    for (const n of this.n(false)) if (n.nodeType !== 3) observer.unobserve(n);
    dropUnobserves(this, observer, null);
  }

  getClientRects(): DOMRect[] {
    const rects: DOMRect[] = [];
    for (const n of this.n(false)) rects.push(...(n.nodeType === 3 ? rangeOf(n) : n).getClientRects());
    return rects;
  }

  getRootNode(options?: GetRootNodeOptions): Node | FragmentInstance {
    const p = parentOf(this.f);
    return p === null ? this : p.d.getRootNode(options);
  }

  compareDocumentPosition(other: Node): number {
    // Node.DOCUMENT_POSITION_*: DISCONNECTED 1, PRECEDING 2, FOLLOWING 4, CONTAINS 8,
    // CONTAINED_BY 16, IMPLEMENTATION_SPECIFIC 32.
    const p = parentOf(this.f);
    if (p === null) return 1;
    const ns = this.n(false),
      portal = portalOf(this.f);
    if (ns.length === 0) {
      // No nodes: its place among its parent's (or its portal's) children decides.
      const at = portal ?? p.d,
        pos = at.compareDocumentPosition(other);
      let r = pos;
      if (at === other) r = 8;
      else if (pos & 16) {
        // Inside the parent: before or after the fragment's next sibling, if it has one.
        const next = siblingsOf(this.f)[1],
          q = next === null ? 2 : next.compareDocumentPosition(other);
        r = q === 0 || q & 4 ? 4 : 2;
      }
      return r | 32;
    }
    const first = ns[0],
      last = ns[ns.length - 1],
      at = portal !== null ? first.parentElement : p.d;
    if (at == null) return 1;
    const firstIn = at.compareDocumentPosition(first) & 16,
      lastIn = at.compareDocumentPosition(last) & 16,
      fr = first.compareDocumentPosition(other),
      lr = last.compareDocumentPosition(other);
    const r =
      (firstIn && first === other) ||
      (lastIn && last === other) ||
      fr & 16 ||
      lr & 16 ||
      (firstIn && lastIn && fr & 4 && lr & 2)
        ? 16
        : (!firstIn && first === other) || (!lastIn && last === other)
          ? 32
          : fr;
    return r & 1 || r & 32 || treeAgrees(r, this.f, first, last, other) ? r : 32;
  }

  scrollIntoView(alignToTop?: boolean): void {
    if (typeof alignToTop === "object") throw new Error(prodMessage(566));
    const ns = this.n(false),
      top = alignToTop !== false;
    if (ns.length === 0) {
      // No nodes: a sibling (the next one first when aligning to the top), else the parent.
      const [before, after] = siblingsOf(this.f);
      const n = top ? after || before || parentOf(this.f)?.d : before || after;
      if (n == null) return;
      if (n.nodeType === 3) scrollToText(n, top);
      else if (n.nodeType === 11) {
        const host = "host" in n ? n.host : null;
        if (host !== null) host.scrollIntoView(alignToTop);
      } else if (n.nodeType !== 9) n.scrollIntoView(alignToTop);
      return;
    }
    // The last one ends in view when aligning to the top, the first one otherwise.
    for (const n of top ? ns.reverse() : ns) {
      if (n.nodeType === 3) scrollToText(n, top);
      else n.scrollIntoView(alignToTop);
    }
  }
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
  return new Fiber(FRAG, FRAGMENT, k, p, p.o);
}

/**
 * Render a Suspense boundary. Its primary content lives in a fragment (f.s) and its fallback in
 * another (f.q), so each keeps its state across switches. A promise thrown below (or routed here
 * in f.x) shows the fallback until it settles, then the boundary renders again.
 */
function runSuspense(f: Fiber): void {
  // On a root that hydrates, a mount (or a boundary still dehydrated) is hydration's.
  if (f.s === null && f.o.hydrate) f.o.hydrate.boundary(f);
  else suspense(f);
}

function suspense(f: Fiber): void {
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
      // Resolved: the fallback goes and the kept content is shown again.
      if (f.q !== null) {
        setHidden(primary, false);
        if (primary.f & HIDDEN) {
          primary.f &= ~HIDDEN;
          hiddenCount--;
          if (hiddenLevel(primary) === 0) reappear(primary);
        }
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
  // Suspended: keep the content hidden with its state.
  // The boundary itself is done; its primary stays DIRTY so the retry renders it again.
  f.f &= ~DIRTY;
  primary = f.s;
  if (primary !== null) {
    primary.f |= DIRTY;
    setHidden(primary, true);
    if (!(primary.f & HIDDEN)) {
      primary.f |= HIDDEN;
      hiddenCount++;
      if (hiddenLevel(primary) === 0) disappear(primary);
    }
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
 * nodes are hidden and, as React's Offscreen does, it commits no effects, refs or class
 * lifecycles until it is shown: hiding cleans up what ran, showing runs it all once.
 */
function runActivity(f: Fiber): void {
  // On a root that hydrates, a mount (or an Activity still dehydrated) is hydration's.
  if (f.s === null && f.o.hydrate) f.o.hydrate.boundary(f);
  else activity(f);
}

function activity(f: Fiber): void {
  const hide = f.p.mode === "hidden";
  let inner: Fiber | null = f.s;
  const mounting = inner === null;
  if (inner === null) {
    inner = f.s = frag(f, 0);
    f.c = [inner];
    curHost.f |= STRUCT;
  }
  const was = (f.f & HIDDEN) !== 0;
  // Hidden before the render, so the render commits nothing.
  if (hide && !was) {
    f.f |= HIDDEN;
    hiddenCount++;
  }
  reconcile(inner, f.p.children);
  if (hide === was) return;
  // Inside other hidden content, what is cleaned up or run waits for that content.
  const above = hiddenLevel(f);
  if (hide) {
    setHidden(inner, true);
    if (mounting) return;
    if (above === 0) disappear(inner);
    if (above < 2) disconnectPassive(inner);
  } else {
    f.f &= ~HIDDEN;
    hiddenCount--;
    setHidden(inner, false);
    if (above === 0) reappear(inner);
    if (above < 2) reconnectPassive(inner);
  }
}

// Hidden content (React's Offscreen): inside a hidden Activity nothing commits (level 2);
// inside content a Suspense boundary hid, layout effects, refs and class lifecycles wait while
// passive effects stay connected (level 1). `hiddenCount` counts such subtrees, so the common
// case looks nothing up.
let hiddenCount = 0;

/** How hidden fiber `f` is: 0 not, 1 its layout work waits, 2 all its effects wait. */
function hiddenLevel(f: Fiber): number {
  if (hiddenCount === 0) return 0;
  let level = 0;
  for (let p = f.r; p !== null; p = p.r)
    if (p.f & HIDDEN) {
      if (p.n === ACTIVITY) return 2;
      // A Suspense boundary's primary fragment, hidden while its fallback shows.
      if (p.n === FRAG) level = 1;
    }
  return level;
}

/** Queue `fn` with layout effects, unless `f` is hidden content, which runs it when it shows. */
function laterShown(f: Fiber, fn: () => void): void {
  if (hiddenCount === 0 || hiddenLevel(f) === 0) later(f, fn);
}

/** Whether hiding and showing walk into child `c`: not into an Activity hidden on its own. */
const walks = (c: Fiber): boolean => !(c.n === ACTIVITY && c.f & HIDDEN);

/**
 * Hide `f`'s subtree's layout work, parent first (React's disappearLayoutEffects): layout
 * cleanups run, refs detach, classes unmount.
 */
function disappear(f: Fiber): void {
  if (f.n === FUNC) {
    if (f.h !== null)
      for (let ix = 0, xs = f.h; ix < xs.length; ix++) {
        const h = xs[ix]!;
        if (h.k === LAYOUT && h.x !== undefined) {
          const x = h.x;
          h.x = undefined;
          safely(f, x);
        }
      }
  } else if (f.n === HOST) {
    if (f.p.ref != null) safely(f, () => detachRef(f, f.p.ref));
  } else if (f.n === CLASS) {
    if (f.p.ref != null) safely(f, () => detachRef(f, f.p.ref));
    if (classes !== null) safely(f, () => classes!.unmount(f));
  }
  // A Fragment's ref detaches; a hidden host is no Fragment ref's and loses their listeners and
  // observers.
  if (f.f & FRAGREF) fragmentRefs!.hosts(f, false);
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    if (walks(c)) disappear(c);
  }
}

/** Clean up `f`'s subtree's passive effects, parent first, in the passive flush. */
function disconnectPassive(f: Fiber): void {
  if (f.n === FUNC && f.h !== null)
    for (let ix = 0, xs = f.h; ix < xs.length; ix++) {
      const h = xs[ix]!;
      if (h.k === PASSIVE && h.x !== undefined) {
        passiveUnmountQ.push(f, h.x);
        h.x = undefined;
      }
    }
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    if (walks(c)) disconnectPassive(c);
  }
}

/**
 * Show `f`'s subtree's layout work again, children first (React's reappearLayoutEffects): layout
 * effects run, classes mount, refs attach.
 */
function reappear(f: Fiber): void {
  // A Fragment's ref attaches before its children's refs and layout effects, as in React; a host
  // shown again gets the listeners and observers of the Fragment refs it is under, unless a
  // fallback inside still hides it.
  if (f.t === FRAGMENT) swapRef(f, f.p.ref, null);
  if (f.f & FRAGREF && hiddenLevel(f) === 0) fragmentRefs!.hosts(f, true);
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    if (walks(c)) reappear(c);
  }
  if (f.n === FUNC) {
    if (f.h !== null)
      for (let ix = 0, xs = f.h; ix < xs.length; ix++) {
        const h = xs[ix]!;
        if (h.k === LAYOUT) layoutQ.push(h);
      }
  } else if (f.n === HOST) {
    const ref = f.p.ref;
    if (ref != null) later(f, () => attachRef(f, ref, f.d));
  } else if (f.n === CLASS) {
    const inst = f.s,
      ref = f.p.ref;
    if (inst !== null && typeof inst.componentDidMount === "function") later(f, () => inst.componentDidMount());
    if (ref != null) later(f, () => attachRef(f, ref, inst));
  }
}

/** Queue `f`'s subtree's passive effects to run again, children first. */
function reconnectPassive(f: Fiber): void {
  for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
    const c = xs[ix]!;
    if (walks(c)) reconnectPassive(c);
  }
  if (f.n === FUNC && f.h !== null)
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
      // Hidden content detached its refs when it hid; content that never committed never attached
      // them (see discardAll).
      if (f.p.ref != null && !discarding && (hiddenCount === 0 || hiddenLevel(f) === 0))
        safely(f, () => detachRef(f, f.p.ref));
      // Then it loses Fragment refs' listeners and observers, as in React.
      if (f.f & FRAGREF) fragmentRefs!.hosts(f, false);
      for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
        const c = xs[ix]!;
        unmount(c, false);
      }
      return;
    case TEXT:
      if (rm && f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
      if (f.f & FRAGREF) fragmentRefs!.hosts(f, false);
      return;
    case BLOCK:
      if (rm && f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
      if (f.f & FRAGREF) fragmentRefs!.hosts(f, false);
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
          else if (h.k === PASSIVE) passiveUnmountQ.push(f, h.x);
          h.x = undefined;
        }
      }
      if (f.f & BOX) {
        // Its block: one node, its slots' nodes inside it.
        if (rm && f.d.parentNode !== null) f.d.parentNode.removeChild(f.d);
        if (f.f & FRAGREF) fragmentRefs!.hosts(f, false);
        for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
          const c = xs[ix]!;
          unmount(c, false);
        }
        return;
      }
      break;
    case CLASS:
      // The ref is detached, then componentWillUnmount runs, each on its own, as React does;
      // hidden content did both when it hid, and content that never committed does neither.
      if (!discarding && (hiddenCount === 0 || hiddenLevel(f) === 0)) {
        if (f.p.ref != null) safely(f, () => detachRef(f, f.p.ref));
        if (classes !== null) safely(f, () => classes!.unmount(f));
      }
      break;
    case FRAG:
      // A Fragment's ref detaches (only one with an instance has the flag), unless hidden
      // content's did when it hid.
      if (f.f & FRAGREF && (hiddenCount === 0 || hiddenLevel(f) === 0)) fragmentRefs!.hosts(f, false);
      break;
    case ACTIVITY:
      for (let ix = 0, xs = f.c; ix < xs.length; ix++) {
        const c = xs[ix]!;
        unmount(c, rm);
      }
      if (f.f & HIDDEN) hiddenCount--;
      return;
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
// What runs before a batch of updates renders: hydration's, once a root hydrates (see selective).
let beforeRender: ((q: Fiber[]) => void) | null = null;
let batch = 0; // depth of event handlers, flushSync, batchedUpdates and act: no flush until 0
let micro = false; // a microtask flush is queued
let task = false; // a flush in a task of its own is queued
let passiveTimer = false; // a passive-effect flush is queued after paint
// React's nestedUpdateCount: commits in a row that left an update to render (a layout effect, ref
// or componentDidUpdate setting state on every commit). Past React's limit, the next update
// throws #185 (see schedule).
let nested = 0;
// React's rootWithNestedUpdates: the root those commits left their updates in. A commit that
// leaves its update in another root (or in several) starts the count over, so React counts the
// commits of each root, and two roots updating each other take turns without a limit.
let nestedRoot: RootImpl | null = null;

/**
 * The count after a commit that left the updates now queued: one more when they are all in the
 * root the last such commit left its own in, else 1. Only commits that leave an update call it.
 */
function nestedCount(): number {
  let r: RootImpl | null = queue[0]!.o;
  for (let ix = 1; ix < queue.length && r !== null; ix++) if (queue[ix]!.o !== r) r = null;
  const n = r !== null && r === nestedRoot ? nested + 1 : 1;
  nestedRoot = r;
  return n;
}

/**
 * Mark `f` for re-render and queue it once. Outside a batch or a flush, a flush is queued as
 * React picks its lane: in a microtask during a discrete event (a listener outside React's own,
 * for a click or a key), as its sync lane; otherwise in a task of its own, as its default and
 * continuous lanes, so updates from timers that fire one after another render together.
 */
function schedule(f: Fiber): void {
  if (f.f & DEAD) return;
  // React's limit, as its getRootForUpdatedFiber checks it on every update: its count starts at
  // the second such commit, so the 52nd throws, from the setState (to the effect's boundary).
  if (nested > 51) {
    nested = 0;
    throw new Error(prodMessage(185));
  }
  f.f |= DIRTY;
  // React's lane, roughly: an update outside any event, batch or flush waits for its task, and
  // flushSync leaves it there until a sync update reaches the same fiber.
  let later = false;
  if (!batch && !flushing && !micro) {
    const e = (globalThis as Any).event;
    if (e !== undefined && DISCRETE.has(e.type)) flushSoon(false);
    else {
      later = true;
      if (!task) {
        task = true;
        afterPaint(runTask);
      }
    }
  }
  if (!(f.f & QUEUED)) {
    f.f |= later ? QUEUED | LATER : QUEUED;
    queue.push(f);
  } else if (!later) f.f &= ~LATER;
}
function runTask(): void {
  task = false;
  if (!micro) runMicro();
}
// Events whose updates React renders on its sync lane (getEventPriority's discrete events).
const DISCRETE = new Set(
  (
    "beforetoggle cancel click close contextmenu copy cut auxclick dblclick dragend dragstart drop focusin " +
    "focusout input invalid keydown keypress keyup mousedown mouseup paste pause play pointercancel " +
    "pointerdown pointerup ratechange reset seeked submit toggle touchcancel touchend touchstart " +
    "volumechange change selectionchange textInput compositionstart compositionend compositionupdate " +
    "beforeblur afterblur beforeinput blur fullscreenchange fullscreenerror focus hashchange popstate " +
    "select selectstart"
  ).split(" "),
);

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
  // Nothing escapes a flush: errors in renders, placement and effects go to a boundary or the root.
  flushWork(s);
}
// A resolved promise's then queues a microtask in the same queue, in the same
// order, as queueMicrotask, without leaving the engine for the browser's API.
const RESOLVED = Promise.resolve();
/**
 * Call a root's error callback as React's logCaughtError and logUncaughtError do: an error it
 * throws is thrown again from a task of its own.
 */
function callReport(report: (e: Any, info: Any) => void, e: Any, info: Any): void {
  try {
    report(e, info);
  } catch (x) {
    setTimeout(() => {
      throw x;
    }, 0);
  }
}

/** Report an error the way an uncaught one is: reportError, or a throw from a fresh task. */
function reportUncaught(e: Any): void {
  if (typeof reportError === "function") reportError(e);
  else
    setTimeout(() => {
      throw e;
    }, 0);
}

// The error a render threw last, and whether a component's render (or a child that failed to
// mount) threw it, rather than an element's props, a child's type or a class lifecycle: only such
// an error renders again (see failed), as compat keeps no props from before the throw to render an
// update again from. Written by the first catch an error passes, only on a throw.
let lastError: Any = null,
  inRender = false;
/** A component's render (or a child that failed to mount) threw `e` in f. */
function renderThrew(f: Fiber, e: Any): void {
  if (e !== lastError) {
    lastError = e;
    inRender = true;
  }
  thrownIn(f, e);
}
/** Rendering f's children (or f's lifecycles) threw `e`. */
function childThrew(f: Fiber, e: Any): void {
  if (e !== lastError) {
    lastError = e;
    inRender = false;
  }
  thrownIn(f, e);
}

// Component stacks come with ./features/stacks.ts (see __installStacks): until it installs them,
// a throw records nothing and errors are reported with an empty stack.
let thrownIn: (f: Fiber, e: Any) => void = () => {},
  stackOf: (e: Any, f: Fiber | null, keep?: boolean) => string = () => "",
  captureStacks: (e: Any, f: Fiber) => string = () => "";

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
    for (;;) {
      routed = false;
      while (queue.length || layoutQ.length) {
        while (queue.length) {
          // Effects of the last commit run before the next render, as in React: its refs and
          // layout effects first, so its passive effects never see a ref still unset. A render
          // that threw is not committed yet: as React unwinds to the boundary within the render,
          // the boundary renders first.
          if (unwinding) unwinding = false;
          else {
            flushLayout();
            flushPassive();
          }
          // Two queue arrays, swapped: updates made while this one renders go
          // to the other, and neither is allocated again.
          const q = queue;
          queue = spareQueue;
          if (q.length > 1) q.sort(byDepth);
          // On a page that hydrates: dehydrated boundaries the updates reach hydrate first.
          if (beforeRender !== null) beforeRender(q);
          for (let ix = 0; ix < q.length; ix++) {
            const f = q[ix]!;
            // flushSync leaves an update from outside an event to its task.
            if (syncOnly && f.f & LATER) {
              held.push(f);
              continue;
            }
            f.f &= ~(QUEUED | LATER);
            // Skipped when a parent's render already rendered it (DIRTY cleared) or removed it.
            if ((f.f & (DIRTY | DEAD)) === DIRTY) rerender(f);
          }
          q.length = 0;
          spareQueue = q;
        }
        flushLayout();
        // A commit that leaves an update counts, as React counts it once the commit is over. The
        // update renders on React's sync lane, whose passive effects run first: here too, as they
        // would before the next render anyway. A sync flush's last commit counts below.
        if (queue.length) {
          flushPassive();
          nested = nestedCount();
        } else if (!sync) nested = 0;
      }
      if (!sync) break;
      flushPassive();
      nested = queue.length ? nestedCount() : 0;
      // An error a passive effect threw renders now, as React flushes the sync lane it is on.
      if (!routed || !queue.length) break;
    }
  } finally {
    flushing = false;
  }
  // Updates made by the passive effects just run (or left by a throw) get a flush of their own.
  if (queue.length) flushSoon(false);
  // What flushSync left waits for the task it was queued for.
  if (held.length) {
    for (let ix = 0; ix < held.length; ix++) queue.push(held[ix]!);
    held.length = 0;
  }
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
    // React renders a render that failed again before its error counts (see failed).
    const errors = isThenable(e) ? null : failed(f, e);
    const x = errors === null ? e : renderAgain(f, e, errors);
    if (errors === null || x !== null) {
      unwinding = true;
      throwTo(f, x);
    }
  } finally {
    const host = curHost;
    curHost = ph;
    curNs = pn;
    // A DOM error placing the nodes goes to a boundary, as React captures a commit-phase error.
    if (host.f & STRUCT)
      try {
        place(host);
      } catch (e) {
        throwTo(host, e);
      }
  }
}

// #endregion

// #region Errors and boundaries

// Whether the flush running is flushSync's, which renders sync-lane updates only, and the fibers
// it left queued for their task.
let syncOnly = false;
const held: Fiber[] = [];

// Whether throwTo routed something since flushWork last looked.
let routed = false;
// Whether a render threw, so its boundary renders before the commit's effects run.
let unwinding = false;

// Route a value thrown while rendering (or from an effect) of f to the
// nearest boundary above it, marking the path so a retry renders it again.
function throwTo(f: Fiber, e: Any): void {
  thrownIn(f, e);
  routed = true;
  const promise = isThenable(e);
  f.f |= DIRTY;
  // Promises go to the nearest Suspense, errors to the nearest error boundary class; the root
  // takes whatever nothing else does.
  let p = f.r;
  for (; p !== null; p = p.r) {
    if (p.n === ROOT || (promise ? p.n === SUSPENSE : p.n === CLASS && classes !== null && classes.boundary(p))) break;
    p.f |= DIRTY;
  }
  // Every fiber has its root above it, so only a root itself finds none.
  if (p === null) p = f;
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

// React renders a render that threw an error again, at once, before the error counts (see
// failed). `redo`: a retry above renders this work again (a root's first render, or a fallback
// rendered only for show); `retrying`: the retry renders, and its errors count; `refailed`: one
// did. All of it runs only once a render has thrown.
let redo = 0,
  retrying = false,
  refailed = false;
// While a root's first render runs, the errors it met: each #520's wrapper, then its stack.
let firstErrors: Any[] | null = null;
// What failed answers when a retry above renders the work again.
const DRAFT: Any[] = [];

/**
 * A render threw `e`, an error, to the boundary or root that catches it in f's place: its stack
 * is captured twice, as React's throwException does (for #520's wrapper, then its own). React then
 * renders the root again in one synchronous pass, and only an error that pass throws too counts.
 * Only an error a component's render threw (see renderThrew) renders again: one from an element's
 * props, a child's type or a class lifecycle counts at once, as compat keeps nothing from before
 * the throw to render it again from. Returns null when this one counts (it is the retry's, one
 * that is not a render's, or hydration's, which recovers its own way); DRAFT when a retry above
 * renders this work again; else the wrapper and its stack, for the catcher to render again and
 * report as recoverable if that renders.
 */
function failed(f: Fiber, e: Any): Any[] | null {
  const render = e === lastError && inRender && !hydrating;
  lastError = null;
  if (retrying) {
    refailed = true;
    if (render) captureStacks(e, f);
    return null;
  }
  if (!render) return null;
  const stack = captureStacks(e, f);
  const w = [new Error(prodMessage(520), { cause: e }), stack];
  if (!redo) return w;
  if (firstErrors !== null) firstErrors.push(w[0], stack);
  return DRAFT;
}

/**
 * React's retry: `fn` renders again, errors counting now. Returns what it throws, else null. If
 * nothing failed, the errors of the first pass (`errors`, see failed) were recoverable.
 */
function retryRender(f: Fiber, errors: Any[], fn: () => void): Any {
  const l = layoutQ.length,
    p = passiveQ.length;
  let thrown: Any = null;
  retrying = true;
  refailed = false;
  try {
    fn();
  } catch (e) {
    thrown = e;
    refailed = true;
  } finally {
    retrying = false;
  }
  if (!refailed) recovered(f, errors, l, p);
  return thrown;
}

/**
 * After a retry that rendered: the first pass's errors go to onRecoverableError (React's #520,
 * with the first stack) after the commit's layout effects, and what both passes queued runs once
 * (see once). `l` and `p` are where the retry's entries start in the two queues.
 */
function recovered(f: Fiber, errors: Any[], l: number, p: number): void {
  layoutQ = once(layoutQ, l);
  passiveQ = once(passiveQ, p);
  const q = layoutQ;
  later(f, () => {
    // Queued again at the end of the layout effects running, so it runs after them all.
    const h = new Hook(f);
    h.c = () => {
      const report = f.o.opts.onRecoverableError;
      for (let i = 0; i < errors.length; i += 2) {
        if (report) callReport(report, errors[i], { componentStack: errors[i + 1] });
        else reportUncaught(errors[i]);
      }
    };
    q.push(h);
  });
}

/**
 * Queue `q` after a retry that rendered, its entries from `start` the retry's: what both passes
 * queued is kept once. An effect keeps the retry's place; a callback (a lifecycle, a ref, a store
 * check) the first pass's, which saw the instance as it was committed.
 */
function once(q: Hook[], start: number): Hook[] {
  const out: Hook[] = [];
  for (let i = 0; i < q.length; i++) {
    const h = q[i]!;
    if (
      i < start
        ? h.k === 0 || q.indexOf(h, start) < 0
        : h.k !== 0 || !q.some((x, j) => j < start && x.k === 0 && x.f === h.f)
    )
      out.push(h);
  }
  return out;
}

/**
 * React's retry of a queued fiber whose render threw `e`: the boundary above renders its fallback
 * only for show (React's first pass unwinds to it), then the fiber renders again. Returns what that
 * throws, for its boundary or the root, else null.
 */
function renderAgain(f: Fiber, e: Any, errors: Any[]): Any {
  draftAt(f, e);
  const x = retryRender(f, errors, () => run(f, f.p, false));
  if (x !== null && !isThenable(x)) captureStacks(x, f);
  return x;
}

/**
 * The error boundary that catches `e`, thrown in f, renders its fallback only for show (see draft
 * in ./features/classes.ts); a fallback that throws in turn passes its error on. The root renders
 * nothing to show.
 */
function draftAt(f: Fiber, e: Any): void {
  let b = f.r!;
  while (b.n !== ROOT && !(b.n === CLASS && classes !== null && classes.boundary(b))) b = b.r!;
  if (b.n === ROOT) return;
  // Rendered in its place, as rerender renders a fiber; the host keeps its placement flag.
  let h = b.r!;
  while (h.n !== HOST && h.n !== ROOT && h.n !== PORTAL && h.n !== SLOT) h = h.r!;
  const ph = curHost,
    pn = curNs,
    struct = h.f & STRUCT;
  curHost = h;
  curNs = hostNs(h);
  try {
    classes!.draft(b, e);
  } catch (x) {
    if (!isThenable(x)) {
      captureStacks(x, b);
      draftAt(b, x);
    }
  } finally {
    curHost = ph;
    curNs = pn;
    h.f = (h.f & ~STRUCT) | struct;
  }
}

/** Run `fn` as React's retry renders: an error a render throws in it counts at once. */
function counting(fn: () => void): void {
  const prev = retrying;
  retrying = true;
  try {
    fn();
  } finally {
    retrying = prev;
  }
}

/** Run `fn`, a render only for show: a boundary that catches in it only renders its fallback. */
function forShow(fn: () => void): void {
  redo++;
  try {
    fn();
  } finally {
    redo--;
  }
}

/**
 * Unmount the children of `p` that never committed (a render that failed, or a first pass that is
 * thrown away): their refs were never attached and their classes never mounted, so neither hears
 * of it, as React tells nothing of work it throws away.
 */
function discardAll(p: Fiber): void {
  const prev = discarding;
  discarding = true;
  try {
    removeAll(p);
  } finally {
    discarding = prev;
  }
}
let discarding = false;

/** A fiber that failed to mount: unmounted as never committed (see discardAll). */
function dropFailed(f: Fiber): void {
  const prev = discarding;
  discarding = true;
  try {
    unmount(f, !hydrating);
  } finally {
    discarding = prev;
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
  syncOnly = true;
  try {
    flushWork(true);
  } finally {
    syncOnly = false;
  }
  return r;
}

/** Run `fn` with its updates batched (they are batched anyway). */
export function unstable_batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  // React 19's is fn(a): updates are batched anyway, and render when the scheduler says.
  return fn(a);
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
  /**
   * Reducer. Any other hook React gives a queue (a store's, an optimistic or action hook's)
   * marks it non-null, so a state hook reading it on an update is not #311 (see notState).
   */
  r: Any = null;
  constructor(f: Fiber) {
    this.f = f;
  }
}

let layoutQ: Hook[] = []; // layout effects and refs, run before the flush returns
let passiveQ: Hook[] = []; // passive effects, run after paint or before the next render
let passiveUnmountQ: Any[] = []; // passive cleanups of unmounted components: fiber, cleanup pairs

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
  runEffects(q, true);
}

/** Run passive cleanups of unmounted components, then queued passive effects. */
function flushPassive(): void {
  const un = passiveUnmountQ;
  if (un.length) {
    passiveUnmountQ = [];
    for (let i = 0; i < un.length; i += 2) {
      let f: Fiber = un[i];
      try {
        un[i + 1]();
      } catch (e) {
        // As React does: from the removed subtree's nearest mounted ancestor, to a boundary
        // above it or the root; with no mounted ancestor left, reported as uncaught.
        while (f.r !== null && f.r.f & DEAD) f = f.r;
        if (f.r === null) reportUncaught(e);
        else throwTo(f, e);
      }
    }
  }
  const q = passiveQ;
  if (!q.length) return;
  passiveQ = [];
  runEffects(q, false);
}

/**
 * Run a queue of effects as React commits them: every cleanup first, then every setup. Effects
 * of fibers that died meanwhile are skipped, and so is the layout work of content hidden
 * meanwhile, which runs when it shows. A kind-0 entry is a `later` callback, run as is.
 */
function runEffects(q: Hook[], layout: boolean): void {
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
    if (h.f.f & DEAD || (layout && hiddenCount !== 0 && hiddenLevel(h.f) !== 0)) continue;
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
  // Hidden content runs its layout effects (level 1), or all of them (2), when it shows.
  const level = hiddenCount === 0 ? 0 : hiddenLevel(f);
  // As React's mutation phase does for each component: insertion cleanups, then insertion effects
  // (before any layout effect reads the DOM, React's order for CSS-in-JS), then layout cleanups.
  // Layout and passive effects wait in their queues.
  let insertions = false,
    layouts = false;
  for (let i = 0; i < fx.length; i += 3) {
    const h: Hook = fx[i];
    h.c = fx[i + 1];
    h.d = fx[i + 2];
    if (h.k === INSERTION) {
      insertions = true;
      if (h.x !== undefined) safely(f, h.x);
    } else if (h.k === LAYOUT) {
      if (level === 0) {
        layouts = true;
        layoutQ.push(h);
      }
    } else if (level < 2) passiveQ.push(h);
  }
  if (insertions)
    for (let i = 0; i < fx.length; i += 3) {
      const h: Hook = fx[i];
      if (h.k === INSERTION)
        safely(f, () => {
          const r = h.c();
          h.x = typeof r === "function" ? r : undefined;
        });
    }
  if (layouts)
    for (let i = 0; i < fx.length; i += 3) {
      const h: Hook = fx[i];
      if (h.k === LAYOUT && h.x !== undefined) {
        const x = h.x;
        h.x = undefined;
        safely(f, x);
      }
    }
}

// #endregion

// #region Hooks

// #region Core hooks

// Hooks are matched to their slots by call order, as in React: the component's hooks live in
// f.h and `hi` counts the calls of the current render.

/**
 * The current component's next hook slot, created on its first render. A slot the last render
 * did not have is React's #310 after a render that called hooks (#467 or #312 in a later pass of
 * a first render): a flag test where a slot is created, so only on a mount.
 */
function hook(): Hook {
  const f = cur;
  if (f === null) throw new Error(prodMessage(321));
  const hs = (f.h ??= []);
  let h = hs[hi];
  if (h === undefined) {
    if (f.f & (HOOKS | PASS)) throw new Error(prodMessage(f.f & FIRST ? (server !== null ? 312 : 467) : 310));
    hs[hi] = h = new Hook(f);
  }
  hi++;
  return h;
}

/**
 * Where a state hook (or an optimistic one) mounts: after a render that called hooks, or in a
 * later pass of a render, the slot was another kind of hook's, which React's client reports as
 * #311. Only reached as such a hook mounts.
 */
function notState(f: Fiber): void {
  if (f.f & (HOOKS | PASS) && server === null) throw new Error(prodMessage(311));
}

/**
 * Whether deps `b` differ from committed deps `a` by Object.is; missing deps always differ. Deps
 * of another length compare on their common part, as React's areHookInputsEqual does.
 */
function depsChanged(a: Any, b: Any): boolean {
  if (a === NO_DEPS || b == null || a == null) return true;
  for (let i = 0; i < a.length && i < b.length; i++) if (!Object.is(a[i], b[i])) return true;
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
  // Unchanged deps are kept too, as React keeps each render's: the next render compares with them.
  else h.d = deps;
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
// React calls a lazy initial state with no arguments; Apollo's useQuery reads its first argument
// as the previous state.
const callInit = (init: () => Any): Any => init();

/** A state value and its setter. The setter is stable for the component's life. */
export function useState<S>(init: S | (() => S)): [S, (action: S | ((prev: S) => S)) => void] {
  return useReducer(basicReducer, init, typeof init === "function" ? callInit : undefined) as Any;
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
  // A slot with no reducer yet: the hook mounts (h.r is set below on every render).
  if (h.r === null) {
    notState(f);
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
  if (cur === null) throw new Error(prodMessage(321));
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
 * A unique id, stable for the component's life. Outside hydration, one counter for the page, as
 * React's client has, in React 19's format (`_r_0_`, with the root's identifierPrefix after the
 * first `_`). While hydrating, and on the server, React's tree id (`_R_…_`): it comes from the
 * component's place in the tree, so it matches the id the server rendered.
 */
export function useId(): string {
  const h = hook();
  if (h.s === null) {
    // The hook marks itself as useId's: tree ids count a component's earlier calls (see treeId).
    h.s = useId;
    h.v =
      server !== null
        ? server.id()
        : hydrating
          ? hydrating.id(h)
          : "_" + h.f.o.prefix + "r_" + (clientIds++).toString(32) + "_";
  }
  return h.v;
}
let clientIds = 0;

/**
 * React's id for useId hook `h` mounting while hydrating: the tree id React's server and its
 * hydrating client both derive from the component's place in the tree. Worked out here, from
 * the fibers above, rather than kept up during render as React does, so only a hydrating useId
 * pays for it.
 *
 * Each level of the id is one (count, index) pair, React's pushTreeId: a child of an array is
 * index of count (holes included), and a component that called useId (or an unnamed
 * ViewTransition) is index 0 of 1 for what it renders. A later call in the same component adds
 * `H` and how many calls came before it.
 */
function treeId(h: Hook): string {
  const f = h.f,
    hs = f.h!;
  let calls = 0;
  for (let i = 0; hs[i] !== h; i++) if (hs[i]!.s === useId) calls++;
  // The levels from f up, as (count, index) pairs: forks are the arrays being mounted, innermost
  // last, each holding the fiber whose children it mounts.
  const lv: number[] = [];
  let top = forks.length;
  for (let x: Fiber = f; x.r !== null; x = x.r) {
    if (
      x !== f &&
      (x.n === FUNC
        ? x.h !== null && x.h.some((y) => y.s === useId)
        : x.t === ViewTransition && (x.p.name == null || x.p.name === "auto"))
    )
      lv.push(1, 0);
    if (top > 0 && forks[top - 3] === x.r) {
      top -= 3;
      lv.push(forks[top + 1], forks[top + 2]);
    }
  }
  // React's pushTreeId, from the root down: the index goes above the bits so far, and bits that
  // would pass 30 move to the overflow string, five at a time.
  let id = 1,
    overflow = "";
  for (let i = lv.length - 2; i >= 0; i -= 2) {
    const count = lv[i]!;
    let len = 31 - Math.clz32(id),
      base = id & ~(1 << len);
    if (32 - Math.clz32(count) + len > 30) {
      const bits = len - (len % 5);
      overflow = (base & ((1 << bits) - 1)).toString(32) + overflow;
      base >>= bits;
      len -= bits;
    }
    id = (1 << (32 - Math.clz32(count) + len)) | ((lv[i + 1]! + 1) << len) | base;
  }
  return (
    "_" +
    f.o.prefix +
    "R_" +
    (id & ~(1 << (31 - Math.clz32(id)))).toString(32) +
    overflow +
    (calls ? "H" + calls.toString(32) : "") +
    "_"
  );
}

/**
 * A value read from an external store, re-rendering when it changes. A server render reads only
 * the server snapshot, through `select` for the selector hook; so does hydration, as React's
 * client does, and the check after it subscribes renders the store's snapshot if it differs.
 */
export function useSyncExternalStore<T>(
  subscribe: (cb: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
  select?: (s: Any) => T,
): T {
  const f = cur!;
  const h = hook();
  // A box the subscription reads, updated each render: the latest snapshot, getter and subscribe,
  // and the check, made once. A server render keeps no box (so every pass takes this branch),
  // never calls getSnapshot and never subscribes.
  let box = h.s;
  // React's updateStoreInstance: after a commit that mounted the hook, rendered a new snapshot or
  // brought a new getSnapshot or subscribe, getSnapshot is called once more (the store may have
  // moved on since the render, and a hydrated snapshot, the server's, may not be the store's).
  let check = box === null;
  if (check) {
    if (server !== null) return server.snapshot(getServerSnapshot, select);
    box = h.s = h.r = { v: undefined, g: getSnapshot, u: subscribe, c: null };
    // A throwing getSnapshot counts as a change, as in React: the re-render rethrows it to the
    // nearest boundary.
    box.c = (): void => {
      let changed = true;
      try {
        changed = !Object.is(box.g(), box.v);
      } catch {}
      if (changed) schedule(f);
    };
  }
  // While hydrating, the server snapshot (hydrating.store throws #407 without one), as React's
  // client reads it: one test per call, as React's isHydrating.
  const v = hydrating ? hydrating.store(getServerSnapshot) : getSnapshot();
  if (!check) check = box.g !== getSnapshot || box.u !== subscribe || !Object.is(box.v, v);
  box.v = v;
  box.g = getSnapshot;
  box.u = subscribe;
  effect(PASSIVE, () => subscribe(box.c), [subscribe]);
  // The check is the store hook's own slot, queued as a passive callback after the subscription's
  // effect, as React orders them: no allocation, and nothing queued when nothing changed.
  if (check) (f.x ??= []).push(h, box.c, null);
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
  const select = useCallback(() => selection(memo, getSnapshot(), selector, isEqual), [getSnapshot, selector, isEqual]);
  // A server render reads the selection of the server snapshot; hydration reads it through the
  // memo the client's goes through, as React's selector hook does, so a store whose snapshot is
  // the server's renders nothing again.
  const server =
    hydrating && getServerSnapshot != null
      ? () => selection(memo, getServerSnapshot(), selector, isEqual)
      : (getServerSnapshot ?? undefined);
  return useSyncExternalStore(subscribe, select, server as Any, selector);
}

/** The selection of snapshot `s`: the memo's while `s` is its snapshot or `isEqual` says it is equal. */
function selection<S, T>(
  memo: RefObject<{ s: S; t: T } | null>,
  s: S,
  selector: (s: S) => T,
  isEqual: ((a: T, b: T) => boolean) | undefined,
): T {
  const m = memo.current;
  if (m !== null && Object.is(m.s, s)) return m.t;
  const t = selector(s);
  if (m !== null && isEqual !== undefined && isEqual(m.t, t)) {
    memo.current = { s, t: m.t };
    return m.t;
  }
  memo.current = { s, t };
  return t;
}

/**
 * A function that calls the latest `fn` (for effects that must not re-run when it changes). As
 * React's, it is a new function each render, every one calling the latest `fn`, and it throws
 * when called while a component renders.
 */
export function useEffectEvent<F extends (...args: Any[]) => Any>(fn: F): F {
  const h = hook();
  // Updated during render, not in an effect: rendering is synchronous, so the effects that call
  // the function run after the render that set it.
  h.v = fn;
  return ((...args: Any[]) => {
    if (cur !== null) throw new Error(prodMessage(440));
    return h.v(...args);
  }) as F;
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
 * may be called conditionally, as React allows. A browser() token reads as undefined on the
 * client; anything else is React's error.
 */
export function use<T>(usable: PromiseLike<T> | Context<T>): T {
  if (usable !== null && typeof usable === "object") {
    if (typeof (usable as Any).then === "function")
      return readThenable(server !== null ? server.thenable(usable) : usable);
    const tt = (usable as Any).$$typeof;
    if (tt === RECOVERABLE_TYPE) {
      // A server render leaves the nearest boundary to the client.
      if (server !== null) throw server.browser(usable);
      return undefined as T;
    }
    if (tt === CONTEXT_TYPE) {
      if (cur === null) throw new Error(prodMessage(308));
      return readContext(cur, usable);
    }
  }
  throw new Error(prodMessage(438, String(usable)));
}

// The $$typeof of a browser() token.
const RECOVERABLE_TYPE = Symbol.for("react.recoverable");

/**
 * A token for content that renders only in the browser: a server renderer shows the nearest
 * Suspense fallback for it, and on the client use() reads it as undefined (React 19.3).
 */
export function browser(reason?: unknown): { $$typeof: symbol; _reason: unknown } {
  return { $$typeof: RECOVERABLE_TYPE, _reason: reason };
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
      else reportUncaught(e);
    });
  else fin();
}

/**
 * Run `fn` as a transition. Rendering is synchronous, so its updates render at once. An error it
 * throws, or rejects with, is reported, as React's reportGlobalError does.
 */
export function startTransition(fn: () => Any): void {
  const t: Transition = { done: [], wait: [] };
  let r: Any;
  try {
    r = inTransition(t, fn);
  } catch (e) {
    for (const d of t.done) d();
    reportUncaught(e);
    return;
  }
  settle(t, r);
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
        // As React's: the error goes to the component's boundary, not to the caller.
        setPending(false);
        throwTo(f, e);
        return;
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
      // A server render shows `initial` and nothing renders after it.
      if (server === null) {
        const f = h.f;
        later(f, () => {
          h.v = false;
          schedule(f);
        });
      }
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
  if (h.r === null) {
    const f = h.f;
    notState(f);
    h.r = useOptimistic;
    // The pending updates, each in its own box so clear() removes exactly that one.
    h.v = [];
    h.s = (a: A) => {
      if (cur === f) throw new Error(prodMessage(479));
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

/**
 * `[state, dispatch, isPending]`: dispatch runs `action(state, payload)`, one at a time, and keeps
 * its result, as React's action queue does. The first queued action runs inside dispatch. In a
 * transition the state changes when an action finishes and isPending is true meanwhile; outside
 * one the state is the running action, which the component suspends on. An action that fails
 * rejects the ones queued after it, and its error goes to the component's boundary.
 */
export function useActionState<S, P>(
  action: (state: S, payload: P) => S | Promise<S>,
  initialState: S,
  permalink?: string,
): [S, (payload: P) => void, boolean] {
  const [stored, setState] = useState<Any>(initialState);
  const [pending, setPending] = useState(false);
  const f = cur!;
  const h = hook();
  if (h.s === null) {
    if (server !== null) {
      // A server render: React's server hook. Its state goes in the state hook above (hi - 3), so
      // the passes that follow return it.
      const r = server.actionState(action, initialState, permalink);
      f.h![hi - 3]!.v = r[0];
      h.v = { r: action };
      h.s = r[1];
      return r;
    }
    // a: the action dispatch runs (null once one failed, until a new action is rendered); r: the
    // action rendered last; s: the state the next action starts from; q: the actions queued, the
    // first one running; n: actions dispatched in transitions and not finished.
    const box = (h.v = { a: action as Any, r: action as Any, s: initialState as Any, q: [] as Any[], n: 0 });
    h.r = box;
    const settle = (node: Any): void => {
      if (node.t === null) return;
      for (const d of node.t.done) d();
      if (--box.n === 0) setPending(false);
    };
    const succeed = (node: Any, v: Any): void => {
      box.s = v;
      node.res(v);
      settle(node);
      box.q.shift();
      // As React renders the state of the last action dispatched, a transition shows only the
      // state its last action leaves.
      if (box.q.length) run(box.q[0]);
      else if (node.t !== null) setState(() => v);
    };
    const fail = (node: Any, e: Any): void => {
      const all = box.q;
      box.q = [];
      box.a = null;
      for (const n of all) {
        n.rej(e);
        settle(n);
      }
      // Outside a transition the state is the action, whose rejection the render throws.
      if (node.t !== null) throwTo(f, e);
    };
    const run = (node: Any): void => {
      let r: Any;
      try {
        r = node.t !== null ? inTransition(node.t, () => node.a(box.s, node.payload)) : node.a(box.s, node.payload);
      } catch (e) {
        return fail(node, e);
      }
      if (isThenable(r))
        r.then(
          (v: Any) => succeed(node, v),
          (e: Any) => fail(node, e),
        );
      else succeed(node, r);
    };
    h.s = (payload: P) => {
      if (cur === f) throw new Error(prodMessage(485));
      if (box.a === null) return;
      const outer = transition;
      const node: Any = { a: box.a, payload, t: outer !== null ? ({ done: [] } as Transition) : null };
      node.p = new Promise((res, rej) => {
        node.res = res;
        node.rej = rej;
      });
      node.p.catch(noop);
      if (node.t !== null) {
        box.n++;
        setPending(true);
        // A form action or transition that queued this waits for it.
        if (outer!.wait !== undefined) outer!.wait.push(node.p.then(noop, noop));
      } else setState(() => node.p);
      box.q.push(node);
      if (box.q.length === 1) run(node);
    };
  }
  if (action !== h.v.r) h.v.a = h.v.r = action;
  return [isThenable(stored) ? readThenable(stored) : stored, h.s, pending];
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
  if (f === undefined || f.n !== HOST || f.t !== "form") throw new Error(prodMessage(522));
  // While the form's action runs, its end resets the form: one reset, as in React's one commit.
  if (f.s !== null && f.s.pending) return;
  // As React's state update of the form: reset at the next commit, after the transition it was
  // made in ends.
  const due = (): void => {
    later(f, () => form.reset());
    flushSoon(false);
  };
  if (transition !== null) transition.done.push(due);
  else due();
}

// #endregion

// #region Server rendering

// @reactre/compat/server renders function components with these same hooks: it calls them through
// __serverRender, which runs the component on a fiber of its own with `server` set. The hooks
// read `server` only where they mount (useId, useSyncExternalStore, useDeferredValue) or read a
// browser() token, so a client render pays nothing for it; effects are collected on the fiber
// and never run, and no ref is attached, since no host fiber exists.

/** Internal: what the hooks ask of @reactre/compat/server during a server render. */
export interface ServerHooks {
  /** useId's next id for the component rendering. */
  id(): string;
  /** useSyncExternalStore's value: the server snapshot, through `select` when given. */
  snapshot(getServerSnapshot: Any, select: Any): Any;
  /** use(browser()): the error that leaves the nearest Suspense boundary to the client. */
  browser(token: Any): unknown;
  /** use(promise): the promise to read, the one used at the same place before the component suspended. */
  thenable(t: Any): Any;
  /** useActionState: its state (a postback's, when it matches), dispatch and pending flag. */
  actionState(action: Any, initialState: Any, permalink: string | undefined): [Any, Any, boolean];
  /**
   * The full message of React's error `code` with `args`, for the errors a component can meet in a
   * server render: too many re-renders (301), more hooks in a pass than in the first (312), use()
   * of a value it cannot read (438) and a useEffectEvent function called while rendering (440).
   */
  message(code: number, args: Any[]): string;
}

// The server side of the hooks while a server render calls a component, else null.
let server: ServerHooks | null = null;

/**
 * Internal (@reactre/compat/server): call function component `fn` with `props` and `second`
 * (forwardRef's ref) as React's server does, hooks included, again while it sets its own state
 * during render. Its fiber dies after the render, so a setState later, or from a child during this
 * render, does nothing, as on React's server.
 */
export function __serverRender(s: ServerHooks, fn: Any, props: Any, second: Any): Any {
  const f = new Fiber(FUNC, fn, 0, null, null as Any);
  const prevCur = cur,
    prevHi = hi,
    prevServer = server;
  cur = f;
  server = s;
  let out: Any,
    tries = 0;
  try {
    do {
      if (++tries > 25) throw new Error(prodMessage(301));
      f.f &= ~RERENDER;
      hi = 0;
      out = fn(props, second);
    } while (f.f & RERENDER && again(f, true));
  } finally {
    f.f |= DEAD;
    cur = prevCur;
    hi = prevHi;
    server = prevServer;
  }
  return out;
}

// #endregion

// #region Server-only APIs and stubs

/** The client has no cache: a function that calls `fn`, as React's client cache returns. */
export function cache<F extends (...args: Any[]) => Any>(fn: F): F {
  return function (this: unknown, ...args: Any[]) {
    return fn.apply(null, args);
  } as F;
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
    // The capture phase is the root's; the bubble handlers run from the target's own listener,
    // and an element under this one that fires the event gets one when it first does.
    if (!capture) listenOwn(dom, type);
    if (capture || (type !== "scroll" && type !== "scrollend")) ensure(type, true);
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

// Text fields, whose onChange follows `input` and `change` events (React's isTextInputElement):
// textareas and these input types. Checkboxes and radios follow `click` (when their checked state
// changed), selects, files and custom elements `change`, and other inputs fire no onChange.
const TEXT_TYPES = new Set(
  "color date datetime datetime-local email month number password range search tel text time url week".split(" "),
);
function textLike(el: Any): boolean {
  const tag = el.nodeName;
  return tag === "TEXTAREA" || (tag === "INPUT" && TEXT_TYPES.has(el.type));
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

// Whether the field's value moved since the tracker last saw it; records it.
function changed(el: Any): boolean {
  if (el[TRACKED] === undefined) return true;
  const v = checkable(el) ? (el.checked ? "true" : "false") : "" + el.value;
  if (v === el[TRACKED]) return false;
  el[TRACKED] = v;
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
// onChange comes in the bubble phase only, capture handlers and all, as React's ChangeEventPlugin
// runs after the bubble phase's own handlers.
function propsFor(type: string, target: Any, capture: boolean, f: Fiber): string[] | null {
  if (type === "input") return !capture && textLike(target) && changed(target) ? ON_INPUT_CHANGE : ON_INPUT;
  if (type === "change") {
    if (capture) return null;
    const tag = target.nodeName;
    if (tag === "SELECT" || (tag === "INPUT" && target.type === "file")) return ON_CHANGE;
    if (textLike(target)) return changed(target) ? ON_CHANGE : null;
    return tag !== "INPUT" && isCustom(tag.toLowerCase()) ? ON_CHANGE : null;
  }
  const name = PROP_OF.get(type);
  if (type === "click" && !capture && f.n === HOST && f.t === "input" && checkable(target) && changed(target)) {
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
  // A target in content the root has not hydrated reaches no handler, as in React.
  if (root.hydrate && root.hydrate.blocked(root, e)) return;
  // The nearest element this root rendered (text nodes and foreign nodes have no fiber).
  let node = e.target;
  while (node != null && !(node[FIBER] !== undefined && node[FIBER].o === root)) node = node.parentNode;
  if (node == null) return;
  const target: Fiber = node[FIBER];
  const type: string = e.type;
  // An event that does not bubble reaches its target's own listener, which React adds to the
  // elements that fire it whatever their props: added here, on the way down, when first needed.
  if (capture && node === e.target && DIRECT.has(type) && LISTENS_FOR[node.nodeName]?.has(type)) listenOwn(node, type);
  const names = propsFor(type, node, capture, target);
  const over = !capture && OVER_OUT.has(type);
  if (names === null && !over && type !== "submit") return;
  // Controlled fields are restored once, after the bubble phase.
  const changed = !capture && names !== null && names.includes("onChange");
  batch++;
  try {
    if (names !== null)
      for (let ix = 0, xs = names; ix < xs.length; ix++) {
        const name = xs[ix]!;
        const path: Any[] = [];
        // onChange's capture handlers run first, outermost first, in the bubble phase.
        if (!capture && name === "onChange") {
          handlersOn(target, "onChangeCapture", e.target, path);
          reversePairs(path);
        }
        handlersOn(target, capture ? name + "Capture" : name, e.target, path);
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
    // Enter and leave after over and out, as React's plugins extract them.
    if (over) enterLeave(e, root, type, target);
    // A form action runs after the onSubmit handlers, unless one prevented the default.
    if (!capture && e.type === "submit" && !e.defaultPrevented) submitAction(e, target);
  } finally {
    if (--batch === 0) afterEvent(changed ? target : undefined);
  }
}

/**
 * Push the element and handler pairs for `prop` on the fiber path from `target` up, innermost
 * first: host fibers, and the elements of blocks on the way (entered at the event's target
 * `from`, or at a slot's parent element).
 */
function handlersOn(target: Fiber, prop: string, from: Any, path: Any[]): void {
  for (let f: Fiber | null = target; f !== null; f = f.r) {
    if (f.f & DEAD) continue;
    if (f.n === HOST) {
      const h = f.p[prop];
      if (typeof h === "function") path.push(f.d, h);
      else if (h) throw badListener(prop, h);
    } else if (f.b !== null) blockHandlers(f, prop, from, path);
    else if (f.n === SLOT) from = f.d;
  }
}

/** React's getListener: a handler prop that is set must be a function (#231). */
const badListener = (prop: string, h: Any): Error => new Error(prodMessage(231, prop, typeof h));

/** Reverse a path's element and handler pairs in place. */
function reversePairs(path: Any[]): void {
  for (let i = 0, j = path.length - 2; i < j; i += 2, j -= 2) {
    const d = path[i],
      fn = path[i + 1];
    path[i] = path[j];
    path[i + 1] = path[j + 1];
    path[j] = d;
    path[j + 1] = fn;
  }
}

// #endregion

// #region Enter and leave

// Props derived from over and out events, and the native types they come from.
const ENTER_LEAVE = new Set(["onMouseEnter", "onMouseLeave", "onPointerEnter", "onPointerLeave"]);
const OVER_OUT = new Set(["mouseover", "mouseout", "pointerover", "pointerout"]);

/** The window of an event's target, as React finds it. */
function windowOf(t: Any): Any {
  if (t.window === t) return t;
  const doc = t.ownerDocument;
  return doc ? doc.defaultView : typeof window === "undefined" ? null : window;
}

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
  // An end's element: a fiber's node, or inside a block the element itself; outside the root, the
  // window, as React gives it.
  const node = (f: Fiber | null, native: Any): Any =>
    f === null ? windowOf(e.target) : f.b !== null ? (native.nodeType === 1 ? native : native.parentNode) : f.d;
  const fromNode = node(from, from === target ? e.target : related),
    toNode = node(to, to === target ? e.target : related);
  const fire = (list: Fiber[], name: string, tgt: Any, rel: Any): void => {
    let syn: Any = null;
    for (let ix = 0, xs = list; ix < xs.length; ix++) {
      const f = xs[ix]!;
      const fn = f.p[name];
      if (typeof fn !== "function") {
        if (fn) throw badListener(name, fn);
        continue;
      }
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
 * The listener for a non-bubbling event on its own element: call the handlers on its fiber path,
 * innermost first, as React does (only scroll and scrollend stay on the target). One shared
 * function, so adding it allocates nothing.
 */
function direct(this: Any, e: Any): void {
  const f: Fiber | undefined = this[FIBER];
  const name = PROP_OF.get(e.type);
  if (f === undefined || name === undefined || f.f & DEAD) return;
  const path: Any[] = [];
  if (e.type === "scroll" || e.type === "scrollend") {
    const h = f.p[name];
    if (typeof h === "function") path.push(this, h);
    else if (h) throw badListener(name, h);
  } else handlersOn(f, name, e.target, path);
  if (path.length === 0) return;
  batch++;
  try {
    const syn = synthetic(e, name);
    for (let q = 0; q < path.length; q += 2) {
      if (syn._stopped) break;
      syn.currentTarget = path[q];
      path[q + 1](syn);
    }
    syn.currentTarget = null;
  } finally {
    if (--batch === 0) afterEvent(undefined);
  }
}

/** Listen for non-bubbling event `type` on `dom` itself, once. */
function listenOwn(dom: Any, type: string): void {
  const set: Set<string> = (dom[LISTENS] ??= new Set<string>());
  if (set.has(type)) return;
  set.add(type);
  dom.addEventListener(type, direct);
}

// The non-bubbling events React listens for on each element it creates, by tag.
const MEDIA =
  "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart " +
  "pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting";
const LISTENS_FOR: Record<string, Set<string>> = {};
for (const [tags, types] of [
  ["IMG image EMBED SOURCE LINK", "error load"],
  ["IFRAME OBJECT", "load"],
  ["VIDEO AUDIO", MEDIA],
  ["DIALOG", "beforetoggle toggle cancel close"],
  ["DETAILS", "toggle"],
  ["INPUT SELECT TEXTAREA", "invalid"],
] as const) {
  const set = new Set(types.split(" "));
  for (const t of tags.split(" ")) LISTENS_FOR[t] = set;
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
    this._prevented = true;
  },
  stopPropagation(this: Any): void {
    this.nativeEvent.stopPropagation();
    this._stopped = true;
  },
  // True once preventDefault was called, though the native event cannot be canceled.
  isDefaultPrevented(this: Any): boolean {
    return this._prevented;
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
  for (const k of eventFields(e)) {
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
      set: setOwn(k),
    });
  }
  if ("keyCode" in e && "charCode" in e) {
    for (const [k, get] of Object.entries(KEYBOARD)) {
      Object.defineProperty(p, k, { configurable: true, enumerable: true, get, set: setOwn(k) });
    }
  }
  synProtos.set(e.constructor, p);
  return p;
}

/**
 * The names of native event `e`'s fields: its enumerable ones and every one its prototypes
 * define. An event built with Object.defineProperty can hold a field as its own without
 * enumerating it, which hides the prototype's from a for-in.
 */
function eventFields(e: Any): Set<string> {
  const names = new Set<string>();
  for (const k in e) names.add(k);
  for (let o = Object.getPrototypeOf(e); o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== "constructor") names.add(k);
  }
  return names;
}

/** A setter for field `k`: a handler or the runtime may set a field, which becomes the event's own. */
function setOwn(k: string): (this: Any, v: Any) => void {
  return function (this: Any, v: Any): void {
    Object.defineProperty(this, k, { value: v, writable: true, configurable: true, enumerable: true });
  };
}

// React's keyboard fields: keyCode on keydown and keyup, charCode on keypress, which for either,
// and key names normalized (Esc is Escape), or derived when the browser gives none.
const KEYBOARD: Record<string, (this: Any) => Any> = {
  key(this: Any): string {
    const n = this.nativeEvent;
    if (n.key) {
      const k: string = NORMALIZED_KEY[n.key] ?? n.key;
      if (k !== "Unidentified") return k;
    }
    if (n.type === "keypress") {
      const c = charCodeOf(n);
      return c === 13 ? "Enter" : String.fromCharCode(c);
    }
    return n.type === "keydown" || n.type === "keyup" ? (KEY_OF_CODE[keyCodeOf(n)] ?? "Unidentified") : "";
  },
  keyCode(this: Any): number {
    return keyCodeOf(this.nativeEvent);
  },
  charCode(this: Any): number {
    const n = this.nativeEvent;
    return n.type === "keypress" ? charCodeOf(n) : 0;
  },
  which(this: Any): number {
    const n = this.nativeEvent;
    return n.type === "keypress" ? charCodeOf(n) : keyCodeOf(n);
  },
};

/** A keydown's or keyup's key code; 0 for other events, as React reads it. */
function keyCodeOf(n: Any): number {
  return n.type === "keydown" || n.type === "keyup" ? n.keyCode : 0;
}

/** A keypress's character code as React reads it: Enter is 13, and control characters are 0. */
function charCodeOf(n: Any): number {
  let c: number = n.charCode;
  if (c === 0 && n.keyCode === 13) c = 13;
  if (c === 10) c = 13;
  return c >= 32 || c === 13 ? c : 0;
}

// Older key names and their standard ones, as React maps them.
const NORMALIZED_KEY: Record<string, string> = {
  Esc: "Escape",
  Spacebar: " ",
  Left: "ArrowLeft",
  Up: "ArrowUp",
  Right: "ArrowRight",
  Down: "ArrowDown",
  Del: "Delete",
  Win: "OS",
  Menu: "ContextMenu",
  Apps: "ContextMenu",
  Scroll: "ScrollLock",
  MozPrintableKey: "Unidentified",
};
// Key names for key codes, for keydown and keyup events whose key the browser left unidentified.
const KEY_OF_CODE: Record<number, string> = {
  8: "Backspace",
  9: "Tab",
  12: "Clear",
  13: "Enter",
  16: "Shift",
  17: "Control",
  18: "Alt",
  19: "Pause",
  20: "CapsLock",
  27: "Escape",
  32: " ",
  33: "PageUp",
  34: "PageDown",
  35: "End",
  36: "Home",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  45: "Insert",
  46: "Delete",
  112: "F1",
  113: "F2",
  114: "F3",
  115: "F4",
  116: "F5",
  117: "F6",
  118: "F7",
  119: "F8",
  120: "F9",
  121: "F10",
  122: "F11",
  123: "F12",
  144: "NumLock",
  145: "ScrollLock",
  224: "Meta",
};

/** A synthetic event over `e` for prop `name`. Its own fields are set in one fixed order. */
function synthetic(e: Any, name: string): Any {
  const s = Object.create(synProto(e));
  s.nativeEvent = e;
  s.currentTarget = null;
  s._stopped = false;
  const dp = e.defaultPrevented;
  s._prevented = dp != null ? !!dp : e.returnValue === false;
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
  if (t === "select") return setSelect(dom, p, null, false);
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

// React's resource hints: the public functions check their options as react-dom's do, and the
// rest follows its client dispatcher (preconnectAs, preload, preloadModule, preinitStyle,
// preinitScript, preinitModuleScript). Each URL is hinted once per document; React keeps that per
// module, for the one document it serves. Without a document (a server import) nothing happens.

/** What a document was given: preconnects, stylesheets and scripts by key, preloads' props. */
interface Hinted {
  keys: Set<string>;
  preloads: Map<string, Any>;
}
const hinted = new WeakMap<object, Hinted>();
// Once @reactre/compat/server renders, its resource dispatcher: a hint a request takes goes to the
// HTML it writes (the dispatcher returns true); the others are the client's.
let serverHints: Any = null;
/** Internal (@reactre/compat/server): the server's resource dispatcher, or null. */
export function __serverHints(d: Any): void {
  serverHints = d;
}
function hintsOf(d: Any): Hinted {
  let h = hinted.get(d);
  if (h === undefined) hinted.set(d, (h = { keys: new Set(), preloads: new Map() }));
  return h;
}
const doc = (): Any => (typeof document === "undefined" ? null : document);
// React's escape for a value inside a double-quoted attribute selector.
const escAttr = (v: string): string => v.replace(/[\n"\\]/g, (c) => "\\" + c.charCodeAt(0).toString(16) + " ");
const styleKey = (href: string): string => `href="${escAttr(href)}"`;
const styleSel = (key: string): string => `link[rel="stylesheet"][${key}]`;
const scriptKey = (src: string): string => `[src="${escAttr(src)}"]`;
const scriptSel = (key: string): string => "script[async]" + key;
const str = (v: Any): string | undefined => (typeof v === "string" ? v : undefined);
// A font is always fetched with CORS; any other crossOrigin string but "use-credentials" is "".
const crossOriginAs = (as: Any, v: Any): string | undefined =>
  as === "font" ? "" : typeof v === "string" ? (v === "use-credentials" ? v : "") : undefined;
// The module preloads that are keyed as scripts.
const SCRIPT_LIKE = new Set(["audioworklet", "paintworklet", "serviceworker", "sharedworker", "worker", "script"]);

/** A new element with its props set as React sets an element's (missing ones skipped). */
function hintElement(d: Any, tag: string, props: Any): Any {
  const el = d.createElement(tag);
  const info = { ns: HTML_NS, t: tag } as Any;
  for (const k in props) if (props[k] != null) setAttr(info, el, k, props[k], undefined);
  return el;
}

function preconnectAs(rel: string, href: string, crossOrigin: string | null | undefined): void {
  if (serverHints?.[rel](href, crossOrigin)) return;
  const d = doc();
  if (d === null || !href) return;
  let sel = `link[rel="${rel}"][href="${escAttr(href)}"]`;
  if (typeof crossOrigin === "string") sel += `[crossorigin="${crossOrigin}"]`;
  const h = hintsOf(d);
  if (h.keys.has(sel)) return;
  h.keys.add(sel);
  if (d.querySelector(sel) === null) d.head.appendChild(hintElement(d, "link", { rel, crossOrigin, href }));
}

/** Adds `<link rel="preconnect">`, once per URL and crossOrigin. */
export function preconnect(href: string, opts?: Any): void {
  if (typeof href !== "string") return;
  const c = opts ? opts.crossOrigin : undefined;
  preconnectAs(
    "preconnect",
    href,
    opts ? (typeof c === "string" ? (c === "use-credentials" ? c : "") : undefined) : null,
  );
}
/** Adds `<link rel="dns-prefetch">`, once per URL. */
export function prefetchDNS(href: string): void {
  if (typeof href === "string") preconnectAs("dns-prefetch", href, null);
}
/** Adds `<link rel="preload">` for a resource of type `opts.as`, once per resource. */
export function preload(href: string, opts?: Any): void {
  if (typeof href !== "string" || typeof opts !== "object" || opts === null || typeof opts.as !== "string") return;
  const as: string = opts.as;
  const o = {
    crossOrigin: crossOriginAs(as, opts.crossOrigin),
    integrity: str(opts.integrity),
    nonce: str(opts.nonce),
    type: str(opts.type),
    fetchPriority: str(opts.fetchPriority),
    referrerPolicy: str(opts.referrerPolicy),
    imageSrcSet: str(opts.imageSrcSet),
    imageSizes: str(opts.imageSizes),
    media: str(opts.media),
  };
  if (serverHints?.L(href, as, o)) return;
  const d = doc();
  if (d === null || !href || !as) return;
  // An image with a srcset is known by it, not by its href.
  const bySet = as === "image" && !!o.imageSrcSet;
  let sel = `link[rel="preload"][as="${escAttr(as)}"]`;
  if (bySet) {
    sel += `[imagesrcset="${escAttr(o.imageSrcSet!)}"]`;
    if (o.imageSizes !== undefined) sel += `[imagesizes="${escAttr(o.imageSizes)}"]`;
  } else sel += `[href="${escAttr(href)}"]`;
  const key = as === "style" ? styleKey(href) : as === "script" ? scriptKey(href) : sel;
  const h = hintsOf(d);
  if (h.preloads.has(key)) return;
  const props = { rel: "preload", href: bySet ? undefined : href, as, ...o };
  h.preloads.set(key, props);
  if (
    d.querySelector(sel) !== null ||
    (as === "style" && d.querySelector(styleSel(key)) !== null) ||
    (as === "script" && d.querySelector(scriptSel(key)) !== null)
  )
    return;
  d.head.appendChild(hintElement(d, "link", props));
}
/** Adds `<link rel="modulepreload">`, once per module. */
export function preloadModule(href: string, opts?: Any): void {
  if (typeof href !== "string") return;
  const o = opts
    ? {
        as: typeof opts.as === "string" && opts.as !== "script" ? (opts.as as string) : undefined,
        crossOrigin: crossOriginAs(opts.as, opts.crossOrigin),
        integrity: str(opts.integrity),
        nonce: str(opts.nonce),
        fetchPriority: str(opts.fetchPriority),
      }
    : undefined;
  if (serverHints?.m(href, o)) return;
  const d = doc();
  if (d === null || !href) return;
  const as = o?.as ?? "script";
  const sel = `link[rel="modulepreload"][as="${escAttr(as)}"][href="${escAttr(href)}"]`;
  const scriptLike = SCRIPT_LIKE.has(as);
  const key = scriptLike ? scriptKey(href) : sel;
  const h = hintsOf(d);
  if (h.preloads.has(key)) return;
  const props = { rel: "modulepreload", href, ...o };
  h.preloads.set(key, props);
  if (d.querySelector(sel) !== null || (scriptLike && d.querySelector(scriptSel(key)) !== null)) return;
  d.head.appendChild(hintElement(d, "link", props));
}
/** Loads a stylesheet (`as: "style"`, ordered by `precedence`) or a script now, once per URL. */
export function preinit(href: string, opts?: Any): void {
  if (typeof href !== "string" || !opts || typeof opts.as !== "string") return;
  const as = opts.as,
    crossOrigin = crossOriginAs(as, opts.crossOrigin),
    integrity = str(opts.integrity),
    fetchPriority = str(opts.fetchPriority);
  if (as === "style") preinitStyle(href, str(opts.precedence), { crossOrigin, integrity, fetchPriority });
  else if (as === "script")
    preinitScript(href, { crossOrigin, integrity, fetchPriority, nonce: str(opts.nonce) }, false);
}
/** Loads a module script now, once per URL. */
export function preinitModule(href: string, opts?: Any): void {
  if (typeof href !== "string") return;
  if (typeof opts === "object" && opts !== null) {
    if (opts.as == null || opts.as === "script")
      preinitScript(
        href,
        {
          crossOrigin: crossOriginAs(opts.as, opts.crossOrigin),
          integrity: str(opts.integrity),
          nonce: str(opts.nonce),
          fetchPriority: str(opts.fetchPriority),
        },
        true,
      );
  } else if (opts == null) preinitScript(href, undefined, true);
}

function preinitStyle(href: string, precedence: string | undefined, o: Any): void {
  if (serverHints?.S(href, precedence, o)) return;
  const d = doc();
  if (d === null || !href) return;
  const key = styleKey(href),
    h = hintsOf(d);
  if (h.keys.has("style" + key)) return;
  h.keys.add("style" + key);
  if (d.querySelector(styleSel(key)) !== null) return;
  const prec = precedence || "default";
  const props: Any = { rel: "stylesheet", href, "data-precedence": prec, ...o };
  // A preload of the same stylesheet lends what this call did not give.
  const pre = h.preloads.get(key);
  if (pre !== undefined) {
    props.crossOrigin ??= pre.crossOrigin;
    props.referrerPolicy ??= pre.referrerPolicy;
    props.title ??= pre.title;
  }
  insertStylesheet(d, hintElement(d, "link", props), prec);
}

function preinitScript(src: string, o: Any, module: boolean): void {
  if (serverHints?.X(src, o, module)) return;
  const d = doc();
  if (d === null || !src) return;
  const key = scriptKey(src),
    h = hintsOf(d);
  if (h.keys.has("script" + key)) return;
  h.keys.add("script" + key);
  if (d.querySelector(scriptSel(key)) !== null) return;
  const props: Any = module ? { src, async: true, type: "module", ...o } : { src, async: true, ...o };
  const pre = h.preloads.get(key);
  if (pre !== undefined) {
    props.crossOrigin ??= pre.crossOrigin;
    props.referrerPolicy ??= pre.referrerPolicy;
    props.integrity ??= pre.integrity;
  }
  d.head.appendChild(hintElement(d, "script", props));
}

/** After the last stylesheet of the same precedence, else after all of them, else first in <head>. */
function insertStylesheet(d: Any, el: Any, prec: string): void {
  const nodes = d.querySelectorAll('link[rel="stylesheet"][data-precedence],style[data-precedence]');
  const last = nodes.length ? nodes[nodes.length - 1] : null;
  let prior = last;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute("data-precedence") === prec) prior = nodes[i];
    else if (prior !== last) break;
  }
  if (prior !== null) prior.parentNode.insertBefore(el, prior.nextSibling);
  else d.head.insertBefore(el, d.head.firstChild);
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
  browser,
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
