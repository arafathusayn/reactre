// useEffect and the queue that runs passive effects after paint, as preact/hooks does. Loading
// this module fills the hooks' passive slots, and only useEffect (or a hook built on it) imports
// it: an app with no passive effect bundles none of this.
//
// Effects run after the next frame: a timeout after requestAnimationFrame fires, so they run
// after paint, or after 35 ms when no frame comes (a hidden tab). A component that renders again
// first runs its pending effects before that render (src/hooks.ts).
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { type Any, options, slots } from "./engine.ts";
import { argsChanged, invokeCleanup, invokeEffect, nextHook } from "./hooks.ts";
import { installLifecycle } from "./lifecycle.ts";

const afterPaintEffects: Any[] = [];
const unmountCleanups: Any[] = [];
/** How long a passive effect waits for a frame before it runs anyway. */
const RAF_TIMEOUT = 35;
let prevRaf: Any;

installLifecycle();
slots.p = (c: Any) => afterPaint(afterPaintEffects.push(c));
slots.u = (s: Any) => afterPaint(unmountCleanups.push(s));

/** Run `callback` after paint when `args` changed (every render without args). */
export function useEffect(callback: Any, args?: Any[]): void {
  const [state, component] = nextHook(3);
  if (!options.__s && argsChanged(state.__H, args)) {
    state.__P = true;
    state.__ = callback;
    state.u = args;
    component.__H.__h.push(state);
  }
}

/** Run the cleanups of unmounted components, then the passive effects of rendered ones. */
function flushAfterPaintEffects(): void {
  let component: Any;
  do {
    while ((component = unmountCleanups.shift())) {
      try {
        invokeCleanup(component);
      } catch (e) {
        // A cleanup's error goes to the nearest ancestor still mounted.
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

/** Call `callback` after the next frame, or after RAF_TIMEOUT when no frame comes. */
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
