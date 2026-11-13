// output's types: a final leaf's data is its output, and a parent completes when a leaf under it is
// final: its `done: ({ state, data, to }) => to(...)` (XState's `onDone` on a compound state) gets
// that leaf and its data, and decides where to go. The actor's output is its last snapshot's
// `{ state, data }` once its status is "done": `Output<typeof machine>` types it.

import type {
  AnyConfig,
  AnyNext,
  Args as HandlerArgs,
  Cfg,
  FinalState,
  MachineInfo,
  Moves,
  Pair,
  Shape,
} from "../../index.ts";
import type { __Step } from "../../internal.ts";
import type { LeavesUnder, ParentName } from "../nested/types.ts";
import type { ParallelName, RegionName } from "../parallel/types.ts";

declare module "../../internal.ts" {
  interface __Compiled {
    /** Each parent's done: a leaf under it is final (@reactre/state/output). Gets that leaf. */
    readonly od?: { readonly [parent: string]: ((data: unknown, state: string) => __Step) | undefined };
  }
}

export type Name = "output";

/**
 * What a machine ends with: the `{ state, data }` of a final leaf it can end in. An actor's output
 * is its snapshot once `status()` is "done": `actor.snapshot() as Output<typeof machine>`.
 */
export type Output<M> = Pair<MachineInfo<M>["shape"], MachineInfo<M>["finals"]>;

/** The parents that may have a done: not a parallel node (parallel's), and not a region (it ends). */
type DoneParent<D extends Shape> = Exclude<
  ParentName<D>,
  ParallelName<D> | { [P in ParallelName<D>]: `${P}.${RegionName<D, P>}` }[ParallelName<D>]
>;

export type Options = {};
export type Needs = "nested";
export type State<D extends Shape, N extends string> =
  N extends DoneParent<D>
    ? {
        /**
         * A leaf under this parent is final (its output is its data): go on from here. `state` and
         * `data` are that leaf's.
         */
        readonly done?: (args: HandlerArgs<D, N, Moves<D, N>>) => AnyNext<D>;
      }
    : {};
export type Keys<D extends Shape, N extends string> = N extends DoneParent<D> ? "done" : never;
export type OffKeys = "done";
export type Args<_D extends Shape, _N extends string> = {};
// parallel's Deciders reads any node's `done`: nothing to add.
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};

/** A parent with done and no final leaf under it: its done never runs. */
type Doneless<D extends Shape, C extends AnyConfig> = {
  [P in DoneParent<D> & keyof C["states"]]: C["states"][P] extends { readonly done: unknown }
    ? true extends { [L in LeavesUnder<D, P>]: Cfg<C, L> extends FinalState ? true : false }[LeavesUnder<D, P>]
      ? never
      : P
    : never;
}[DoneParent<D> & keyof C["states"]];

export type Problems<
  D extends Shape,
  C extends AnyConfig,
> = `parent "${Doneless<D, C>}" has done, but no leaf under it is final: mark the leaf it ends in { final: true }, or remove done`;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
