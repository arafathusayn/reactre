// preact/compat 11.1.0, ported: React's API on Preact's semantics. Loading it installs, as
// preact/compat does, a vnode hook that maps React's host props to Preact's (className to class,
// onChange on text fields to onInput, numbers in style to px), an event hook that gives events
// React's few extra methods, and React's names for the unsafe class lifecycles.
//
// Rendering stays Preact's: renders are batched to a microtask, startTransition runs its
// callback at once, Suspense hides its children while a promise is pending, and an error goes to
// the nearest componentDidCatch or getDerivedStateFromError.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { hydrate as preactHydrate } from "./claim.ts";
import {
  type Any,
  assign,
  blockHooks,
  cloneElement as preactCloneElement,
  Component,
  COMPONENT_FORCE,
  createContext,
  createElement,
  createPortal as preactCreatePortal,
  createRef,
  FORCE_PROPS_REVALIDATE,
  Fragment,
  MODE_HYDRATE,
  options,
  REF_DETACHED,
  render as preactRender,
  toChildArray,
  VNODE_MARKER,
} from "./engine.ts";
import {
  useCallback,
  useContext,
  useDebugValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "./hooks.ts";

export * from "./hooks.ts";

// #region Elements and host props

export const REACT_ELEMENT_TYPE: symbol = Symbol.for("react.element");
blockHooks.s = REACT_ELEMENT_TYPE;

let currentComponent: Any, hydrationRoot: Any, renderTrackingInitialized: Any;

// SVG presentation attributes written in camelCase in React: strokeWidth is stroke-width.
const CAMEL_PROPS =
  /^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(?!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/;
const CAMEL_REPLACE = /[A-Z0-9]/g;
const IS_DOM = typeof document < "u";
/** CSS properties whose numbers have no unit (React's list). */
const IS_NON_DIMENSIONAL =
  /^(-|f[lo].*[^se]$|g.{5,}[^ps]$|z|o[pr]|(W.{5})?[lL]i.*(t|mp)$|an|(bo|s).{4}Im|sca|m.{6}[ds]|ta|c.*[st]$|wido|ini|asp|fill|st)/;

const onChangeInputType = (type: Any): boolean => /fil|che|rad/.test(type);

/** Shallow inequality of two props or state objects. */
function shallowDiffers(a: Any, b: Any): boolean {
  for (const i in a) if (i != "__source" && a[i] !== b[i]) return true;
  for (const i in b) if (i != "__source" && !(i in a)) return true;
  return false;
}

Component.prototype.isReactComponent = true;

// React's UNSAFE_ names for the legacy lifecycles: a class defining UNSAFE_componentWillMount
// gets componentWillMount, and assigning the plain name still works.
["componentWillMount", "componentWillReceiveProps", "componentWillUpdate"].forEach((key) => {
  Object.defineProperty(Component.prototype, key, {
    configurable: true,
    get(this: Any) {
      return this["UNSAFE_" + key];
    },
    set(this: Any, v: Any) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value: v });
    },
  });
});

const oldEventHook = options.event;
options.event = (e: Any) => {
  if (oldEventHook) e = oldEventHook(e);
  e.persist = () => {};
  e.isPropagationStopped = function isPropagationStopped(this: Any) {
    return this.cancelBubble;
  };
  e.isDefaultPrevented = function isDefaultPrevented(this: Any) {
    return this.defaultPrevented;
  };
  return (e.nativeEvent = e);
};

const classNameDescriptorNonEnumberable = {
  configurable: true,
  get(this: Any) {
    return this.class;
  },
};

/** A host event prop's name in Preact: the renames below, the rest as written. */
function eventName(i: string, type: string, props: Any, taken: Any): string {
  let lowerCased = i.toLowerCase();
  if (lowerCased == "ondoubleclick") i = "ondblclick";
  else if (lowerCased == "onchange" && (type == "input" || type == "textarea") && !onChangeInputType(props.type))
    lowerCased = i = "oninput";
  else if (lowerCased == "onfocus") i = "onfocusin";
  else if (lowerCased == "onblur") i = "onfocusout";
  if (lowerCased == "oninput") {
    i = lowerCased;
    // onInput and onChange both set: the second listens in the capture phase.
    if (taken && taken[i]) i = "oninputCapture";
  }
  return i;
}

/** A style object with px added to its unitless numbers, or the object itself when none. */
function pxStyle(value: Any): Any {
  let cloned;
  for (const key in value) {
    if (typeof value[key] == "number" && !IS_NON_DIMENSIONAL.test(key)) {
      if (!cloned) cloned = value = assign({}, value);
      value[key] += "px";
    }
  }
  return value;
}

/** Rewrite a host vnode's props from React's names and values to Preact's. */
function handleDomVNode(vnode: Any): void {
  const props = vnode.props,
    type = vnode.type,
    normalizedProps: Any = {},
    isNonDashedType = type.indexOf("-") == -1;
  for (let i in props) {
    let value = props[i];
    if (
      (i == "value" && "defaultValue" in props && value == null) ||
      // A noscript's children are text the browser shows only without scripts.
      (IS_DOM && i == "children" && type == "noscript") ||
      i == "class" ||
      i == "className"
    )
      continue;
    if (i == "style" && value && value.constructor == Object) value = pxStyle(value);
    else if (i == "defaultValue" && "value" in props && props.value == null) i = "value";
    else if (i == "download" && value === true) value = "";
    else if (i == "translate" && value === "no") value = false;
    else if (i[0] == "o" && i[1] == "n") i = eventName(i, type, props, normalizedProps);
    else if (isNonDashedType && CAMEL_PROPS.test(i)) i = i.replace(CAMEL_REPLACE, "-$&").toLowerCase();
    else if (value === null) value = undefined;
    normalizedProps[i] = value;
  }

  // A select's value (and defaultValue) selects its options.
  if (type == "select") {
    if (normalizedProps.multiple && Array.isArray(normalizedProps.value)) {
      normalizedProps.value = toChildArray(props.children).forEach((child: Any) => {
        child.props.selected = normalizedProps.value.indexOf(child.props.value) != -1;
      });
    }
    if (normalizedProps.defaultValue != null) {
      normalizedProps.value = toChildArray(props.children).forEach((child: Any) => {
        if (normalizedProps.multiple)
          child.props.selected = normalizedProps.defaultValue.indexOf(child.props.value) != -1;
        else child.props.selected = normalizedProps.defaultValue == child.props.value;
      });
    }
  }

  if (props.class && !props.className) {
    normalizedProps.class = props.class;
    Object.defineProperty(normalizedProps, "className", classNameDescriptorNonEnumberable);
  } else if (props.className) normalizedProps.class = normalizedProps.className = props.className;
  vnode.props = normalizedProps;
}

// The same rules for a compiled template's props, which never pass through the vnode hook.
// Template tags are never form fields, custom elements or noscript (the compiler leaves those
// to plain vnodes), so the rules that depend on them do not arise.
blockHooks.n = (i: string): string =>
  i == "className"
    ? "class"
    : i[0] == "o" && i[1] == "n"
      ? eventName(i, "", {}, null)
      : CAMEL_PROPS.test(i)
        ? i.replace(CAMEL_REPLACE, "-$&").toLowerCase()
        : i;
blockHooks.v = (i: string, value: Any): Any =>
  i == "style" && value && value.constructor == Object
    ? pxStyle(value)
    : i == "download" && value === true
      ? ""
      : i == "translate" && value === "no"
        ? false
        : value === null && !(i[0] == "o" && i[1] == "n")
          ? undefined
          : value;

const oldVNodeHook = options.vnode;
options.vnode = (vnode: Any) => {
  if (typeof vnode.type == "string") handleDomVNode(vnode);
  else if (typeof vnode.type == "function") {
    // A class gets the ref; a function component sees it as a prop.
    const shouldApplyRef = "prototype" in vnode.type && vnode.type.prototype.render;
    if ("ref" in vnode.props && shouldApplyRef) {
      vnode.ref = vnode.props.ref;
      delete vnode.props.ref;
    }
    if (vnode.type.defaultProps) {
      const normalizedProps = assign({}, vnode.props);
      for (const i in vnode.type.defaultProps)
        if (normalizedProps[i] === undefined) normalizedProps[i] = vnode.type.defaultProps[i];
      vnode.props = normalizedProps;
    }
  }
  if (vnode.ref && !("ref" in vnode.props))
    Object.defineProperty(vnode.props, "ref", { value: vnode.ref, configurable: true, writable: true });
  vnode.$$typeof = REACT_ELEMENT_TYPE;
  if (oldVNodeHook) oldVNodeHook(vnode);
};

/** Track the component rendering, for `use` and useSyncExternalStore; installed on first use. */
function initRenderTracking<T>(value: T): T {
  if (!renderTrackingInitialized) {
    renderTrackingInitialized = true;
    const oldBeforeRender = options.__r;
    options.__r = (vnode: Any) => {
      if (oldBeforeRender) oldBeforeRender(vnode);
      if (vnode.__u & MODE_HYDRATE) hydrationRoot = vnode;
      currentComponent = vnode.__c;
    };
    const oldDiffed = options.diffed;
    options.diffed = (vnode: Any) => {
      if (oldDiffed) oldDiffed(vnode);
      currentComponent = null;
      if (hydrationRoot == vnode) hydrationRoot = null;
    };
  }
  return value;
}

// #endregion

// #region Rendering

/** React's legacy render: clears the container the first time, returns the root component. */
export function render(vnode: Any, parent: Any, callback?: Any): Any {
  if (parent.__k == null) parent.textContent = "";
  preactRender(vnode, parent);
  if (typeof callback == "function") callback();
  return vnode ? vnode.__c : null;
}

/** React's legacy hydrate. */
export function hydrate(vnode: Any, parent: Any, callback?: Any): Any {
  preactHydrate(vnode, parent);
  if (typeof callback == "function") callback();
  return vnode ? vnode.__c : null;
}

/** react-dom/client's createRoot, on Preact's render. */
export function createRoot(container: Any): { render(children: Any): void; unmount(): void } {
  return {
    render(children: Any) {
      render(children, container);
    },
    unmount() {
      unmountComponentAtNode(container);
    },
  };
}

/** react-dom/client's hydrateRoot. */
export function hydrateRoot(container: Any, children: Any): { render(children: Any): void; unmount(): void } {
  hydrate(children, container);
  return createRoot(container);
}

/** Unmount what render put in `container`; whether there was anything. */
export function unmountComponentAtNode(container: Any): boolean {
  if (container.__k) {
    preactRender(null, container);
    return true;
  }
  return false;
}

/** A component's DOM node (or a DOM node itself). */
export function findDOMNode(component: Any): Any {
  return (component && ((component.__v && component.__v.__e) || (component.nodeType == 1 && component))) || null;
}

/** Run `callback` and render what it queued before returning. */
export const flushSync = (callback: Any, arg?: Any): Any => {
  const prevDebounce = options.debounceRendering;
  let flush: Any;
  options.debounceRendering = (cb: Any) => {
    flush = cb;
  };
  try {
    const res = callback(arg);
    if (flush) flush();
    return res;
  } finally {
    options.debounceRendering = prevDebounce;
  }
};

/** Preact batches every update already. */
export function unstable_batchedUpdates(callback: Any, arg?: Any): Any {
  return callback(arg);
}

/** A portal; `containerInfo` as React's. */
export function createPortal(vnode: Any, container: Any): Any {
  const el = preactCreatePortal(vnode, container);
  el.containerInfo = container;
  return el;
}

// #endregion

// #region Element helpers

export const version = "19.0.0";

/** createElement bound to `type`. */
export function createFactory(type: Any): Any {
  return createElement.bind(null, type);
}

/** Whether `element` is an element of this compat (React's $$typeof). */
export function isValidElement(element: Any): boolean {
  return !!element && element.$$typeof === REACT_ELEMENT_TYPE;
}

export function isFragment(element: Any): boolean {
  return isValidElement(element) && element.type == Fragment;
}

export function isMemo(element: Any): boolean {
  return !!element && typeof element.displayName == "string" && element.displayName.indexOf("Memo(") == 0;
}

/** cloneElement; anything not an element comes back as it is. */
export function cloneElement(element: Any, ...rest: Any[]): Any {
  if (!isValidElement(element)) return element;
  return (preactCloneElement as Any)(element, ...rest);
}

const mapFn = (children: Any, fn: Any, context?: Any): Any => {
  if (children == null) return null;
  return toChildArray(toChildArray(children).map(fn.bind(context)));
};

/** React.Children on Preact's child arrays. */
export const Children: Any = {
  map: mapFn,
  forEach: mapFn,
  count(children: Any) {
    return children ? toChildArray(children).length : 0;
  },
  only(children: Any) {
    const normalized = toChildArray(children);
    if (normalized.length != 1) throw "Children.only";
    return normalized[0];
  },
  toArray: toChildArray,
};

// #endregion

// #region Components

/** A class component that renders only when props or state shallowly changed. */
export const PureComponent: Any = /* @__PURE__ */ (() => {
  function PureComponent(this: Any, p: Any, c: Any) {
    this.props = p;
    this.context = c;
  }
  PureComponent.prototype = new (Component as Any)();
  PureComponent.prototype.isPureReactComponent = true;
  PureComponent.prototype.shouldComponentUpdate = function (this: Any, props: Any, state: Any) {
    return shallowDiffers(this.props, props) || shallowDiffers(this.state, state);
  };
  return PureComponent;
})();

/** Preact's memo: a component that renders `c` only when its props changed (shallowly, or by `comparer`). */
export function memo(c: Any, comparer?: Any): Any {
  function shouldUpdate(this: Any, nextProps: Any) {
    const ref = this.props.ref;
    if (ref != nextProps.ref && ref) typeof ref == "function" ? ref(null) : (ref.current = null);
    return comparer ? !comparer(this.props, nextProps) || ref != nextProps.ref : shallowDiffers(this.props, nextProps);
  }
  function Memoed(this: Any, props: Any) {
    this.shouldComponentUpdate = shouldUpdate;
    return createElement(c, props);
  }
  Memoed.displayName = "Memo(" + (c.displayName || c.name) + ")";
  Memoed.prototype.isReactComponent = true;
  Memoed.type = c;
  return Memoed;
}

export const REACT_FORWARD_SYMBOL: symbol = Symbol.for("react.forward_ref");

/** Pass the `ref` prop to `fn` as its second argument. */
export function forwardRef(fn: Any): Any {
  function Forwarded(props: Any) {
    const clone = assign({}, props);
    delete clone.ref;
    return fn(clone, props.ref || null);
  }
  Forwarded.$$typeof = REACT_FORWARD_SYMBOL;
  Forwarded.render = fn;
  Forwarded.prototype.isReactComponent = true;
  Forwarded.displayName = "ForwardRef(" + (fn.displayName || fn.name) + ")";
  return Forwarded;
}

// #endregion

// #region Hooks React has and Preact's hooks do not

/** No transitions in Preact: the callback runs at once. */
export function startTransition(cb: Any): void {
  cb();
}

export function useDeferredValue<T>(val: T): T {
  return val;
}

export function useTransition(): [boolean, typeof startTransition] {
  return [false, startTransition];
}

export const useInsertionEffect: typeof useLayoutEffect = useLayoutEffect;

/** A stable function that calls the latest `callback`. */
export function useEffectEvent<T extends (...a: Any[]) => Any>(callback: T): T {
  const ref = useRef(callback);
  ref.current = callback;
  return function (this: Any) {
    // biome-ignore lint: forwards its arguments.
    return ref.current.apply(undefined, arguments as Any);
  } as T;
}

/** React's useSyncExternalStore, on useState and effects. */
export const useSyncExternalStore: Any = /* @__PURE__ */ initRenderTracking(function useSyncExternalStore(
  subscribe: Any,
  getSnapshot: Any,
  getServerSnapshot?: Any,
) {
  const serverRendering = options.__s || hydrationRoot;
  const value = serverRendering ? (getServerSnapshot || getSnapshot)() : getSnapshot();
  const [{ _instance }, forceUpdate] = useState<Any>({ _instance: { __: value, getSnapshot } });
  useLayoutEffect(() => {
    _instance.__ = value;
    _instance.getSnapshot = getSnapshot;
    if (didSnapshotChange(_instance)) forceUpdate({ _instance });
  }, [subscribe, value, getSnapshot]);
  useEffect(() => {
    if (didSnapshotChange(_instance)) forceUpdate({ _instance });
    return subscribe(() => {
      if (didSnapshotChange(_instance)) forceUpdate({ _instance });
    });
  }, [subscribe]);
  return value;
});

function didSnapshotChange(inst: Any): boolean {
  try {
    return !Object.is(inst.__, inst.getSnapshot());
  } catch (_error) {
    return true;
  }
}

/** React's `use`: a promise's value (suspending while pending), or a context's. */
export const use: Any = /* @__PURE__ */ initRenderTracking(function use(resource: Any) {
  if (resource.then) {
    if (resource.status == "fulfilled") return resource.value;
    if (resource.status == "rejected") throw resource.reason;
    if (!resource.status) {
      resource.status = "pending";
      resource.then(
        (value: Any) => {
          resource.status = "fulfilled";
          resource.value = value;
        },
        (reason: Any) => {
          resource.status = "rejected";
          resource.reason = reason;
        },
      );
    }
    throw resource;
  }
  const id = resource.__c;
  const provider = currentComponent.__n[id];
  if (!provider) return resource.__;
  if (!currentComponent[id]) {
    currentComponent[id] = true;
    provider.sub(currentComponent);
  }
  return provider.props.value;
});

// #endregion

// #region Suspense and lazy

/** Install Suspense's error and unmount hooks; runs when Suspense is first used. */
function initSuspenseHooks(): void {
  const oldCatchError = options.__e;
  options.__e = (error: Any, newVNode: Any, oldVNode: Any, errorInfo: Any) => {
    if (error.then) {
      let component;
      let vnode = newVNode;
      while ((vnode = vnode.__)) {
        if ((component = vnode.__c) && component.__c) {
          // A component suspending on its first render starts over with fresh hooks.
          if (oldVNode && !oldVNode.__c) newVNode.__c.__H = undefined;
          return component.__c(error, newVNode);
        }
      }
    }
    oldCatchError(error, newVNode, oldVNode, errorInfo);
  };
  const oldUnmount = options.unmount;
  options.unmount = (vnode: Any) => {
    const component = vnode.__c;
    if (component && component.__R) component.__R();
    if (oldUnmount) oldUnmount(vnode);
  };
}

/** A copy of the suspended subtree with its components moved to `detachedParent`. */
function detachedClone(vnode: Any, detachedParent: Any, parentDom: Any): Any {
  if (vnode) {
    const hooks = vnode.__c && vnode.__c.__H;
    if (hooks) {
      hooks.__.forEach((effect: Any) => {
        if (effect.__P != null) {
          if (typeof effect.__c == "function") effect.__c();
          effect.__c = effect.__H = undefined;
        }
      });
      hooks.__h = vnode.__c.__h = [];
    }
    if (typeof vnode.type == "string") vnode.__u |= REF_DETACHED;
    vnode = assign({ constructor: VNODE_MARKER }, vnode);
    if (vnode.__c != null) {
      if (vnode.__c.__P == parentDom) vnode.__c.__P = detachedParent;
      vnode.__c.__g |= COMPONENT_FORCE;
      vnode.__c = vnode.ref = null;
    }
    vnode.__k = vnode.__k && vnode.__k.map((child: Any) => detachedClone(child, detachedParent, parentDom));
  }
  return vnode;
}

/** Move a resolved subtree's DOM back from `detachedParent` to `originalParent`. */
function removeOriginal(vnode: Any, detachedParent: Any, originalParent: Any): Any {
  if (vnode && originalParent) {
    if (typeof vnode.type == "string") vnode.__u |= FORCE_PROPS_REVALIDATE;
    vnode.__v = null;
    vnode.__k = vnode.__k && vnode.__k.map((child: Any) => removeOriginal(child, detachedParent, originalParent));
    if (vnode.__c) {
      if (vnode.__c.__P == detachedParent) {
        if (vnode.__e) originalParent.appendChild(vnode.__e);
        vnode.__c.__g |= COMPONENT_FORCE;
        vnode.__c.__P = originalParent;
      }
    }
  }
  return vnode;
}

/**
 * Preact's Suspense. Field legend: __u pending suspensions, __b suspenders, __a subtree to detach
 * on the next render, __c the child-suspended handler, __R a suspender's resolve callback, __O
 * a component's original parent DOM, state.__a the suspended subtree.
 */
export const Suspense: Any = /* @__PURE__ */ (() => {
  initSuspenseHooks();
  function Suspense(this: Any) {
    this.__u = 0;
    this.__b = null;
    this.__a = null;
  }
  Suspense.prototype = new (Component as Any)();
  Suspense.prototype.__c = function (this: Any, promise: Any, suspendingVNode: Any) {
    const suspendingComponent = suspendingVNode.__c;
    if (this.__b == null) this.__b = [];
    this.__b.push(suspendingComponent);
    let resolved = false;
    const onResolved = () => {
      if (resolved || !this.__P) return;
      resolved = true;
      suspendingComponent.__R = null;
      onSuspensionComplete();
    };
    suspendingComponent.__R = onResolved;
    const originalParentDom = suspendingComponent.__P;
    suspendingComponent.__P = null;
    const onSuspensionComplete = () => {
      if (!--this.__u) {
        // Every suspender resolved: show the children again, their DOM moved back.
        if (this.state.__a) {
          const suspendedVNode = this.state.__a;
          this.__v.__k[0] = removeOriginal(suspendedVNode, suspendedVNode.__c.__P, suspendedVNode.__c.__O);
        }
        this.setState({ __a: (this.__a = null) });
        let suspended;
        while ((suspended = this.__b.pop())) {
          suspended.__P = originalParentDom;
          suspended.forceUpdate();
        }
      }
    };
    // The first suspension shows the fallback (not while hydrating: the server's DOM stays).
    if (!this.__u++ && !(suspendingVNode.__u & MODE_HYDRATE)) this.setState({ __a: (this.__a = this.__v.__k[0]) });
    promise.then(onResolved, onResolved);
  };
  Suspense.prototype.componentWillUnmount = function (this: Any) {
    this.__b = [];
    if (this.state.__a) this.__v.__k[0] = this.state.__a;
  };
  Suspense.prototype.render = function (this: Any, props: Any, state: Any) {
    if (this.__a) {
      // Park the suspended children's DOM in a detached div while the fallback shows.
      if (this.__v.__k) {
        const detachedParent = document.createElement("div");
        const detachedComponent = this.__v.__k[0].__c;
        this.__v.__k[0] = detachedClone(this.__a, detachedParent, (detachedComponent.__O = detachedComponent.__P));
      }
      this.__a = null;
    }
    return [
      createElement(Fragment, null, state.__a ? null : props.children),
      state.__a && createElement(Fragment, null, props.fallback),
    ];
  };
  return Suspense;
})();

/** A component loaded by `loader` on first render, suspending until it arrives. */
export function lazy(loader: Any): Any {
  let prom: Any;
  let component: Any = null;
  let error: Any;
  let resolved: Any;
  function Lazy(props: Any) {
    if (!prom) {
      prom = loader();
      prom.then(
        (exports: Any) => {
          if (exports) component = exports.default || exports;
          resolved = true;
        },
        (e: Any) => {
          error = e;
          resolved = true;
        },
      );
    }
    if (error) throw error;
    if (!resolved) throw prom;
    return component ? createElement(component, props) : null;
  }
  Lazy.displayName = "Lazy";
  return Lazy;
}

// #endregion

export const __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Any = {
  ReactCurrentDispatcher: {
    current: {
      readContext: use,
      useCallback,
      useContext,
      useDebugValue,
      useDeferredValue,
      useEffect,
      useId,
      useImperativeHandle,
      useInsertionEffect,
      useLayoutEffect,
      useMemo,
      useReducer,
      useRef,
      useState,
      useSyncExternalStore,
      useTransition,
    },
  },
};

export {
  Component,
  createContext,
  createElement,
  createRef,
  Fragment,
  isValidElement as isElement,
  Fragment as StrictMode,
};

export { __block, __template } from "./block.ts";
export { jsx, jsxDEV, jsxs } from "./jsx-runtime.ts";

/** React's default export: `import React from "react"`. */
// Typed for isolated declarations; the object is what `import React from "react"` gets.
const React: Record<string, Any> = {
  useState,
  useId,
  useReducer,
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useTransition,
  useDeferredValue,
  useSyncExternalStore,
  useEffectEvent,
  startTransition,
  useRef,
  useImperativeHandle,
  useMemo,
  useCallback,
  useContext,
  use,
  useDebugValue,
  version,
  Children,
  render,
  hydrate,
  unmountComponentAtNode,
  createPortal,
  createElement,
  createContext,
  createFactory,
  cloneElement,
  createRef,
  Fragment,
  isValidElement,
  isElement: isValidElement,
  isFragment,
  isMemo,
  findDOMNode,
  Component,
  PureComponent,
  memo,
  forwardRef,
  flushSync,
  unstable_batchedUpdates,
  StrictMode: Fragment,
  Suspense,
  lazy,
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,
};
export default React;
