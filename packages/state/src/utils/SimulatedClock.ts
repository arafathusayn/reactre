// @reactre/state/utils/SimulatedClock (prototype): a clock a test moves by hand, for
// `createActor(machine, { now: clock.now })` (XState's `SimulatedClock`, docs: testing.md).
//
// Design decisions:
//   - XState's actor takes the clock (`{ clock }`) and schedules on it. Here an actor takes only
//     `now`, and its timers use the global `setTimeout`: giving the actor a scheduler would put code
//     in every app with a timer (the lean lifecycle is the job bar's), for a test's sake. So the
//     clock takes over the global `setTimeout` and `clearTimeout` while it is installed (from
//     construction until `uninstall()`), and runs those timers itself, in deadline order, when the
//     test moves it. `now` is what timers' deadlines are read from, so pass it to the actor too.
//   - Moving the clock (`advance`, `set`) fires each timer that comes due, in order, with `now()` at
//     its deadline; a timer that schedules another inside the window fires too. A task's promise
//     settles on the microtask queue: `await` after moving the clock to let it land.
//   - One clock at a time: a second one installed over the first takes its timers' place, and
//     uninstalling gives back what was there.

/** A timer the clock holds. */
interface Pending {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/**
 * A clock for tests: `const clock = new SimulatedClock()`, then
 * `createActor(machine, { now: clock.now })`, and `clock.advance(ms)` to fire what comes due.
 * Call `clock.uninstall()` when the test ends (an `afterEach`), to give back the real timers.
 */
export class SimulatedClock {
  #now: number;
  #next = 1;
  #timers: Pending[] = [];
  readonly #real: { readonly set: typeof setTimeout; readonly clear: typeof clearTimeout };

  /** The time, in milliseconds: give it to the actor (`{ now: clock.now }`). */
  readonly now: () => number = () => this.#now;

  /** A clock at `start` (0 by default), installed over the global timers. */
  constructor(start = 0) {
    this.#now = start;
    this.#real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
    const set = (fn: unknown, ms?: number, ...args: unknown[]): number => {
      const id = this.#next++;
      if (typeof fn === "function")
        this.#timers.push({ id, at: this.#now + Math.max(0, ms ?? 0), fn: () => fn(...args) });
      return id;
    };
    const clear = (id: unknown): void => {
      if (typeof id === "number") this.#timers = this.#timers.filter((t) => t.id !== id);
      // Browser-native timer functions require their global receiver; Bun's do not.
      else this.#real.clear.call(globalThis, id as Parameters<typeof clearTimeout>[0]);
    };
    // Casts: the global functions' types carry the runtime's extras (Bun's `__promisify__`, Node's
    // Timeout objects); these are what the actor's lifecycle calls, with a callback and a delay.
    globalThis.setTimeout = set as unknown as typeof setTimeout;
    globalThis.clearTimeout = clear as unknown as typeof clearTimeout;
  }

  /** How many timers are waiting. */
  pending(): number {
    return this.#timers.length;
  }

  /** Move the clock forward by `ms`, firing each timer that comes due, in order. */
  advance(ms: number): void {
    this.set(this.#now + ms);
  }

  /** Move the clock to `at` (not back), firing each timer that comes due, in order. */
  set(at: number): void {
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= at).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
    }
    this.#now = Math.max(this.#now, at);
  }

  /** Give back the global timers; the timers this clock holds are dropped. */
  uninstall(): void {
    globalThis.setTimeout = this.#real.set;
    globalThis.clearTimeout = this.#real.clear;
    this.#timers = [];
  }
}
