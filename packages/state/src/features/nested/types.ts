// nested's types: the hierarchy is in the names. A leaf "edit.draft" has the parent "edit": the
// parent has no data, its handlers apply to every leaf under it, and the type of a parent's handler
// argument is the union over its leaves, so `state === "edit.review"` narrows `data`.
//
// The core's types (../../index.ts) read the names below (`ParentName`, `Chain`) for every machine:
// a flat machine has no dotted names, so they are `never` there. What this file adds to the
// registry (../../features.ts) is what it means to use nested without the opt-in, and the shape
// problems of a hierarchy.

import type { OptIn } from "../../features.ts";
import type { AnyConfig, Shape, StateName, TaskEvent } from "../../index.ts";

export type Name = "nested";

/** The proper prefixes of a dotted name: "a.b.c" has "a" and "a.b". */
export type Prefixes<S extends string> = S extends `${infer H}.${infer T}` ? H | `${H}.${Prefixes<T>}` : never;

/** The parents: every proper prefix of a leaf's name. They have no data. */
export type ParentName<D extends Shape> = Prefixes<StateName<D>>;

/** Leaves and parents: the keys a machine's `states` may have. */
export type NodeName<D extends Shape> = StateName<D> | ParentName<D>;

/** The leaves under a node. */
export type LeavesUnder<D extends Shape, N extends string> = Extract<StateName<D>, `${N}.${string}`>;

/** A name and its parents. */
export type Chain<N extends string> = N | Prefixes<N>;

/** A parent as `to`'s target: the error, worded as the fix (a parallel node is a target: see parallel). */
export type ParentTarget<D extends Shape, S, Parallel extends string> =
  S extends Exclude<ParentName<D>, Parallel> ? `"${S}" is a parent: go to one of its leaves, with its data` : S;

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {};
export type Needs = never;
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
/**
 * A node's task and a task of a node above it that resolve to one event: both run while the lower
 * one is active, so one's result is taken for the other's.
 */
export type Problems<_D extends Shape, C extends AnyConfig> = `${{
  [S in keyof C["states"] & string]: {
    [P in Prefixes<S> & keyof C["states"]]: `the tasks of "${P}" and "${S}" both resolve to "${TaskEvent<
      C["states"][S]
    > &
      TaskEvent<C["states"][P]>}", and run together: give each its own event`;
  }[Prefixes<S> & keyof C["states"]];
}[keyof C["states"] & string]}`;

export type ShapeProblems<D extends Shape> =
  `state "${StateName<D> & ParentName<D>}" is also a parent of other states, and a parent has no data: rename it, or move its data into the leaves under it`;

/** A dotted name without the opt-in. */
export type OffProblems<D extends Shape> =
  `state "${Extract<StateName<D>, `${string}.${string}`>}" is nested: ${OptIn<Name>}`;
