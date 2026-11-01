// @reactre/core/features/timing: Solid 2.0's timing APIs, `onSettled` and `flush`.
//
// When an `onSettled` callback runs depends on where it was queued:
//
//   - In a batch (`batch`, `flush(fn)`, a row's delegated handler), or while a batch's queue
//     drains (the effects it queued are running: a slot rendering new content for a write in a
//     batch), it waits in `soon`, and `settler` waits in the batch's own queue. The drain reaches
//     `settler` after every effect queued before it, and runs `soon` once nothing is queued after
//     it: when the batch's writes have all applied.
//   - Anywhere else (a component rendered by `render` or `attach`, an effect re-run by a write
//     outside any batch), it gets a microtask of its own. Nothing marks the end of such work (a
//     `render` may still be building the view when a batch inside it ends), but a microtask
//     runs only once all of it has returned.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and these are runtime functions.
//   - Neither is a hook in the update path. The batch queue runs `settler` as it runs any
//     observer, and `render`, slots and `batch` are as they were: the core exposes its queue
//     (`__pending`, `__head`, `__batching`) and a drain (`__drain`), and nothing in it checks for
//     this module.

import { __batching, __drain, __head, __pending, batch, onCleanup } from "@reactre/core";
import { getOwner, runWithOwner } from "@reactre/core/features/owner";

/**
 * Apply writes now: Solid 2.0's `flush`, which replaces its `batch`.
 *
 * `flush(fn)` runs `fn` as `batch` does and returns its result, and its writes have applied by
 * the time it returns. Outside a batch that is `batch(fn)` itself. Inside one, where `batch`
 * would leave the writes to the outer batch's end, `flush` drains the queue: what `fn` wrote
 * and what the outer batch had queued before it, in the order they were queued.
 *
 * `flush()` inside a batch applies what the batch has queued so far; writes after it queue
 * again, for the batch's end. Outside a batch it does nothing: a write there applies at once.
 * Either form also runs the `onSettled` callbacks that wait for the queue it drains.
 *
 * @example
 *   import { flush } from "@reactre/core/features/timing";
 *
 *   const [n, setN] = signal(0);
 *   effect(() => console.log(n())); // logs 0
 *   batch(() => {
 *     setN(1);
 *     flush(); // logs 1
 *     setN(2);
 *   }); // logs 2
 *   flush(() => setN(3)); // logs 3 before it returns
 */
export function flush(): void;
export function flush<T>(fn: () => T): T;
export function flush<T>(fn?: () => T): T | void {
  const r = fn === undefined ? undefined : batch(fn);
  __drain();
  return r;
}

/** Callbacks to run when the current batch's queue has drained. */
const soon: (() => void)[] = [];

/** Put `settler` in the batch queue, once. */
function queueSettler(): void {
  if (!settler.q) {
    settler.q = true;
    // Never a reader, so it has no `read`: nothing records it as one.
    __pending.push(settler as unknown as (typeof __pending)[number]);
  }
}

/** The observer in a batch's queue that runs `soon`. */
const settler = {
  q: false,
  stale(): void {
    // What was queued after it (by a batch that an effect of the drain opened) runs first.
    if (__head < __pending.length) return queueSettler();
    // Each callback leaves the queue as it runs. One that throws leaves the rest for the next
    // batch's end, as the drain leaves the effects after one that throws.
    let i = 0;
    try {
      while (i < soon.length) soon[i++]!();
    } finally {
      soon.splice(0, i);
      if (soon.length !== 0) queueSettler();
    }
  },
};

/**
 * Run `fn` once, untracked, when the work under way has finished and the DOM shows it (Solid
 * 2.0's `onSettled`, which replaces `onMount`). `fn` runs under the owner that was current when
 * `onSettled` was called, and not at all if that owner is disposed or re-runs first. A function
 * `fn` returns is a cleanup of that owner: it runs when the owner is disposed or re-runs.
 *
 * When `fn` runs:
 *
 * - Called in a batch, a `flush(fn)` or a `<For>` row's handler, or in an effect their writes
 *   re-ran (a slot rendering new content): when the batch's queue has drained, after every
 *   effect its writes queued, and before `batch` or `flush` returns. A `flush()` inside the
 *   batch runs those queued so far. They run in the order they were queued.
 * - Called anywhere else (a component rendered by `render` or `attach`, an effect re-run by a
 *   write outside any batch): in a microtask, once the code that called it has returned, and
 *   before the browser paints. To run them before returning, render in a flush:
 *   `flush(() => render(App, el))`.
 *
 * Either way, in a component body, the view has been inserted (by `render`, `attach`, a slot or
 * a row) by the time `fn` runs.
 *
 * @example
 *   import { onSettled } from "@reactre/core/features/timing";
 *
 *   function Field() {
 *     let input!: HTMLInputElement;
 *     onSettled(() => {
 *       input.focus();
 *       const ro = new ResizeObserver(() => console.log(input.offsetWidth));
 *       ro.observe(input);
 *       return () => ro.disconnect();
 *     });
 *     return <input ref={(el) => (input = el)} />;
 *   }
 */
export function onSettled(fn: () => void | (() => void)): void {
  const o = getOwner();
  // 0 until it runs; then 1, or the cleanup `fn` returned. 1 too when the owner goes first.
  let s: 0 | 1 | (() => void) = 0;
  onCleanup(() => {
    if (typeof s === "function") s();
    s = 1;
  });
  const run = (): void => {
    if (s !== 0) return;
    s = 1;
    const c = runWithOwner(o, fn);
    if (typeof c === "function") s = c;
  };
  // In a batch, or while its queue drains: then `head` is past 0, as it stays after an effect of
  // the drain threw, until the next batch's end runs the rest (and this with them).
  if (__batching || __head) {
    soon.push(run);
    queueSettler();
  } else queueMicrotask(run);
}
