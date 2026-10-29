// useLayoutEffect and useImperativeHandle, as preact/hooks has them: their effects run in the
// commit, after refs are set.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { type Any, options } from "./engine.ts";
import { argsChanged, nextHook } from "./hooks.ts";
import { installLifecycle } from "./lifecycle.ts";

installLifecycle();

/** A layout effect, reported to devtools as hook `type`. */
function layoutEffect(callback: Any, args: Any, type: number): void {
  const [state, component] = nextHook(type);
  if (!options.__s && argsChanged(state.__H, args)) {
    state.__P = false;
    state.__ = callback;
    state.u = args;
    component.__h.push(state);
  }
}

/** Run `callback` in the commit when `args` changed. */
export function useLayoutEffect(callback: Any, args?: Any[]): void {
  layoutEffect(callback, args, 4);
}

/** Set `ref` to `createHandle()`'s value in the commit. */
export function useImperativeHandle(ref: Any, createHandle: Any, args?: Any[]): void {
  layoutEffect(
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
    6,
  );
}
