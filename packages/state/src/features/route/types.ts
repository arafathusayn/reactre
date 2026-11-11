// route's types: a node with `route: ({ state, data, event, to }) => to(...) | null` can be gone to
// from anywhere, by sending `{ type: "route", to: "<node>" }`. `state` and `data` are where the
// machine is when the event arrives; the handler returns the step into the node (with its data),
// or null to refuse. The machine's type adds the route event to what `send` and `transition` take.

import type { AnyConfig, Moves, Next, Shape, Target, Type } from "../../index.ts";
import type { __Handler } from "../../internal.ts";
import type { Loose } from "../always/types.ts";
import type { LeavesUnder, NodeName } from "../nested/types.ts";
import type { InParallel, ParallelName, Unit, UnitData } from "../parallel/types.ts";

declare module "../../internal.ts" {
  interface __Compiled {
    /** Each routable node's handler, for `{ type: "route", to }` (@reactre/state/route). */
    readonly ro?: { readonly [node: string]: __Handler | undefined };
  }
}

export type Name = "route";

/** The nodes a route may go to: any node outside parallel nodes (a parallel node itself included). */
type Routable<D extends Shape> = Exclude<NodeName<D>, InParallel<D>>;

/** What a route handler of node N gets: where the machine is now, the route event, and the moves. */
export type RouteArgs<D extends Shape, N extends string> =
  Unit<D> extends infer U
    ? U extends string
      ? {
          readonly state: U;
          readonly data: UnitData<D, U>;
          readonly event: { readonly type: "route"; readonly to: N };
        } & Moves<D, N>
      : never
    : never;

/** The nodes of a machine's config that take a route. */
export type Routed<C extends AnyConfig> = {
  [S in keyof C["states"] & string]: C["states"][S] extends { readonly route: unknown } ? S : never;
}[keyof C["states"] & string];

/** Where route handlers go: they are reachable from any state, so from the start (../../index.ts). */
export type RouteTargets<C extends AnyConfig> = {
  [S in Routed<C>]: Target<C["states"][S] extends { readonly route: infer F } ? F : never>;
}[Routed<C>];

export type Options = {};
export type Needs = never;
export type State<D extends Shape, N extends string> =
  N extends Routable<D>
    ? {
        /**
         * Go here from anywhere: `send({ type: "route", to: "<this node>" })` runs this, with where the
         * machine is now. Return the step into this node (with its data), or null to refuse.
         */
        readonly route?: Loose<
          D,
          Name,
          (
            args: RouteArgs<D, N>,
          ) => Next<N | LeavesUnder<D, N> | Extract<ParallelName<D>, `${N}.${string}`>, string> | null
        >;
      }
    : {};
export type Keys<D extends Shape, N extends string> = N extends Routable<D> ? "route" : never;
export type OffKeys = "route";
export type Args<_D extends Shape, _N extends string> = {};
// Not a node's out: a route is taken from every state (RouteTargets joins the start's instead).
export type Deciders<_SC> = never;
/** The route event, for `send` and `transition`: `{ type: "route", to }`, to a node that takes one. */
export type Brand<_D extends Shape, C extends AnyConfig> = {
  readonly events: { readonly route: Type<{ readonly to: Routed<C> }> };
};
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<D extends Shape> =
  `event "${Extract<keyof D["events"] | keyof NonNullable<D["internal"]>, "route"> & string}" is the route feature's ({ type: "route", to }): rename yours`;
export type OffProblems<_D extends Shape> = never;
