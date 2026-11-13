// always's types: eventless transitions. A node's `always: ({ state, data, to }) => to(...) | null`
// runs after every move that leaves the node active (its own entry included): a step moves on at
// once, in the same move, and `null` rests. Without the opt-in, an `always` key names the import.

import type { AfterArgs, AnyConfig, AnyNext, Shape, StateName, Uses } from "../../index.ts";
import type { __Step } from "../../internal.ts";

declare module "../../internal.ts" {
  interface __Compiled {
    /** Each node's eventless transition: a step, or null to rest (@reactre/state/always). */
    readonly al?: { readonly [node: string]: ((data: unknown, state: string) => __Step | null) | undefined };
  }
}

export type Name = "always";

/**
 * A key's function type `T`, with feature `F` on. Off, it takes other libraries' shapes too
 * (XState's `always: []`, `route: {}`), so the only error is the problem naming the opt-in, while a
 * function written there still gets its argument's type.
 */
export type Loose<D, F extends string, T> = [F] extends [Uses<D>] ? T : T | object | string | number | boolean | null;

export type Options = {};
export type Needs = never;
export type State<D extends Shape, N extends string> = {
  /**
   * An eventless transition: after every move that leaves this node active, `to(...)` moves on at
   * once (in the same move) and `null` rests. Return null once it has moved, or it loops (S50).
   */
  readonly always?: Loose<D, Name, (args: AfterArgs<D, N>) => AnyNext<D> | null>;
};
export type Keys<_D extends Shape, _N extends string> = "always";
export type OffKeys = "always";
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<SC> = SC extends { readonly always: infer F } ? F : never;
/** The leaves whose `always` can't return null: the actor never rests in one, so a snapshot isn't in it. */
type Passing<D extends Shape, C extends AnyConfig> = {
  [S in StateName<D> & keyof C["states"]]: C["states"][S] extends { readonly always: (...args: never[]) => infer R }
    ? null extends R
      ? never
      : S
    : never;
}[StateName<D> & keyof C["states"]];

/** The machine's type carries the leaves it never rests in (../parallel/types.ts's `Transient`). */
export type Brand<D extends Shape, C extends AnyConfig> = [Passing<D, C>] extends [never]
  ? {}
  : { readonly "~always": Passing<D, C> };
export type ActorOptions<_D extends Shape> = {};

/** The keys of a node that work only while it rests: an `always` that never declines leaves them unused. */
type Resting = "on" | "task" | "after" | "children" | "timeout";

export type Problems<_D extends Shape, C extends AnyConfig> = `${{
  [S in keyof C["states"] & string]: C["states"][S] extends { readonly always: (...args: never[]) => infer R }
    ? null extends R
      ? never
      : `the always of "${S}" never declines, so its ${Extract<keyof C["states"][S], Resting> & string} never runs: make it a choice, or let always return null`
    : never;
}[keyof C["states"] & string]}`;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
