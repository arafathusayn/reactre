// `matches(snapshot, path)`: is the snapshot in `path`? A leaf, a parent of the leaf, a parallel
// node, or a path inside one of its regions ("player.playback.playing"), all the way down. A type
// guard, like `isIn` (../index.ts), that also reads regions (xstate docs: snapshots.md, `matches`).
// XState takes a state value (`{ player: { playback: "playing" } }`); here a state is its dotted name.

import type { Prefixes } from "../features/nested/types.ts";

/** A unit: a snapshot, or a region's `{ state, data }`. */
interface Unit {
  readonly state: string;
  readonly data: unknown;
}

/** The paths inside a parallel node's regions (its data), all the way down. */
type RegionPaths<D> = D extends object
  ? { [K in keyof D]: D[K] extends { readonly state: string; readonly data: unknown } ? Paths<D[K]> : never }[keyof D]
  : never;

/** Every path a snapshot can be in: its unit, the unit's parents, and what its regions are in. */
export type Paths<S> = S extends { readonly state: infer U extends string; readonly data: infer D }
  ? U | Prefixes<U> | RegionPaths<D>
  : never;

/** The snapshots in `P`: under it, or the parallel node whose region it is in. */
export type Matching<S, P extends string> = Extract<S, { readonly state: P | `${P}.${string}` | Prefixes<P> }>;

/** The unit in `s`'s regions that `path` is in, if `s` is a parallel node `path` is inside. */
const regionUnit = (s: Unit, path: string): Unit | undefined => {
  if (!path.startsWith(`${s.state}.`) || typeof s.data !== "object" || s.data === null) return undefined;
  const v: unknown = Reflect.get(s.data, path.slice(s.state.length + 1).split(".")[0] ?? "");
  const state: unknown = typeof v === "object" && v !== null ? Reflect.get(v, "state") : undefined;
  return typeof state === "string" && state.startsWith(`${s.state}.`)
    ? { state, data: Reflect.get(Object(v), "data") }
    : undefined;
};

/** Internal: `matches` on any unit. */
export function __matches(s: Unit, path: string): boolean {
  if (s.state === path || s.state.startsWith(`${path}.`)) return true;
  const inner = regionUnit(s, path);
  return inner !== undefined && __matches(inner, path);
}

/**
 * `matches(snapshot, "edit")`: the snapshot is in `edit` or under it, or (for a parallel node) a
 * region is: `matches(snapshot, "player.playback.playing")`. Narrows the snapshot.
 */
export function matches<S extends Unit, P extends Paths<S>>(snapshot: S, path: P): snapshot is Matching<S, P> {
  return __matches(snapshot, path);
}
