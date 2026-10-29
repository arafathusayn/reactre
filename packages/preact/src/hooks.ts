// preact/hooks 11.1.0, ported: the hooks keep their state on the component (`__H`) and plug into
// rendering through `options`, as Preact's do. Loading this module installs them; an app that
// imports no hook ships none of this.
//
// Timing is Preact's: layout effects run in the commit, after refs; passive effects (src/
// effects.ts, bundled only with useEffect) run after the next frame, or before the component
// renders again, whichever is first.
//
// Field legend. Hooks: __ list, __h pending passive effects. A hook's state: __ value, __N next
// value, t reducer, __c component (useReducer) or cleanup (effects), __H args, u pending args,
// __P passive (an effect) or the error parent (an unmount cleanup), c context.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { type Any, options, slots } from "./engine.ts";

export { useEffect } from "./effects.ts";
export { useImperativeHandle, useLayoutEffect } from "./layout.ts";

const ObjectIs = Object.is;

let currentIndex: number;
let currentComponent: Any;
let previousComponent: Any;
/** The kind of hook being read, for `options.__h` (devtools). */
let currentHook = 0;

const oldBeforeDiff = options.__b;
const oldBeforeRender = options.__r;
const oldAfterDiff = options.diffed;
const oldRoot = options.__;


options.__b = (vnode: Any) => {
  currentComponent = null;
  if (oldBeforeDiff) oldBeforeDiff(vnode);
};

// A root rendered again keeps its useId counter.
options.__ = (vnode: Any, parentDom: Any) => {
  if (vnode && parentDom.__k && parentDom.__k.__m) vnode.__m = parentDom.__k.__m;
  if (oldRoot) oldRoot(vnode, parentDom);
};

options.__r = (vnode: Any) => {
  if (oldBeforeRender) oldBeforeRender(vnode);
  currentComponent = vnode.__c;
  currentIndex = 0;
  const hooks = currentComponent.__H;
  if (hooks) {
    if (previousComponent == currentComponent) {
      // Rendering again in the same pass (state set during render): drop the layout effects
      // the first pass queued.
      currentComponent.__h = [];
    } else {
      // Passive effects still pending from the last render run first.
      hooks.__h.some(invokeCleanup);
      hooks.__h.some(invokeEffect);
      currentIndex = 0;
    }
    hooks.__h = [];
    hooks.__.some((hookItem: Any) => {
      if (hookItem.__N) hookItem.__ = hookItem.__N;
      hookItem.u = hookItem.__N = undefined;
    });
  }
  previousComponent = currentComponent;
};

options.diffed = (vnode: Any) => {
  if (oldAfterDiff) oldAfterDiff(vnode);
  const c = vnode.__c;
  if (c && c.__H) {
    if (c.__H.__h.length) slots.p(c);
    c.__H.__.some((hookItem: Any) => {
      if (hookItem.u) hookItem.__H = hookItem.u;
    });
  }
  previousComponent = currentComponent = null;
};

/** The next hook's state in the component rendering, and the component. */
export function nextHook(type: number): [Any, Any] {
  return [getHookState(currentIndex++, type), currentComponent];
}

/** The state of hook `index` of the component rendering, created on first use. */
function getHookState(index: number, type: number): Any {
  if (options.__h) options.__h(currentComponent, index, currentHook || type);
  currentHook = 0;
  const hooks = currentComponent.__H || (currentComponent.__H = { __: [], __h: [] });
  if (index >= hooks.__.length) hooks.__.push({});
  return hooks.__[index];
}

/** Preact's useState: a useReducer whose action is the next state or an updater. */
export function useState<S>(initialState?: S | (() => S)): [S, (v: S | ((s: S) => S)) => void] {
  currentHook = 1;
  return useReducer(invokeOrReturn, initialState);
}

/**
 * Preact's useReducer. A dispatch that changes nothing (Object.is) renders nothing; one that
 * does queues the component, whose shouldComponentUpdate then checks every hook's next value.
 */
export function useReducer(reducer: Any, initialState: Any, init?: Any): Any {
  const hookState = getHookState(currentIndex++, 2);
  hookState.t = reducer;
  if (!hookState.__c) {
    hookState.__ = [
      !init ? invokeOrReturn(undefined, initialState) : init(initialState),
      (action: Any) => {
        const currentValue = hookState.__N ? hookState.__N[0] : hookState.__[0];
        const nextValue = hookState.t(currentValue, action);
        if (!ObjectIs(currentValue, nextValue)) {
          hookState.__N = [nextValue, hookState.__[1]];
          hookState.__c.setState({});
        }
      },
    ];
    hookState.__c = currentComponent;
    if (!currentComponent.__f) {
      currentComponent.__f = true;
      const prevScu = currentComponent.shouldComponentUpdate;
      // Render only when props changed or some hook's next value differs from its value.
      currentComponent.shouldComponentUpdate = function (this: Any, p: Any, s: Any, c: Any) {
        const hooks = this.__H;
        if (!hooks) return true;
        let updatedHook = false;
        let shouldUpdate = this.props != p;
        hooks.__.some((hookItem: Any) => {
          if (hookItem.__N) {
            updatedHook = true;
            if (!ObjectIs(hookItem.__[0], hookItem.__N[0])) shouldUpdate = true;
          }
        });
        if (prevScu) {
          const result = prevScu.call(this, p, s, c);
          return updatedHook ? result || shouldUpdate : result;
        }
        return !updatedHook || shouldUpdate;
      };
    }
  }
  return hookState.__;
}

/** A ref object kept across renders. */
export function useRef<T>(initialValue?: T): { current: T } {
  currentHook = 5;
  return useMemo(() => ({ current: initialValue }), []) as Any;
}

/** `factory()`'s value, computed again only when `args` changed. */
export function useMemo<T>(factory: () => T, args?: Any[]): T {
  const state = getHookState(currentIndex++, 7);
  if (argsChanged(state.__H, args)) {
    state.__ = factory();
    state.__H = args;
  }
  return state.__;
}

/** `callback`, kept the same until `args` change. */
export function useCallback<T>(callback: T, args?: Any[]): T {
  currentHook = 8;
  return useMemo(() => callback, args);
}

/** The nearest provider's value of `context`, subscribing the component to it. */
export function useContext(context: Any): Any {
  const provider = currentComponent.context[context.__c];
  const state = getHookState(currentIndex++, 9);
  state.c = context;
  if (!provider) return context.__;
  if (state.__ == null) {
    state.__ = true;
    provider.sub(currentComponent);
  }
  return provider.props.value;
}

/** Hand a label to `options.useDebugValue` (devtools). */
export function useDebugValue(value: Any, formatter?: Any): void {
  if (options.useDebugValue) options.useDebugValue(formatter ? formatter(value) : value);
}

/** Make the component an error boundary: [the error caught, a function that clears it]. */
export function useErrorBoundary(cb?: Any): [Any, () => void] {
  const state = getHookState(currentIndex++, 10);
  const errState = useState<Any>();
  state.__ = cb;
  if (!currentComponent.componentDidCatch) {
    currentComponent.componentDidCatch = (err: Any, errorInfo: Any) => {
      if (state.__) state.__(err, errorInfo);
      errState[1](err);
    };
  }
  return [
    errState[0],
    () => {
      errState[1](undefined);
    },
  ];
}

/** An id unique within the root, stable across renders: "P<root>-<n>". */
export function useId(): string {
  const state = getHookState(currentIndex++, 11);
  if (!state.__) {
    let root = currentComponent.__v;
    while (!root.__m && root.__) root = root.__;
    const mask = root.__m || (root.__m = [0, 0]);
    state.__ = "P" + mask[0] + "-" + mask[1]++;
  }
  return state.__;
}

export function invokeCleanup(hook: Any): void {
  // A cleanup can render (a setState inside it): keep the component being rendered.
  const comp = currentComponent;
  const cleanup = hook.__c;
  if (typeof cleanup == "function") {
    hook.__c = undefined;
    cleanup();
  }
  currentComponent = comp;
}

export function invokeEffect(hook: Any): void {
  const comp = currentComponent;
  hook.__c = hook.__();
  currentComponent = comp;
}

/** Whether the deps changed: none before, another length, or an entry not Object.is the old. */
export function argsChanged(oldArgs: Any, newArgs: Any): boolean {
  return !oldArgs || oldArgs.length != newArgs.length || newArgs.some((arg: Any, index: number) => !ObjectIs(arg, oldArgs[index]));
}

function invokeOrReturn(arg: Any, f: Any): Any {
  return typeof f == "function" ? f(arg) : f;
}
