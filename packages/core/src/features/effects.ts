// @reactre/core/features/effects: Solid 2.0's render effects, tracked effects and `onFlush`, as
// `bind`, `autorun` and `onFlush`.
//
// The phases, in reactre's terms. reactre applies a write at once: the effects it re-runs run
// before the write returns, or at the end of the batch it was made in. Solid 2.0 holds writes
// until its flush, and there runs its render effects first, then its user effects. Here:
//
//   - `bind` is the render phase: its first run is at once, where it is made (in a component's
//     body: before the view is in the page), and each later one when what `compute` read
//     changes, as every reactre effect's is.
//   - `autorun`'s first run waits for the flush: the end of the batch's drain it was called in
//     (after the effects the batch queued), or else the next `flush()` or batch end, or a
//     microtask, whichever comes first. In a component's body that is once the view is in the
//     page. Later runs are at once, as `effect`'s are.
//   - `onFlush`'s callback runs in a microtask, after the work under way, in a batch of its own,
//     so its writes are an update of their own, not part of a transition another write started.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and these are runtime functions. An app that does not import it ships none of
//     it.
//   - Built from the public API (`effect`, `onCleanup`, `untrack`, `batch`) and the batch queue
//     that features/timing reads (`__pending`, `__head`, `__batching`, `__drain`): the queue runs
//     `runner` as it runs any observer, and nothing in the core checks for this module. `bind`
//     and `autorun` are made with `effect`, so they run where the core's effects run, and not
//     where they do not.
//   - Names: `bind` for createRenderEffect, as a compiled hole is a value bound to a write
//     (`__bind`), which is what a render effect is for; `autorun` for createTrackedEffect, MobX's
//     name for its effect in one function, beside `reaction` (features/reaction), MobX's for the
//     one in two halves, which is Solid's createEffect; `onFlush` keeps Solid's name, beside
//     `onCleanup` and `onSettled`.

import {
  __batching,
  __drain,
  __head,
  __Owned,
  __owner,
  __pending,
  batch,
  effect,
  onCleanup,
  untrack,
} from "@reactre/core";

/** A cleanup, or nothing: what an effect's function may return. */
type Cleanup = void | (() => void);

/** What `fn` of `who` returned, as a cleanup: a function or undefined; anything else throws. */
function cleanup(c: unknown, who: string): (() => void) | undefined {
  if (c === undefined || typeof c === "function") return c as (() => void) | undefined;
  throw new TypeError(
    `reactre: ${who}'s function returned ${c === null ? "null" : typeof c}, not a cleanup function or undefined`,
  );
}

// #region The flush

/** What waits for the flush: `autorun`'s first runs, and `bind`'s first applies with `schedule`. */
const jobs: (() => void)[] = [];

/** The observer in the batch queue that runs `jobs`. Never a reader, so it has no `read`. */
const runner = {
  q: false,
  stale(): void {
    // What was queued after it runs first, as features/timing's `onSettled` waits for it.
    if (__head < __pending.length) return queue();
    // Each job leaves the queue as it runs. One that throws leaves the rest for the next drain, as
    // the drain leaves the effects after one that throws. A job queued by a job runs in this loop.
    let i = 0;
    try {
      while (i < jobs.length) jobs[i++]!();
    } finally {
      jobs.splice(0, i);
      if (jobs.length !== 0) queue();
    }
  },
};

/** Put `runner` in the batch queue, once, and see that something drains it. */
function queue(): void {
  if (runner.q) return;
  runner.q = true;
  __pending.push(runner as unknown as (typeof __pending)[number]);
  // In a batch, or while its queue drains (`head` is past 0), the drain reaches it. Elsewhere
  // nothing would until the next batch's end or `flush()`: a microtask drains it, if they do not.
  if (!__batching && !__head) queueMicrotask(__drain);
}

/** Run `job` at the flush. */
function later(job: () => void): void {
  jobs.push(job);
  queue();
}

// #endregion

/** Options of `bind`, as Solid 2.0's render effects take them. */
export interface BindOptions {
  /** Skip the first apply: `compute` runs at once, to track, and `apply` from its next run on. */
  readonly defer?: boolean;
  /** The first apply waits for the flush, as `autorun`'s first run does, and not at once. */
  readonly schedule?: boolean;
}

/**
 * A render effect, Solid 2.0's `createRenderEffect(compute, apply)`. `compute(prev)` is tracked,
 * given the value it last returned, and owns what it makes, as an effect's run does. After each
 * of its runs, `apply(value, prev)` runs untracked, with the value `apply` was last given as
 * `prev` (undefined the first time). Every run applies, a value equal to the last one too: it is
 * `reaction` (features/reaction) without the comparison. A function `apply` returns is a cleanup:
 * it runs before the next `apply`, after `compute`'s run, and when the owner `bind` was called in
 * is disposed; anything else but undefined throws.
 *
 * It runs at once, where it is made: in a component's body, while the view is built, before it is
 * in the page. With `defer`, the first `apply` is skipped; with `schedule`, it waits for the flush
 * (see `autorun`). Later runs are at once, when what `compute` read changes, or at the end of the
 * batch it changed in.
 *
 * @example
 *   import { bind } from "@reactre/core/features/effects";
 *
 *   function Title(props: { text: string }) {
 *     let el!: HTMLHeadingElement;
 *     bind(
 *       () => props.text.toUpperCase(),
 *       (text, prev) => {
 *         el.textContent = text;
 *         if (prev !== undefined) el.animate([{ opacity: 0.5 }, { opacity: 1 }], 200);
 *       },
 *     );
 *     return <h1 ref={(e) => (el = e)} />;
 *   }
 */
export function bind<T>(
  compute: (prev: T | undefined) => T,
  apply: (value: T, prev: T | undefined) => Cleanup,
  options?: BindOptions,
): void {
  const o = __owner;
  // 0: before the first run; 1: the first apply waits for the flush; 2: past both.
  let state = 0,
    gone = false,
    v: T | undefined,
    last: T | undefined,
    c: (() => void) | undefined;
  const run = (): void => {
    state = 2;
    const p = c;
    c = undefined;
    if (p !== undefined) p();
    c = cleanup(apply(v as T, last), "bind");
    last = v;
  };
  onCleanup(() => {
    gone = true;
    const p = c;
    c = undefined;
    if (p !== undefined) p();
  });
  effect(() => {
    v = compute(v);
    if (state === 0) {
      state = 2;
      if (options?.defer) return;
      if (options?.schedule) {
        state = 1;
        // Under the owner it was made in, as it would have run at once; not if it went first, or
        // if `compute` ran again before the flush, which applied.
        return later(() => void (state === 1 && !gone && __Owned.within(o, run)));
      }
    }
    untrack(run);
  });
}

/**
 * A tracked effect, Solid 2.0's `createTrackedEffect(fn)`: `fn` runs tracked, and again whenever
 * what it read changes, as `effect(fn)` does, but its first run waits for the flush. A function
 * `fn` returns is a cleanup: it runs before the next run, and when the owner `autorun` was called
 * in is disposed; anything else but undefined throws.
 *
 * The flush is the end of the batch's drain it was called in (a batch, a `flush(fn)`, an effect
 * a batch's writes re-ran), after the effects that batch queued; called anywhere else, the next
 * `flush()` or batch end, or a microtask, whichever comes first. In a component's body, the view
 * is in the page by then, and a `bind` made beside it has run. It does not run at all if its owner
 * goes first. Later runs are at once, when what `fn` read changes, or at the end of the batch it
 * changed in.
 *
 * @example
 *   import { autorun } from "@reactre/core/features/effects";
 *
 *   function Field(props: { focused: boolean }) {
 *     let input!: HTMLInputElement;
 *     autorun(() => {
 *       if (!props.focused) return;
 *       input.focus(); // in the page by now
 *       const t = setInterval(() => console.log(input.value), 1000);
 *       return () => clearInterval(t);
 *     });
 *     return <input ref={(el) => (input = el)} />;
 *   }
 */
export function autorun(fn: () => Cleanup): void {
  const o = __owner;
  let gone = false;
  onCleanup(() => (gone = true));
  later(() => {
    // Made under its owner, which owns it from then on, and finds its context there.
    if (!gone)
      __Owned.within(o, () =>
        effect(() => {
          const c = cleanup(fn(), "autorun");
          if (c !== undefined) onCleanup(c);
        }),
      );
  });
}

/** What `onFlush` was given, for the next microtask. */
const flushes: (() => void)[] = [];
/** Whether a microtask is queued to run `flushes`. */
let armed = false;

/** Run what `onFlush` was given so far, in one batch. */
function flushed(): void {
  // Those queued meanwhile wait for the next microtask; so do those after one that throws.
  let n = flushes.length;
  try {
    batch(() => {
      while (n-- > 0) flushes.shift()!();
    });
  } finally {
    armed = false;
    if (flushes.length !== 0) arm();
  }
}

/** Queue a microtask to run `flushes`, once. */
function arm(): void {
  if (armed) return;
  armed = true;
  queueMicrotask(flushed);
}

/**
 * Run `fn` once, after the work under way: Solid 2.0's `onFlush`. It runs in a microtask, so
 * after the code that called it has returned, the batch or `flush(fn)` it was called in has
 * applied its writes, and before the browser paints. `fn` runs untracked, with no owner, and the
 * callbacks queued for one microtask run in call order, in one batch: their writes apply together,
 * after every write made beside the `onFlush` call. One `fn` queues for a later microtask.
 *
 * Its use is to keep a write out of an update: with features/async, an update whose write makes
 * an async memo compute again holds the effects of its batch until the value comes; a write made
 * in `fn` is a batch of its own, so it shows at once, unless what it changes reads the async
 * value too.
 *
 * @example
 *   import { onFlush } from "@reactre/core/features/effects";
 *
 *   const select = (id: string) => {
 *     batch(() => {
 *       onFlush(() => setOpen(false)); // closes now, even if the route below waits for data
 *       setRoute(id);
 *     });
 *   };
 */
export function onFlush(fn: () => void): void {
  flushes.push(fn);
  arm();
}
