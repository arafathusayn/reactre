// provide's types: setup declares named actions and guards with their implementations, whose
// parameters are their types (`actions: { track: (params: { key: string }) => analytics.track(params.key) }`,
// `guards: { isAdmin: (role: string) => role === "admin" }`). Handlers get them as `actions` and
// `guards`: `enq(actions.track, { key })` runs an action after the transition, `guards.isAdmin(r)`
// decides during it. `provide(machine, { actions, delays })` replaces implementations (for tests).

import type { OptIn, Uses } from "../../features.ts";
import type { AnyConfig, Shape } from "../../index.ts";
import type { DelayName } from "../delays/types.ts";
import type { NamedAction } from "../effects/types.ts";

export type Name = "provide";

type ActionsOf<D> = D extends { readonly actions: infer A } ? A : {};
type GuardsOf<D> = D extends { readonly guards: infer G } ? G : {};

/** Setup's named actions, as handlers get them: enqueue one, `enq(actions.track, { key })`. */
export type Actions<D> = {
  readonly [K in keyof ActionsOf<D>]: NamedAction<ActionsOf<D>[K] extends (...params: infer P) => unknown ? P : never>;
};

/** What `provide(machine, ...)` replaces: actions with the same parameters, and delays (milliseconds). */
export type Implementations<D> = {
  readonly actions?: { readonly [K in keyof ActionsOf<D>]?: ActionsOf<D>[K] };
  readonly delays?: { readonly [K in DelayName<D>]?: number };
};

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {
  /**
   * Named actions, by name, with their implementations: `{ track: (params: { key: string }) => ... }`.
   * An action takes its params (one argument) or none. Enqueue one: `enq(actions.track, { key })`.
   */
  readonly actions?: { readonly [name: string]: (params: never) => unknown };
  /** Named guards: pure functions handlers call to decide, `guards.isAdmin(event.role)`. */
  readonly guards?: { readonly [name: string]: (...args: never[]) => boolean };
};
export type Needs = never;
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<D extends Shape, _N extends string> = {
  /** Setup's named actions: `enq(actions.track, { key })`. */
  readonly actions: Actions<D>;
  /** Setup's named guards: `guards.isAdmin(event.role) ? to(...) : null`. */
  readonly guards: Readonly<GuardsOf<D>>;
};
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<D extends Shape> = D extends { readonly actions: unknown }
  ? ["effects"] extends [Uses<D>]
    ? never
    : `setup has actions, which run as effects (enq(actions.track, params)): ${OptIn<"effects">}`
  : never;
export type OffProblems<_D extends Shape> = never;

/** `entry`'s and `exit`'s share of provide's arguments, with it on (../effects/types.ts). */
export type EntryProvide<D extends Shape, N extends string> = [Name] extends [Uses<D>] ? Args<D, N> : {};

declare module "../../internal.ts" {
  interface __Compiled {
    /** Setup's named actions, by name (@reactre/state/provide): `provide` replaces them. */
    readonly j?: { readonly [name: string]: ((params: unknown) => unknown) | undefined };
  }
}
