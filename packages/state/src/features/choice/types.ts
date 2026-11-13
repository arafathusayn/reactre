// choice's types: a choice state is a leaf the machine never rests in. Its data is what the choice
// reads (the transition into it gives it, like any leaf's), and its `choice: ({ data, to }) => to(...)`
// must go somewhere: it returns a step, never null. It takes nothing else, and it is never a
// snapshot's state (the machine's type leaves it out of `Snapshot`).

import type { AfterArgs, AnyConfig, AnyNext, Shape, StateName } from "../../index.ts";
import type { __Step } from "../../internal.ts";
import type { Loose } from "../always/types.ts";

declare module "../../internal.ts" {
  interface __Compiled {
    /** Each choice leaf's decision (@reactre/state/choice). */
    readonly ch?: { readonly [leaf: string]: ((data: unknown, state: string) => __Step) | undefined };
  }
}

export type Name = "choice";

/** The choice leaves of a machine's config: never in a snapshot. */
export type ChoiceLeaves<C extends AnyConfig> = {
  [S in keyof C["states"] & string]: C["states"][S] extends { readonly choice: unknown } ? S : never;
}[keyof C["states"] & string];

export type Options = {};
export type Needs = never;
export type State<D extends Shape, N extends string> =
  N extends StateName<D>
    ? {
        /**
         * A choice: the machine never rests here. Entering it runs this, and the state it returns is
         * entered in the same move. It must go somewhere: end with a fallback `to(...)`.
         */
        readonly choice?: Loose<D, Name, (args: AfterArgs<D, N>) => AnyNext<D>>;
      }
    : {};
export type Keys<D extends Shape, N extends string> = N extends StateName<D> ? "choice" : never;
export type OffKeys = "choice";
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<SC> = SC extends { readonly choice: infer F } ? F : never;
/** The choice leaves, which the machine's `Snapshot` leaves out (../parallel/types.ts, `Unit`). */
export type Brand<_D extends Shape, C extends AnyConfig> = { readonly "~choice": ChoiceLeaves<C> };
export type ActorOptions<_D extends Shape> = {};

export type Problems<_D extends Shape, C extends AnyConfig> = {
  [S in ChoiceLeaves<C>]: `state "${S}" is a choice: it only decides where to go, so it takes no "${Exclude<
    keyof C["states"][S],
    "choice"
  > &
    string}". Put that on the states it goes to`;
}[ChoiceLeaves<C>];
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
