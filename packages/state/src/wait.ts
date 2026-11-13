// @reactre/state/wait (internal): a timer that waits however long it is asked to. The core's task
// and timer runners (./tasks.ts) and persist's saving runner (./features/persist) use it, and so do
// delays's and timeout's timers (./features/delays): one algorithm, so a 30-day delay waits 30 days
// everywhere. It is its own module, not delays's, so an app with a plain `after` timer ships these
// bytes and none of the delays opt-in's (named delays, ISO durations, the feature value).

/** The longest wait setTimeout takes: 2^31 − 1 ms (about 24.8 days). */
const LIMIT = 2147483647;

/**
 * Internal: calls `fire` after `ms`, however long: a wait past setTimeout's limit is waited in parts.
 * Returns the cancel. A delay that isn't a finite number never fires: `setTimeout(NaN)` is 0, an
 * immediate fire (an accidental retry), and `Infinity` would re-arm every 24.8 days forever. A
 * negative delay (a deadline already past) fires at once.
 */
export function __wait(ms: number, fire: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const part = (left: number): void => {
    // Not finite (NaN, Infinity): no timer at all, so nothing fires and the cancel is a no-op.
    if (left < Infinity) t = setTimeout(left > LIMIT ? () => part(left - LIMIT) : fire, left > LIMIT ? LIMIT : left);
  };
  part(ms);
  return () => clearTimeout(t);
}
