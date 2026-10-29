// @reactre/compat/features/stacks: the component stack React's production build reports an
// error with (onCaughtError, onUncaughtError, onRecoverableError and componentDidCatch). Loading
// this module installs it into @reactre/compat/core; @reactre/compat loads it, and
// @reactre/plugin's generated entry loads it while the `componentStack` key is on. Without it,
// errors are reported with an empty component stack.
//
// Design decisions:
//   - Nothing is kept up during render. A throw records the fiber it came from (one comparison,
//     only on the throw), and the stack is built from the fiber chain when the error is reported.
//   - Function and class components get React's native frames: like React's
//     describeNativeComponentFrame, the component is called (or constructed) with no props, with
//     no component rendering so its first hook throws, and the frame of the stack trace that
//     belongs to it is the one kept. Everything else gets React's built-in frame.
//   - A render that throws is captured as React's throwException captures it (see capture): the
//     stack of #520's wrapper, for the report if the render that follows succeeds, then the
//     error's own, which an object keeps for every later report, as React's CapturedStacks does.

import { __installStacks, type StackCore, SuspenseList, ViewTransition } from "../core.ts";

// biome-ignore lint: fibers and thrown values are opaque here.
type Any = any;

function stacks(core: StackCore) {
  const { HOST, FUNC, CLASS, SUSPENSE, ACTIVITY, LAZY, SLOT } = core;

  // Where the value thrown last came from: the first fiber whose catch it passed, which is the
  // deepest (a component's render, the parent of a child that could not be created, an effect's
  // component). Only a throw writes it; componentStack reads it when the error is reported.
  // `stacks` is never thrown, so it stands for nothing recorded.
  let lastThrown: Any = stacks,
    thrownBy: Any = null;
  // React's CapturedStacks: the stack an object was first captured with, kept. A value that is
  // not an object is described at each capture; the last one's stack waits for its report.
  const captured = new WeakMap<object, string>();
  let lastValue: Any = stacks,
    lastStack = "";

  // React's built-in frame format, read once from a stack trace as React reads it: what comes
  // before the name (V8's "    at ") and after it.
  let prefix: string | undefined,
    suffix = "";
  function builtIn(name: string): string {
    if (prefix === undefined) {
      const st = String(Error().stack),
        m = st.trim().match(/\n( *(at )?)/);
      prefix = (m && m[1]) || "";
      suffix = st.includes("\n    at") ? " (<anonymous>)" : st.includes("@") ? "@unknown:0:0" : "";
    }
    return "\n" + prefix + name + suffix;
  }

  /**
   * React's describeNativeComponentFrame: call `fn` (or construct it, for a class) where a stack
   * trace can tell its frame from the caller's, and return that frame. A component that does not
   * throw gets the built-in frame of its name.
   */
  let reentry = false;
  function native(fn: Any, construct: boolean): string {
    if (!fn || reentry) return "";
    reentry = true;
    const E = Error as Any;
    const previous = E.prepareStackTrace;
    E.prepareStackTrace = undefined;
    try {
      const RunInRootFrame = {
        DetermineComponentFrameRoot(): [string | null, string | null] {
          let control: Any;
          try {
            if (construct) {
              const Fake: Any = function () {
                throw Error();
              };
              Object.defineProperty(Fake.prototype, "props", {
                set() {
                  throw Error();
                },
              });
              try {
                Reflect.construct(Fake, []);
              } catch (x) {
                control = x;
              }
              Reflect.construct(fn, [], Fake);
            } else {
              try {
                throw Error();
              } catch (x) {
                control = x;
              }
              const p = fn();
              if (p && typeof p.catch === "function") p.catch(() => {});
            }
          } catch (sample: Any) {
            if (sample && control && typeof sample.stack === "string") return [sample.stack, control.stack];
          }
          return [null, null];
        },
      };
      const run: Any = RunInRootFrame.DetermineComponentFrameRoot;
      run.displayName = "DetermineComponentFrameRoot";
      const [sampleStack, controlStack] = run();
      if (sampleStack && controlStack) {
        const sample = sampleStack.split("\n"),
          control = controlStack.split("\n");
        let s = 0,
          c = 0;
        while (s < sample.length && !sample[s]!.includes("DetermineComponentFrameRoot")) s++;
        while (c < control.length && !control[c]!.includes("DetermineComponentFrameRoot")) c++;
        if (s === sample.length || c === control.length)
          for (s = sample.length - 1, c = control.length - 1; s >= 1 && c >= 0 && sample[s] !== control[c];) c--;
        for (; s >= 1 && c >= 0; s--, c--)
          if (sample[s] !== control[c]) {
            // React's do-while: the first line above that differs is the component's own frame.
            if (s !== 1 || c !== 1)
              for (let more = true; more; more = s >= 1 && c >= 0) {
                s--;
                c--;
                if (c < 0 || sample[s] !== control[c]) {
                  const frame = "\n" + sample[s]!.replace(" at new ", " at "),
                    name = fn.displayName;
                  return name && frame.includes("<anonymous>") ? frame.replace("<anonymous>", name) : frame;
                }
              }
            break;
          }
      }
    } finally {
      reentry = false;
      E.prepareStackTrace = previous;
    }
    const name = fn.displayName || fn.name;
    return name ? builtIn(name) : "";
  }

  return {
    thrownIn(f: Any, e: Any): void {
      if (e !== lastThrown) {
        lastThrown = e;
        thrownBy = f;
      }
    },

    /**
     * The component stack of error `e`: a frame per host element and component from the fiber `e`
     * was thrown in (else from `f`) up to the root, innermost first, as React's describeFiber
     * writes them. An object keeps the stack it was first captured with, as in React.
     */
    componentStack(e: Any, f: Any, keep?: boolean): string {
      f = source(e, f, keep);
      // Kept for another stack of the same throw: built anew, and not kept for `e`.
      if (keep) return stackOf(f);
      if (e === lastValue) {
        lastValue = stacks;
        return lastStack;
      }
      const object = e !== null && typeof e === "object";
      let stack = object ? captured.get(e) : undefined;
      if (stack === undefined) {
        stack = stackOf(f);
        if (object) captured.set(e, stack);
      }
      return stack;
    },

    /**
     * As React's throwException captures an error a render threw: the stack of #520's wrapper
     * (returned, for the report if the retry renders), then the error's own, kept for its report.
     */
    capture(e: Any, f: Any): string {
      f = source(e, f);
      const wrapper = stackOf(f);
      if (e === null || typeof e !== "object") {
        lastValue = e;
        lastStack = stackOf(f);
      } else if (!captured.has(e)) captured.set(e, stackOf(f));
      return wrapper;
    },
  };

  /** Where `e` was thrown (else `f`); the record is used up, unless `keep`. */
  function source(e: Any, f: Any, keep?: boolean): Any {
    if (e === lastThrown) f = thrownBy;
    if (!keep) {
      lastThrown = stacks;
      thrownBy = null;
    }
    return f;
  }

  /** f's stack, with no component rendering, so a component's first hook throws as in React. */
  function stackOf(f: Any): string {
    return core.outside(() => describe(f));
  }

  function describe(f: Any): string {
    let out = "",
      prev: Any = null;
    for (; f !== null; prev = f, f = f.r) {
      const n = f.n,
        t = f.t;
      // A compiled template's slot: the template's elements around it, which React has as hosts.
      if (n === SLOT) for (let x = f.d; ; x = x.parentNode) if (((out += builtIn(x.localName)), x === f.r.d)) break;
      out +=
        n === FUNC
          ? native(f.s, false)
          : n === CLASS
            ? native(t, true)
            : n === HOST
              ? builtIn(t)
              : n === ACTIVITY
                ? builtIn("Activity")
                : t === SuspenseList
                  ? builtIn("SuspenseList")
                  : t === ViewTransition
                    ? builtIn("ViewTransition")
                    : n === SUSPENSE
                      ? builtIn(prev !== null && prev.k === 1 ? "Suspense Fallback" : "Suspense")
                      : n === LAZY && prev === null
                        ? builtIn("Lazy")
                        : "";
    }
    return out;
  }
}

__installStacks(stacks);
