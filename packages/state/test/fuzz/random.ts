// A seeded generator (mulberry32), the same one @reactre/state/test uses for `propertyTest`, so a
// fuzz failure reruns from its seed alone. Nothing here reads the clock or Math.random: the same
// seed makes the same machine, the same events, the same walk, on every run and every machine.

/** A generator: `next()` in [0, 1), and the picks a spec's generator needs. */
export interface Rng {
  readonly next: () => number;
  /** An integer in [0, n). */
  readonly int: (n: number) => number;
  /** One of `items` (which must not be empty). */
  readonly pick: <T>(items: readonly T[]) => T;
  /** True with probability `p`. */
  readonly chance: (p: number) => boolean;
  /** `items` shuffled (a copy). */
  readonly shuffle: <T>(items: readonly T[]) => T[];
}

/** A generator from `seed`. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  const chance = (p: number): boolean => next() < p;
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const a = out[i]!;
      out[i] = out[j]!;
      out[j] = a;
    }
    return out;
  };
  return { next, int, pick, chance, shuffle };
}
