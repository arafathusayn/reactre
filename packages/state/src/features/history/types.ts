// history's types: `back(parent, fallback)` goes to the leaf (with its data) the parent held when it
// was last left, or to the fallback. Deep history: the last leaf, whole. Shallow history,
// `back(parent, fallback, { child: to(...) })`, re-enters the parent's last direct child: a leaf
// child whole, a parent child through the step given for it (its leaves need data, which a parent
// doesn't have, so the step says which leaf and with what: XState's child `initial`). Without the
// opt-in, a handler's `back` is a function whose only parameter is the fix (../../features.ts, `Off`).

import type { AnyConfig, AnyNext, Next, Shape, StateName } from "../../index.ts";
import type { LeavesUnder, NodeName, ParentName } from "../nested/types.ts";
import type { ParallelName, ParallelOf, Unit, UnitData, UnitsUnder } from "../parallel/types.ts";

export type Name = "history";

/** A unit's name and data: what a snapshot, or a parent's history, holds. */
type UnitPair<D extends Shape, U> = U extends string ? { readonly state: U; readonly data: UnitData<D, U> } : never;

/** Each parent `back` goes to: the unit it held when it was last left. */
export type History<D extends Shape> = {
  readonly [P in ParentName<D>]?: UnitPair<D, Extract<Unit<D>, `${P}.${string}` | P>>;
};

type BackArg<D extends Shape, P, N extends string> =
  P extends StateName<D>
    ? `"${P}" is a leaf: back goes to the leaf a parent held when it was last left. Go to this one with to("${P}", ...)`
    : [ParallelOf<D, P>] extends [never]
      ? N extends `${P & string}.${string}`
        ? `back("${P & string}") from "${N}", a leaf under it, goes nowhere new: keep("${N}", ...) stays`
        : P
      : `back can't go to "${P & string}", inside parallel node "${ParallelOf<D, P>}": go back to "${ParallelOf<D, P>}", which keeps all its regions`;

/** The fallback, when its step goes into the parent `P`; otherwise the fix. */
type FallbackArg<P, F> =
  F extends Next<infer S, string>
    ? [Exclude<S, P | `${P & string}.${string}`>] extends [never]
      ? F
      : `back("${P & string}", step) takes a step into "${P & string}"; "${Exclude<S, P | `${P & string}.${string}`>}" is outside it: go there with to(...)`
    : F;

/** The direct children of P that are parents: shallow history re-enters one through its step. */
type ChildParents<D extends Shape, P extends string> = {
  [L in LeavesUnder<D, P>]: L extends `${P}.${infer C}.${string}` ? C : never;
}[LeavesUnder<D, P>];

/**
 * Shallow history's steps: one for each direct child of P that is a parent, into a leaf under it
 * (a leaf child comes back whole, with its data). Not for a parallel node: it keeps its regions.
 */
export type ShallowSteps<D extends Shape, P extends string> =
  P extends ParallelName<D> ? never : { readonly [C in ChildParents<D, P>]: Next<UnitsUnder<D, `${P}.${C}`>, string> };

/**
 * `back("edit", to("edit.draft", { text: "" }))`: go to the leaf (with its data) the parent held
 * when it was last left, or to the fallback if it never was. Deep history: the last leaf, whole.
 * `back("form", to(...), { details: to("form.details.name", ...) })`: shallow history, the parent's
 * last direct child: a leaf child whole, a parent child through its step here.
 */
export type Back<D extends Shape, N extends string = never> = <P extends NodeName<D>, F extends AnyNext<D>>(
  parent: BackArg<D, P, N>,
  fallback: FallbackArg<P, F>,
  shallow?: ShallowSteps<D, P>,
) => Next<
  Extract<Unit<D>, P | `${P}.${string}`> | (F extends Next<infer S, string> ? S : never),
  LeavesUnder<D, P> | (F extends Next<string, infer I> ? I : never)
>;

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {};
export type Needs = "nested";
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<D extends Shape, N extends string> = { readonly back: Back<D, N> };
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
