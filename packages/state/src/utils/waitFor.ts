// @reactre/state/utils/waitFor (prototype): the first snapshot that matches (xstate docs:
// testing.md). `await waitFor(actor, (s) => s.state === "saved", { timeout: 1000 })`.
//
// Design decisions:
//   - The current snapshot is checked first: a match now resolves at once.
//   - It rejects with S37 when `timeout` (milliseconds) elapses first, with S38 when the actor ends
//     without a match (it can't move again), and with the signal's reason when `signal` aborts, as
//     `fetch` does. Each removes its listener and timer.
//   - It resolves with the whole snapshot type: narrow it after (`if (s.state === "saved")`), since
//     a predicate can't be a type guard over a snapshot union that depends on the machine.

import { type __Actor, type Actor, type Shape, type Snapshot, StateError } from "../index.ts";
import type { __Snapshot } from "../internal.ts";

/** `waitFor`'s options. */
export interface WaitForOptions {
  /** Milliseconds to wait before rejecting with S37. Waits as long as it takes when omitted. */
  readonly timeout?: number;
  /** Rejects with its reason when it aborts. */
  readonly signal?: AbortSignal;
}

/**
 * Resolves with the actor's first snapshot (the current one included) that `predicate` accepts.
 *
 * @throws (rejects) StateError S37 after `timeout`, S38 when the actor ends without a match; the
 *   signal's reason when it aborts.
 */
export function waitFor<D extends Shape>(
  actor: Actor<D>,
  predicate: (snapshot: Snapshot<D>) => boolean,
  options?: WaitForOptions,
): Promise<Snapshot<D>>;
export function waitFor(
  actor: Pick<__Actor, "snapshot" | "status" | "subscribe">,
  predicate: (snapshot: __Snapshot) => boolean,
  { timeout, signal }: WaitForOptions = {},
): Promise<__Snapshot> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let off = (): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => finish(() => reject(signal?.reason));
    const finish = (settle: () => void): void => {
      off();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settle();
    };
    const check = (s: __Snapshot): boolean => {
      if (predicate(s)) finish(() => resolve(s));
      else if (actor.status() === "done")
        finish(() =>
          reject(
            new StateError(
              "S38",
              `the actor ended in "${s.state}" without a snapshot that matches: wait for a state it reaches, or check the predicate.`,
            ),
          ),
        );
      else return false;
      return true;
    };
    if (check(actor.snapshot())) return;
    off = actor.subscribe(check);
    signal?.addEventListener("abort", abort);
    if (timeout !== undefined)
      timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new StateError(
                "S37",
                `waitFor took longer than its timeout, ${timeout}ms, and the actor is in "${actor.snapshot().state}": raise the timeout, or wait for a state it reaches.`,
              ),
            ),
          ),
        timeout,
      );
  });
}
