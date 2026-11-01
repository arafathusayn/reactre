// @reactre/core/features/async's `from`: Solid 2.0's, an AsyncIterable of what a subscription, an
// Observable or an AsyncIterable sends, for an async memo to return.
//
// Design decisions:
//   - A subscription's value, when there is one already, is given by a thenable that calls back at
//     once: the core's async memo reads its iterator's results with `then`, so a value a source
//     sends while subscribing is the memo's in the same run, with no wait and no `<Loading>`.
//   - A file of its own (see ./asyncMemo.ts): an app that does not use it leaves it out of its
//     bundle whole.

import { onCleanup } from "@reactre/core";

/** What a source of `from` returns to be stopped: a function, or an object with `unsubscribe`. */
export type Teardown = (() => void) | { unsubscribe(): void } | void;

/** The observer `from` gives a source's `subscribe`. */
export interface FromObserver<T> {
  next(value: T): void;
  error(err: unknown): void;
  complete(): void;
}

/**
 * What `from` takes: a subscribe function (`(next, error, complete) => unsubscribe`), an
 * Observable (an object with `subscribe(observer)`, RxJS's and the TC39 proposal's, through
 * `Symbol.observable` or `"@@observable"` too), or an AsyncIterable.
 */
export type FromSource<T> =
  | ((next: (value: T) => void, error: (err: unknown) => void, complete: () => void) => Teardown)
  | { subscribe(observer: FromObserver<T>): Teardown }
  | AsyncIterable<T>;

/** Internal: the mark of an AsyncIterable `from` made of a subscription, which hydration reconnects (@reactre/core/hydrate/async). */
export const __LIVE: unique symbol = Symbol.for("reactre.live");

/** A source's subscribe function, or null for an AsyncIterable. */
function subscriber<T>(source: FromSource<T>): ((o: FromObserver<T>) => Teardown) | null {
  if (typeof source === "function")
    return (o) =>
      source(
        (v) => o.next(v),
        (e) => o.error(e),
        () => o.complete(),
      );
  const s = source as Record<string | symbol, unknown>;
  const at = (Symbol as { observable?: symbol }).observable;
  const interop = (at !== undefined ? s[at] : undefined) ?? s["@@observable"];
  const obs = (typeof interop === "function" ? interop.call(source) : source) as { subscribe?: unknown } | null;
  return obs !== null && typeof obs === "object" && typeof obs.subscribe === "function"
    ? (o) => (obs.subscribe as (o: FromObserver<T>) => Teardown).call(obs, o)
    : null;
}

/** A thenable of `r` that calls back at once: what a value already there is, so a memo has it in the same run. */
function now<T>(r: T): Promise<T> {
  return { then: (ok: (r: T) => unknown) => ok(r) } as unknown as Promise<T>;
}

/**
 * An AsyncIterable of what `source` sends, for an async memo to return (Solid 2.0's `from`):
 * `memo(() => from(source))` reads as the source's latest value. A subscription keeps only the
 * latest value, and one it sends while subscribing is the memo's at once, with no wait; an
 * AsyncIterable sends each of its values. The source starts when the memo iterates it and stops
 * when the memo runs again or goes. On the server a subscription's first value is the memo's,
 * and it stops there (@reactre/core/server/async).
 *
 * @throws TypeError for anything else.
 *
 * @example
 *   import { from, memo } from "@reactre/core/features/async";
 *
 *   const position = memo(() =>
 *     from<GeolocationPosition>((next, error) => {
 *       const id = navigator.geolocation.watchPosition(next, error);
 *       return () => navigator.geolocation.clearWatch(id);
 *     }),
 *   );
 */
export function from<T>(source: FromSource<T>): AsyncIterable<T> {
  const subscribe = source == null ? null : subscriber(source);
  if (subscribe === null) {
    const iterate = (source as Partial<AsyncIterable<T>> | null)?.[Symbol.asyncIterator];
    if (typeof iterate !== "function")
      throw new TypeError("reactre: from takes a subscribe function, an Observable or an AsyncIterable");
    return {
      [Symbol.asyncIterator]() {
        const it = iterate.call(source);
        // It stops with the memo that iterates it.
        onCleanup(() => void it.return?.());
        return it;
      },
    };
  }
  return {
    [__LIVE]: true,
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let latest: T | undefined,
        has = false,
        done = false,
        failed = false,
        failure: unknown,
        wait: [(r: IteratorResult<T>) => void, (e: unknown) => void] | null = null,
        stop: (() => void) | null = null;
      /** Give a pending `next` what has come: a value, or once the source has ended, its error or the end. */
      const give = (): void => {
        if (wait === null) return;
        const [ok, no] = wait;
        if (has) {
          has = false;
          ok({ value: latest as T, done: false });
        } else if (failed) {
          failed = false;
          no(failure);
        } else ok({ value: undefined, done: true });
        wait = null;
      };
      /** Unsubscribe, once; and end a pending `next`. */
      const close = (): IteratorResult<T> => {
        done = true;
        const s = stop;
        stop = null;
        try {
          s?.();
        } catch {
          // A throwing unsubscribe must not stop the memo that stops it.
        }
        give();
        return { value: undefined, done: true };
      };
      const t = subscribe({
        next(v) {
          if (done) return;
          latest = v;
          has = true;
          give();
        },
        error(e) {
          if (done) return;
          failed = true;
          failure = e;
          close();
        },
        complete() {
          if (!done) close();
        },
      });
      const off =
        typeof t === "function" ? t : t != null && typeof t.unsubscribe === "function" ? () => t.unsubscribe() : null;
      // Ended while subscribing: what it returned is released now.
      if (done) off?.();
      else stop = off;
      onCleanup(close);
      return {
        next(): Promise<IteratorResult<T>> {
          if (has) {
            has = false;
            return now({ value: latest as T, done: false });
          }
          if (failed) {
            failed = false;
            return Promise.reject(failure);
          }
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((ok, no) => (wait = [ok, no]));
        },
        return: () => Promise.resolve(close()),
      };
    },
  } as AsyncIterable<T>;
}
