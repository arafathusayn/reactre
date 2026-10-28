// A small property-based testing engine for @reactre/dom's tests, with no
// dependencies. Properties are checked against many generated inputs
// (QuickCheck, Claessen and Hughes, ICFP 2000). Generators draw every random
// decision from a recorded choice sequence; on a failure the engine shrinks
// that sequence, not the value, and re-runs the generator, so every reduced
// counterexample is still a valid input (internal test-case reduction, as in
// Hypothesis: MacIver and Donaldson, ECOOP 2020).

// #region Engine

/**
 * The source of every random decision a generator makes. Fresh, it draws
 * from a seeded generator; given a replay sequence, it returns those choices
 * instead, which is how shrinking re-runs a generator on a smaller sequence.
 */
export class Choices {
  /** Every choice returned so far, in order: the sequence that rebuilds this value. */
  readonly used: number[] = [];
  private readonly replay: readonly number[] | null;
  private seed: number;
  private at = 0;

  constructor(seed: number, replay: readonly number[] | null = null) {
    // xorshift32 never leaves 0, so a zero seed becomes 1.
    this.seed = seed >>> 0 || 1;
    this.replay = replay;
  }

  /** A whole number in [0, bound). Replayed choices are clamped into range; past the end they read as 0. */
  int(bound: number): number {
    if (bound <= 1) return 0;
    let v: number;
    if (this.replay) v = (this.replay[this.at++] ?? 0) % bound;
    else {
      // xorshift32
      let x = this.seed;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.seed = x >>> 0;
      v = this.seed % bound;
    }
    this.used.push(v);
    return v;
  }

  /** A fair coin. */
  bool(): boolean {
    return this.int(2) === 1;
  }

  /** One of the given options. */
  pick<T>(options: readonly T[]): T {
    return options[this.int(options.length)]!;
  }
}

/** Something that builds a value from choices. */
export type Gen<T> = (c: Choices) => T;

/** A failing case, after shrinking. */
export interface Failure<T> {
  /** The seed of the run that first failed. */
  readonly seed: number;
  /** The smallest failing value found. */
  readonly value: T;
  /** What the property threw for that value. */
  readonly error: unknown;
  /** The choice sequence that rebuilds `value`. */
  readonly choices: readonly number[];
  /** How many reductions shrinking kept. */
  readonly shrinkSteps: number;
}

/**
 * Check `property` on `runs` generated values. Returns null when every run
 * passes, or the smallest failing case found by shrinking the choice sequence.
 */
export function check<T>(gen: Gen<T>, property: (value: T) => void, runs: number, seed = 1): Failure<T> | null {
  for (let r = 0; r < runs; r++) {
    // 0x9e3779b1 is the golden-ratio constant: consecutive runs get well-spread seeds.
    const s = (seed + r * 0x9e3779b1) >>> 0;
    const c = new Choices(s);
    const value = gen(c);
    const error = attempt(property, value);
    if (error !== undefined) return shrink(gen, property, s, c.used.slice(), value, error);
  }
  return null;
}

/** Like check, but throws a readable error with the shrunken counterexample. */
export function assertProperty<T>(
  name: string,
  gen: Gen<T>,
  property: (value: T) => void,
  runs: number,
  seed = 1,
): void {
  const f = check(gen, property, runs, seed);
  if (f === null) return;
  const shown = JSON.stringify(f.value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
  throw new Error(
    `property "${name}" failed (seed ${f.seed}, ${f.shrinkSteps} shrink steps)\n` +
      `smallest counterexample: ${shown}\n` +
      `cause: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
  );
}

/** Run the property: undefined when it passes, else what it threw (never undefined itself). */
function attempt<T>(property: (value: T) => void, value: T): unknown {
  try {
    property(value);
    return undefined;
  } catch (e) {
    return e ?? new Error("thrown undefined");
  }
}

// Shrinking budget: at most this many generator runs, and this many milliseconds.
const SHRINK_TRIES = 4000;
const SHRINK_MS = 5000;

/**
 * Greedy shrinking of the choice sequence, shortlex order: try deleting
 * chunks (largest first), then lowering single choices (to 0, then halving),
 * keeping any change that still fails. Repeat until nothing improves.
 *
 * Shorter sequences, and smaller choices at the same length, tend to build
 * smaller values, because generators draw lengths and options from choices.
 */
function shrink<T>(
  gen: Gen<T>,
  property: (value: T) => void,
  seed: number,
  choices: number[],
  value: T,
  error: unknown,
): Failure<T> {
  let best = choices,
    bestValue = value,
    bestError = error,
    steps = 0,
    tries = 0;
  // Bounded by attempts and wall time, so a slow property still reports quickly.
  const deadline = performance.now() + SHRINK_MS;
  const spent = (): boolean => tries >= SHRINK_TRIES || performance.now() > deadline;
  const tryChoices = (cand: number[]): boolean => {
    if (spent()) return false;
    tries++;
    const c = new Choices(seed, cand);
    let v: T;
    try {
      v = gen(c);
    } catch {
      return false; // the generator rejected these choices: not a valid input
    }
    const e = attempt(property, v);
    if (e === undefined) return false;
    // What the generator actually consumed, which can differ in length from the candidate.
    best = c.used.slice();
    bestValue = v;
    bestError = e;
    steps++;
    return true;
  };
  let improved = true;
  while (improved && !spent()) {
    improved = false;
    for (let size = Math.max(1, best.length >> 1); size >= 1; size >>= 1) {
      for (let i = 0; i + size <= best.length;) {
        const cand = best.slice(0, i).concat(best.slice(i + size));
        // On success, stay at i: the next chunk has slid into place.
        if (tryChoices(cand)) improved = true;
        else i += size;
      }
    }
    for (let i = 0; i < best.length; i++) {
      for (const lower of [0, best[i]! >> 1, best[i]! - 1]) {
        if (lower < 0 || lower >= best[i]!) continue;
        const cand = best.slice();
        cand[i] = lower;
        if (tryChoices(cand)) {
          improved = true;
          break;
        }
      }
    }
  }
  return { seed, value: bestValue, error: bestError, choices: best, shrinkSteps: steps };
}

// #endregion

// #region Generators for keyed lists

/** Key styles that drive each lookup mode of the reconciler. */
export type KeyStyle = "dense" | "sparse" | "string" | "negative";

/**
 * The key of item `id` in a style: dense integers (the direct-address table,
 * for windows over 16 keys), integers spread wide (a Map), strings (a Map),
 * or negative fractions (a Map).
 */
export const keyOf = (style: KeyStyle, id: number): string | number =>
  style === "dense" ? 1000 + id : style === "sparse" ? id * 1_000_003 : style === "string" ? `k${id}` : -id - 0.5;

/** One reconcile to test: the ids rendered first, then the ids rendered next, keyed in `style`. */
export interface ListCase {
  readonly style: KeyStyle;
  readonly before: readonly number[];
  readonly after: readonly number[];
}

/**
 * An old and a new list of unique ids, the new one made from the old by a
 * random edit script: moves, swaps, reversals of a run, removals, insertions
 * and full replacement, so every path of the reconciler is exercised.
 */
export const listCase =
  (maxLen: number): Gen<ListCase> =>
  (c) => {
    // Dense keys are drawn twice as often as each other style.
    const style = c.pick<KeyStyle>(["dense", "dense", "sparse", "string", "negative"]);
    const n = c.int(maxLen + 1);
    let next = n;
    const before = Array.from({ length: n }, (_, i) => i);
    const after = before.slice();
    const edits = c.int(6);
    for (let e = 0; e < edits; e++) {
      const len = after.length;
      switch (c.int(7)) {
        case 0: // move one
          if (len > 1) {
            const [x] = after.splice(c.int(len), 1);
            after.splice(c.int(len), 0, x!);
          }
          break;
        case 1: // swap two
          if (len > 1) {
            const i = c.int(len),
              j = c.int(len);
            [after[i], after[j]] = [after[j]!, after[i]!];
          }
          break;
        case 2: {
          // reverse a run
          const i = c.int(len + 1),
            j = c.int(len + 1);
          const lo = Math.min(i, j),
            hi = Math.max(i, j);
          after.splice(lo, hi - lo, ...after.slice(lo, hi).reverse());
          break;
        }
        case 3: // remove a run
          after.splice(c.int(len + 1), c.int(4));
          break;
        case 4: // insert a run of new ids
          after.splice(c.int(len + 1), 0, ...Array.from({ length: c.int(4) + 1 }, () => next++));
          break;
        case 5: // shuffle a run
          for (let k = c.int(len + 1); k > 1; k--) {
            const j = c.int(k);
            [after[k - 1], after[j]] = [after[j]!, after[k - 1]!];
          }
          break;
        default: // replace everything
          // Only 1 time in 8, so most cases keep survivors to reorder.
          if (c.int(8) === 0) after.splice(0, len, ...Array.from({ length: c.int(maxLen + 1) }, () => next++));
      }
    }
    return { style, before, after };
  };

// #endregion
