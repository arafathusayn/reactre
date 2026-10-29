// preact/hooks 11.1.0, ported: the hooks keep their state on the component (`__H`) and plug into
// rendering through `options`, as Preact's do. Loading this module installs them; an app that
// imports no hook ships none of this.
//
// Timing is Preact's: layout effects run in the commit, after refs; passive effects run after
// the next frame (requestAnimationFrame, or a 35 ms timeout when frames do not come), or before
// the component renders again, whichever is first.
//
// Field legend. Hooks: __ list, __h pending passive effects. A hook's state: __ value, __N next
// value, t reducer, __c component (useReducer) or cleanup (effects), __H args, u pending args,
// __P passive (an effect) or the error parent (an unmount cleanup), c context.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { type Any, options } from "./engine.ts";

const ObjectIs = Object.is;

let currentIndex: number;
let currentComponent: Any;
let previousComponent: Any;
/** The kind of hook being read, for `options.__h` (devtools). */
let currentHook = 0;
const afterPaintEffects: Any[] = [];
const unmountCleanups: Any[] = [];

const oldBeforeDiff = options.__b;
const oldBeforeRender = options.__r;
const oldAfterDiff = options.diffed;
const oldCommit = options.__c;
const oldBeforeUnmount = options.unmount;
const oldRoot = options.__;

/** How long a passive effect waits for a frame before it runs anyway. */
const RAF_TIMEOUT = 35;
let prevRaf: Any;

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
    if (c.__H.__h.length) afterPaint(afterPaintEffects.push(c));
    c.__H.__.some((hookItem: Any) => {
      if (hookItem.u) hookItem.__H = hookItem.u;
    });
  }
  previousComponent = currentComponent = null;
};

// Layout effects run in the commit: cleanups first, then the effects. An error is rethrown from
// the component's render callbacks, where the commit routes it to a boundary.
options.__c = (vnode: Any, commitQueue: Any[]) => {
  commitQueue.some((component) => {
    try {
      component.__h.some(invokeCleanup);
      component.__h = component.__h.filter((cb: Any) => (cb.__ ? invokeEffect(cb) : true));
    } catch (e) {
      component.__h = [
        () => {
          throw e;
        },
      ];
    }
  });
  if (oldCommit) oldCommit(vnode, commitQueue);
};

options.unmount = (vnode: Any) => {
  if (oldBeforeUnmount) oldBeforeUnmount(vnode);
  const c = vnode.__c;
  if (c && c.__H) {
    let hasErrored: Any, errorParent: Any;
    c.__H.__.some((s: Any) => {
      try {
        if (s.__P && s.__c) {
          // A passive cleanup runs after paint; its errors go to the nearest mounted ancestor.
          if (errorParent === undefined) {
            errorParent = vnode.__;
            while (errorParent && !(errorParent.__c && errorParent.__c.__P)) errorParent = errorParent.__;
            errorParent = errorParent && errorParent.__c;
          }
          s.__P = errorParent;
          afterPaint(unmountCleanups.push(s));
        } else invokeCleanup(s);
      } catch (e) {
        hasErrored = e;
      }
    });
    c.__H = undefined;
    if (hasErrored) options.__e(hasErrored, c.__v);
  }
};

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

/** Run `callback` after paint when `args` changed (every render without args). */
export function useEffect(callback: Any, args?: Any[]): void {
  const state = getHookState(currentIndex++, 3);
  if (!options.__s && argsChanged(state.__H, args)) {
    state.__P = true;
    state.__ = callback;
    state.u = args;
    currentComponent.__H.__h.push(state);
  }
}

/** Run `callback` in the commit when `args` changed. */
export function useLayoutEffect(callback: Any, args?: Any[]): void {
  const state = getHookState(currentIndex++, 4);
  if (!options.__s && argsChanged(state.__H, args)) {
    state.__P = false;
    state.__ = callback;
    state.u = args;
    currentComponent.__h.push(state);
  }
}

/** A ref object kept across renders. */
export function useRef<T>(initialValue?: T): { current: T } {
  currentHook = 5;
  return useMemo(() => ({ current: initialValue }), []) as Any;
}

/** Set `ref` to `createHandle()`'s value in the commit. */
export function useImperativeHandle(ref: Any, createHandle: Any, args?: Any[]): void {
  currentHook = 6;
  useLayoutEffect(
    () => {
      if (typeof ref == "function") {
        const result = ref(createHandle());
        return () => {
          ref(null);
          if (result && typeof result == "function") result();
        };
      } else if (ref) {
        ref.current = createHandle();
        return () => (ref.current = null);
      }
    },
    args == null ? args : args.concat(ref),
  );
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

/** Run the cleanups of unmounted components, then the passive effects of rendered ones. */
function flushAfterPaintEffects(): void {
  let component: Any;
  do {
    while ((component = unmountCleanups.shift())) {
      try {
        invokeCleanup(component);
      } catch (e) {
        component = component.__P;
        options.__e(e, { __: component && component.__v });
      }
    }
    while ((component = afterPaintEffects.shift())) {
      const hooks = component.__H;
      if (!component.__P || !hooks) continue;
      try {
        hooks.__h.some(invokeCleanup);
        hooks.__h.some(invokeEffect);
        hooks.__h = [];
      } catch (e) {
        hooks.__h = [];
        options.__e(e, component.__v);
      }
    }
  } while (unmountCleanups.length);
}

const HAS_RAF = typeof requestAnimationFrame == "function";

/**
 * Call `callback` after the next frame: a timeout after requestAnimationFrame fires, so it runs
 * after paint; a 35 ms timeout covers a hidden tab, where frames do not come.
 */
function afterNextFrame(callback: () => void): void {
  let raf: Any;
  const done = () => {
    clearTimeout(timeout);
    if (HAS_RAF) cancelAnimationFrame(raf);
    setTimeout(callback);
  };
  const timeout = setTimeout(done, RAF_TIMEOUT);
  if (HAS_RAF) raf = requestAnimationFrame(done);
}

/** Schedule the flush when the first effect is queued, or when the scheduler changed. */
function afterPaint(newQueueLength: number): void {
  if (newQueueLength == 1 || prevRaf != options.requestAnimationFrame) {
    prevRaf = options.requestAnimationFrame;
    (prevRaf || afterNextFrame)(flushAfterPaintEffects);
  }
}

function invokeCleanup(hook: Any): void {
  // A cleanup can render (a setState inside it): keep the component being rendered.
  const comp = currentComponent;
  const cleanup = hook.__c;
  if (typeof cleanup == "function") {
    hook.__c = undefined;
    cleanup();
  }
  currentComponent = comp;
}

function invokeEffect(hook: Any): void {
  const comp = currentComponent;
  hook.__c = hook.__();
  currentComponent = comp;
}

/** Whether the deps changed: none before, another length, or an entry not Object.is the old. */
function argsChanged(oldArgs: Any, newArgs: Any): boolean {
  return !oldArgs || oldArgs.length != newArgs.length || newArgs.some((arg: Any, index: number) => !ObjectIs(arg, oldArgs[index]));
}

function invokeOrReturn(arg: Any, f: Any): Any {
  return typeof f == "function" ? f(arg) : f;
}
