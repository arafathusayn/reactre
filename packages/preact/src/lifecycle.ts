// What effect hooks need from rendering, as preact/hooks installs it: layout effects run in the
// commit, and an unmounting component's effects are cleaned up (a passive one's after paint).
// useEffect and useLayoutEffect install this when they load; without either, no hook has an
// effect to run or clean up, and none of this is bundled.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { type Any, options, slots } from "./engine.ts";
import { invokeCleanup, invokeEffect } from "./hooks.ts";

let installed = false;

/** Install the commit and unmount hooks, once. */
export function installLifecycle(): void {
  if (installed) return;
  installed = true;
  const oldCommit = options.__c;
  const oldBeforeUnmount = options.unmount;

  // Layout effects run in the commit: cleanups first, then the effects. An error is rethrown
  // from the component's render callbacks, where the commit routes it to a boundary.
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
            slots.u(s);
          } else invokeCleanup(s);
        } catch (e) {
          hasErrored = e;
        }
      });
      c.__H = undefined;
      if (hasErrored) options.__e(hasErrored, c.__v);
    }
  };
}
