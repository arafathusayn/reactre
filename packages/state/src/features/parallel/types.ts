// parallel's types: a parallel node's regions are its direct children, each in a leaf at once. The
// node is declared in setup (`parallel: ["player"]`), since the snapshot's type depends on it:
// inside one, the snapshot's data is its regions' `{ state, data }`.
//
// The core's types read `ParallelName`, `Unit` and `Seen` for every machine: without the opt-in
// there is no parallel node, so they reduce to the flat forms.

import type {
  AnyConfig,
  AnyNext,
  Cfg,
  Data,
  Deciders as CoreDeciders,
  FinalState,
  Moves,
  Next,
  OnOf,
  Shape,
  StateName,
  Top,
} from "../../index.ts";
import type { LeavesUnder, ParentName } from "../nested/types.ts";

export type Name = "parallel";

/** The parallel nodes, from setup's `parallel`. */
export type ParallelName<D extends Shape> = D extends { readonly parallel: readonly (infer P extends string)[] }
  ? P
  : never;

/** A name inside some parallel node. */
export type InParallel<D extends Shape> = `${ParallelName<D>}.${string}`;

/**
 * The choice leaves (from the machine's type, with choice in use), and the leaves whose `always`
 * never declines (with always in use): the machine never rests in one.
 */
type Transient<D> =
  (D extends { readonly "~choice": infer X } ? X : never) | (D extends { readonly "~always": infer X } ? X : never);

/** The units under node N that no parallel node under N holds: leaves, and parallel nodes. */
export type UnitsUnder<D extends Shape, N extends string> = Exclude<
  Extract<StateName<D> | ParallelName<D>, `${N}.${string}`>,
  `${Extract<ParallelName<D>, `${N}.${string}`>}.${string}` | Transient<D>
>;

/** What a snapshot's `state` can be: a leaf outside every parallel node, or a parallel node. */
export type Unit<D extends Shape> =
  Exclude<StateName<D>, InParallel<D> | Transient<D>> | Exclude<ParallelName<D>, InParallel<D>>;

/** A parallel node's regions: its direct children. */
export type RegionName<D extends Shape, P extends string> =
  StateName<D> extends infer L ? (L extends `${P}.${infer R}.${string}` ? R : never) : never;

/** A unit's name and data, as one of a union. */
type UnitPair<D extends Shape, U> = U extends string ? { readonly state: U; readonly data: UnitData<D, U> } : never;

/** A parallel node's data: each region's unit (a leaf, or a parallel node inside it) and its data. */
export type Regions<D extends Shape, P extends string> = {
  readonly [R in RegionName<D, P>]: UnitPair<D, UnitsUnder<D, `${P}.${R}`>>;
};

/** A unit's data: a leaf's, or a parallel node's regions. */
export type UnitData<D extends Shape, U> =
  U extends StateName<D> ? Data<D, U> : U extends string ? Regions<D, U> : never;

/** A parallel node's entry: a step for each region, to a unit in it. */
export type RegionSteps<D extends Shape, P extends string> = {
  // The inner leaves are the region's: when a step is missing, T falls back to this type, and its
  // leaves (not every string) keep the result a move, so the error stays on the missing step.
  readonly [R in RegionName<D, P>]: Next<UnitsUnder<D, `${P}.${R}`>, Extract<StateName<D>, `${P}.${R}.${string}`>>;
};

/** The leaves an entry's region steps reach, for the graph checks. */
// A step into a parallel node inside the region reaches that node's leaves (Y); a leaf's, the leaf.
export type InnerOf<T> = {
  [K in keyof T]: T[K] extends Next<infer X, infer Y> ? ([Y] extends [never] ? X : Y) : never;
}[keyof T];

/** The parallel node a node is inside, if any. */
export type ParallelOf<D extends Shape, N> = {
  [P in ParallelName<D>]: N extends `${P}.${string}` ? P : never;
}[ParallelName<D>];

/**
 * The units a node's handlers run in: the node itself when it is a leaf or a parallel node, else the
 * units under it that no parallel node under it holds (inside a region, the region's units).
 */
export type Seen<D extends Shape, N extends string> = N extends StateName<D> | ParallelName<D> ? N : UnitsUnder<D, N>;

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {
  /** The parallel nodes: parents whose direct children are regions, each in a leaf at once. */
  readonly parallel?: readonly string[];
};
export type Needs = "nested";

/** A parallel node: when every region is in a final leaf, `done` decides where to go. */
export type State<D extends Shape, N extends string> =
  N extends ParallelName<D>
    ? { readonly done?: (args: { readonly data: Regions<D, N> } & Moves<D, N>) => AnyNext<D> }
    : {};
export type Keys<D extends Shape, N extends string> = N extends ParallelName<D> ? "done" : never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<SC> = SC extends { readonly done: infer F } ? F : never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type OffProblems<_D extends Shape> = never;

/** The leaves in `T` that are inside a parallel node `N` is outside of. */
type Outside<D extends Shape, N extends string, T> = {
  [P in ParallelName<D>]: N extends P | `${P}.${string}`
    ? never
    : `"${Extract<T, `${P}.${string}`> & string}", inside parallel node "${P}": enter "${P}" with to("${P}", { [region]: to(leaf, data), ... }), a step for each region`;
}[ParallelName<D>];

/** Targets inside a parallel node, from outside it: only `to(P, { ... })` enters one. */
type Entry<D extends Shape, C extends AnyConfig> =
  | {
      [S in keyof C["states"] & string]: `state "${S}" goes to ${Outside<
        D,
        S,
        S extends unknown ? Top<CoreDeciders<C["states"][S]>> : never
      >}`;
    }[keyof C["states"] & string]
  | `start goes to ${Outside<D, "", Top<C["start"]>>}`;

/** `N`'s config has key `K`. */
type Has<C extends AnyConfig, N, K extends string> = N extends keyof C["states"]
  ? K extends keyof C["states"][N]
    ? true
    : false
  : false;

/** A region's own leaves: not those of a parallel node inside it (its ending isn't the region's). */
type RegionLeaves<D extends Shape, P extends string, R extends string> = Extract<
  UnitsUnder<D, `${P}.${R}`>,
  StateName<D>
>;

/** A region with no final leaf: it never ends. */
type Endless<D extends Shape, C extends AnyConfig, P extends string> = {
  [R in RegionName<D, P>]: true extends {
    [L in RegionLeaves<D, P, R>]: Cfg<C, L> extends FinalState ? true : false;
  }[RegionLeaves<D, P, R>]
    ? never
    : R;
}[RegionName<D, P>];

type ParallelProblem<D extends Shape, C extends AnyConfig> = {
  [P in ParallelName<D>]:
    | ([Endless<D, C, P>] extends [never]
        ? Has<C, P, "done"> extends true
          ? never
          : `parallel node "${P}" ends when every region is in a final state, and has no done: add done: ({ data, to }) => to(...)`
        : never)
    | (Has<C, P, "done"> extends true
        ? `parallel node "${P}" has done, but its region "${Endless<D, C, P>}" has no final state: mark a leaf in it { final: true }, or remove done`
        : never);
}[ParallelName<D>];

/** The config keys under a region of a parallel node. */
type InRegion<C extends AnyConfig, P extends string, R extends string> = keyof C["states"] & `${P}.${R}.${string}`;

/** The events a region's nodes handle by leaving the parallel node P. */
type Leaves<C extends AnyConfig, P extends string, R extends string> = {
  [N in InRegion<C, P, R>]: {
    [E in keyof OnOf<C["states"][N]> & string]: [Exclude<Top<OnOf<C["states"][N]>[E]>, P | `${P}.${string}`>] extends [
      never,
    ]
      ? never
      : E;
  }[keyof OnOf<C["states"][N]> & string];
}[InRegion<C, P, R>];

/** The events a region's nodes handle. */
type HandledIn<C extends AnyConfig, P extends string, R extends string> = {
  [N in InRegion<C, P, R>]: keyof OnOf<C["states"][N]> & string;
}[InRegion<C, P, R>];

/** An event one region handles by leaving the node, and another region handles too: the regions' order picks. */
type Contested<D extends Shape, C extends AnyConfig> = {
  [P in ParallelName<D>]: {
    [R in RegionName<D, P>]: `"${Leaves<C, P, R> &
      HandledIn<
        C,
        P,
        Exclude<RegionName<D, P>, R>
      >}" leaves parallel node "${P}" from one region and is handled in another: handle it on the node`;
  }[RegionName<D, P>];
}[ParallelName<D>];

// In templates, so the error prints the strings, not these aliases.
export type Problems<D extends Shape, C extends AnyConfig> =
  `${Entry<D, C>}` | `${ParallelProblem<D, C>}` | `${Contested<D, C>}`;

export type ShapeProblems<D extends Shape> =
  | `parallel node "${Exclude<ParallelName<D>, ParentName<D>>}" has no states under it: add its regions' leaves, named "<node>.<region>.<leaf>"`
  | `state "${{ [P in ParallelName<D>]: Exclude<LeavesUnder<D, P>, `${P}.${string}.${string}`> }[ParallelName<D>]}" is directly under a parallel node: put it in a region, "<node>.<region>.<leaf>"`
  | `parallel node "${{ [P in ParallelName<D>]: Extract<ParallelName<D>, `${P}.${RegionName<D, P>}`> }[ParallelName<D>]}" is a region of another parallel node: put it inside a region, "<outer>.<region>.<node>", or make its regions the outer node's`;
