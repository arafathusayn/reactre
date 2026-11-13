// wildcards' types: `on: { "*": ..., "pointer.*": ... }`. "*" handles every event the node has no
// handler of its own for; "pointer.*" every event named "pointer.<...>". The handler's `event` is
// the union of the events its key matches. Without the opt-in, a wildcard key names the import.

import type { OptIn } from "../../features.ts";
import type { AnyConfig, EventName, Handler, OnOf, Shape, StateName, TaskEvent, Uses } from "../../index.ts";
import type { Prefixes } from "../nested/types.ts";

export type Name = "wildcards";

/** The wildcard keys `on` may have: "*", and "<prefix>.*" for a prefix of a dotted event's name. */
export type Wildcard<D extends Shape> = "*" | `${Prefixes<EventName<D>>}.*`;

/** The events a wildcard key matches. */
export type Matched<D extends Shape, K> = K extends "*"
  ? EventName<D>
  : K extends `${infer P}.*`
    ? Extract<EventName<D>, `${P}.${string}`>
    : never;

/** The events an `on` key handles: itself, or (with wildcards on) the events its wildcard matches. */
export type Covered<D extends Shape, K> =
  K extends EventName<D> ? K : ["wildcards"] extends [Uses<D>] ? Matched<D, K> : never;

/** A wildcard key of state S with wildcards off: the problem naming the opt-in. */
export type WildcardOff<D extends Shape, S extends string, K> = ["wildcards"] extends [Uses<D>]
  ? never
  : `state "${S}" handles "${Extract<K, Wildcard<D>> & string}": ${OptIn<Name>}`;

export type Options = {};
export type Needs = never;
export type State<D extends Shape, N extends string> = {
  readonly on?: {
    /** "*": every event this node has no handler of its own for. "a.*": every event named "a.<...>". */
    readonly [K in Wildcard<D>]?: Handler<D, N, Matched<D, K>>;
  };
};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
/** The `on` keys of a node and the nodes above it, as written. */
type ChainKeys<C extends AnyConfig, N extends string> = {
  [K in (N | Prefixes<N>) & keyof C["states"]]: keyof OnOf<C["states"][K]>;
}[(N | Prefixes<N>) & keyof C["states"]];

/** A task's result that only a wildcard of its node's chain handles: a `*` could take it for another. */
type ByWildcard<C extends AnyConfig> = {
  [S in keyof C["states"] & string]: `the task's result "${Exclude<TaskEvent<C["states"][S]>, ChainKeys<C, S>> &
    string}" in "${S}" is handled only by a wildcard: handle it by name`;
}[keyof C["states"] & string];

/** A leaf's `*` that never declines (null), under a parent with handlers: they never run for it. */
type Shadowing<D extends Shape, C extends AnyConfig> = {
  [S in StateName<D> & keyof C["states"]]: OnOf<C["states"][S]> extends {
    readonly "*": (...args: never[]) => infer R;
  }
    ? null extends R
      ? never
      : [Extract<ChainKeys<C, Prefixes<S>>, string>] extends [never]
        ? never
        : `the * of "${S}" never declines, so its parent's handlers never run: decline with null for the events it doesn't handle`
    : never;
}[StateName<D> & keyof C["states"]];

export type Problems<D extends Shape, C extends AnyConfig> = `${ByWildcard<C>}` | `${Shadowing<D, C>}`;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
