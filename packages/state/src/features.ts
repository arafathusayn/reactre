// @reactre/state's type registry: every feature's types, composed. The core's types
// (./index.ts) read these unions and intersections; each feature writes only its own
// ./features/<feature>/types.ts. Every feature is listed here already (the not-yet-built ones as
// stubs), so adding a feature's types never edits this file.
//
// Each ./features/<feature>/types.ts exports exactly these, with these parameters (a stub exports
// the empty form shown):
//
//   Name                  the feature's name, as in `@reactre/state/<name>`             "always"
//   Options               setup options it adds, all optional                           {}
//   Needs                 the features it needs in `use` too                            never
//   State<D, N>           the keys node N's config takes (typed, so handlers get        {}
//                         their argument's type even with the feature off: the key is
//                         then a problem naming the opt-in)
//   Keys<D, N>            which of those keys node N may have, with the feature on      never
//   OffKeys               keys that mean the feature is used: with it off, each is a    never
//                         problem naming the opt-in
//   Args<D, N>            what every deciding handler of node N gets (`back`, `enq`).   {}
//                         Off, each is a function whose parameter is the fix.
//   Deciders<SC>          the functions in node config SC that return a transition      never
//                         (the graph checks read their targets)
//   Brand<D, C>           what the machine's type carries for the app's functions       {}
//                         (`children`: "~children", for `child(actor, name)`)
//   ActorOptions<D>       what `createActor`'s options take                             {}
//   Problems<D, C>        the machine's problems, with the feature on                   never
//   ShapeProblems<D>      setup's problems, with the feature on                         never
//   OffProblems<D>        setup's problems that mean the feature is used, with it off   never
//                         (its Options keys are checked for every feature: no need)
//
// Problems are strings worded as the fix, put in a template literal (`${...}`) so an error prints
// the strings, not an alias. Pin each one in test/features/<feature>/mistakes.ts.

import type * as always from "./features/always/types.ts";
import type * as children from "./features/children/types.ts";
import type * as choice from "./features/choice/types.ts";
import type * as delays from "./features/delays/types.ts";
import type * as durable from "./features/durable/types.ts";
import type * as effects from "./features/effects/types.ts";
import type * as emit from "./features/emit/types.ts";
import type * as history from "./features/history/types.ts";
import type * as inspect from "./features/inspect/types.ts";
import type * as logic from "./features/logic/types.ts";
import type * as nested from "./features/nested/types.ts";
import type * as output from "./features/output/types.ts";
import type * as parallel from "./features/parallel/types.ts";
import type * as persist from "./features/persist/types.ts";
import type * as provide from "./features/provide/types.ts";
import type * as reenter from "./features/reenter/types.ts";
import type * as route from "./features/route/types.ts";
import type * as spawn from "./features/spawn/types.ts";
import type * as system from "./features/system/types.ts";
import type * as tags from "./features/tags/types.ts";
import type * as timeout from "./features/timeout/types.ts";
import type * as validate from "./features/validate/types.ts";
import type * as wildcards from "./features/wildcards/types.ts";
import type { AnyConfig, Feature, Shape } from "./index.ts";

/** Every feature's name: what `@reactre/state/<name>` exports, and setup's `use` lists. */
export type FeatureName =
  | always.Name
  | children.Name
  | choice.Name
  | delays.Name
  | durable.Name
  | effects.Name
  | emit.Name
  | history.Name
  | inspect.Name
  | logic.Name
  | nested.Name
  | output.Name
  | parallel.Name
  | persist.Name
  | provide.Name
  | reenter.Name
  | route.Name
  | spawn.Name
  | system.Name
  | tags.Name
  | timeout.Name
  | validate.Name
  | wildcards.Name;

/** The features setup's `use` lists, by name. */
export type Uses<D> = D extends { readonly use: readonly (infer F)[] }
  ? F extends Feature<infer N>
    ? N
    : never
  : never;

/** The fix for a feature used without its opt-in. */
export type OptIn<F extends string> = `add ${F} to setup's use (import { ${F} } from "@reactre/state/${F}")`;

/** `T` with feature `F` on, `E` with it off. */
type On<D, F extends string, T, E = never> = [F] extends [Uses<D>] ? T : E;

/** Arguments of a feature that is off: each is a function whose only parameter is the fix. */
type Off<A, F extends string> = {
  readonly [K in keyof A]: (fix: `${K & string} needs ${F}: ${OptIn<F>}`, ...rest: readonly unknown[]) => never;
};

/** A feature's arguments, on or off. */
type ArgsOf<D, F extends string, A> = On<D, F, A, Off<A, F>>;

/** Setup's options, every feature's. */
export type FeatureOptions = always.Options &
  children.Options &
  choice.Options &
  delays.Options &
  durable.Options &
  effects.Options &
  emit.Options &
  history.Options &
  inspect.Options &
  logic.Options &
  nested.Options &
  output.Options &
  parallel.Options &
  persist.Options &
  provide.Options &
  reenter.Options &
  route.Options &
  spawn.Options &
  system.Options &
  tags.Options &
  timeout.Options &
  validate.Options &
  wildcards.Options;

/** A node's config keys, every feature's, typed whether the feature is on or off. */
export type FeatureState<D extends Shape, N extends string> = always.State<D, N> &
  children.State<D, N> &
  choice.State<D, N> &
  delays.State<D, N> &
  durable.State<D, N> &
  effects.State<D, N> &
  emit.State<D, N> &
  history.State<D, N> &
  inspect.State<D, N> &
  logic.State<D, N> &
  nested.State<D, N> &
  output.State<D, N> &
  parallel.State<D, N> &
  persist.State<D, N> &
  provide.State<D, N> &
  reenter.State<D, N> &
  route.State<D, N> &
  spawn.State<D, N> &
  system.State<D, N> &
  tags.State<D, N> &
  timeout.State<D, N> &
  validate.State<D, N> &
  wildcards.State<D, N>;

/** The keys node N's config may have from the features in use. */
export type FeatureKeys<D extends Shape, N extends string> =
  | On<D, "always", always.Keys<D, N>>
  | On<D, "children", children.Keys<D, N>>
  | On<D, "choice", choice.Keys<D, N>>
  | On<D, "delays", delays.Keys<D, N>>
  | On<D, "durable", durable.Keys<D, N>>
  | On<D, "effects", effects.Keys<D, N>>
  | On<D, "emit", emit.Keys<D, N>>
  | On<D, "history", history.Keys<D, N>>
  | On<D, "inspect", inspect.Keys<D, N>>
  | On<D, "logic", logic.Keys<D, N>>
  | On<D, "nested", nested.Keys<D, N>>
  | On<D, "output", output.Keys<D, N>>
  | On<D, "parallel", parallel.Keys<D, N>>
  | On<D, "persist", persist.Keys<D, N>>
  | On<D, "provide", provide.Keys<D, N>>
  | On<D, "reenter", reenter.Keys<D, N>>
  | On<D, "route", route.Keys<D, N>>
  | On<D, "spawn", spawn.Keys<D, N>>
  | On<D, "system", system.Keys<D, N>>
  | On<D, "tags", tags.Keys<D, N>>
  | On<D, "timeout", timeout.Keys<D, N>>
  | On<D, "validate", validate.Keys<D, N>>
  | On<D, "wildcards", wildcards.Keys<D, N>>;

/** Key K of state S, if it means an off feature is used: the problem naming its opt-in. */
type OffKey<D, S extends string, K, F extends string, Keys> = On<
  D,
  F,
  never,
  K extends Keys ? `state "${S}" has "${K & string}": ${OptIn<F>}` : never
>;

/** Key K of state S, for each feature that is off and whose key it is. */
export type OffKeyProblem<D extends Shape, S extends string, K> =
  | OffKey<D, S, K, "always", always.OffKeys>
  | OffKey<D, S, K, "children", children.OffKeys>
  | OffKey<D, S, K, "choice", choice.OffKeys>
  | OffKey<D, S, K, "delays", delays.OffKeys>
  | OffKey<D, S, K, "durable", durable.OffKeys>
  | OffKey<D, S, K, "effects", effects.OffKeys>
  | OffKey<D, S, K, "emit", emit.OffKeys>
  | OffKey<D, S, K, "history", history.OffKeys>
  | OffKey<D, S, K, "inspect", inspect.OffKeys>
  | OffKey<D, S, K, "logic", logic.OffKeys>
  | OffKey<D, S, K, "nested", nested.OffKeys>
  | OffKey<D, S, K, "output", output.OffKeys>
  | OffKey<D, S, K, "parallel", parallel.OffKeys>
  | OffKey<D, S, K, "persist", persist.OffKeys>
  | OffKey<D, S, K, "provide", provide.OffKeys>
  | OffKey<D, S, K, "reenter", reenter.OffKeys>
  | OffKey<D, S, K, "route", route.OffKeys>
  | OffKey<D, S, K, "spawn", spawn.OffKeys>
  | OffKey<D, S, K, "system", system.OffKeys>
  | OffKey<D, S, K, "tags", tags.OffKeys>
  | OffKey<D, S, K, "timeout", timeout.OffKeys>
  | OffKey<D, S, K, "validate", validate.OffKeys>
  | OffKey<D, S, K, "wildcards", wildcards.OffKeys>;

/** What every deciding handler of node N gets from the features (on, or off as the fix). */
export type FeatureArgs<D extends Shape, N extends string> = ArgsOf<D, "always", always.Args<D, N>> &
  ArgsOf<D, "children", children.Args<D, N>> &
  ArgsOf<D, "choice", choice.Args<D, N>> &
  ArgsOf<D, "delays", delays.Args<D, N>> &
  ArgsOf<D, "durable", durable.Args<D, N>> &
  ArgsOf<D, "effects", effects.Args<D, N>> &
  ArgsOf<D, "emit", emit.Args<D, N>> &
  ArgsOf<D, "history", history.Args<D, N>> &
  ArgsOf<D, "inspect", inspect.Args<D, N>> &
  ArgsOf<D, "logic", logic.Args<D, N>> &
  ArgsOf<D, "nested", nested.Args<D, N>> &
  ArgsOf<D, "output", output.Args<D, N>> &
  ArgsOf<D, "parallel", parallel.Args<D, N>> &
  ArgsOf<D, "persist", persist.Args<D, N>> &
  ArgsOf<D, "provide", provide.Args<D, N>> &
  ArgsOf<D, "reenter", reenter.Args<D, N>> &
  ArgsOf<D, "route", route.Args<D, N>> &
  ArgsOf<D, "spawn", spawn.Args<D, N>> &
  ArgsOf<D, "system", system.Args<D, N>> &
  ArgsOf<D, "tags", tags.Args<D, N>> &
  ArgsOf<D, "timeout", timeout.Args<D, N>> &
  ArgsOf<D, "validate", validate.Args<D, N>> &
  ArgsOf<D, "wildcards", wildcards.Args<D, N>>;

/** The functions in a node's config that decide a transition, every feature's. */
export type FeatureDeciders<SC> =
  | always.Deciders<SC>
  | children.Deciders<SC>
  | choice.Deciders<SC>
  | delays.Deciders<SC>
  | durable.Deciders<SC>
  | effects.Deciders<SC>
  | emit.Deciders<SC>
  | history.Deciders<SC>
  | inspect.Deciders<SC>
  | logic.Deciders<SC>
  | nested.Deciders<SC>
  | output.Deciders<SC>
  | parallel.Deciders<SC>
  | persist.Deciders<SC>
  | provide.Deciders<SC>
  | reenter.Deciders<SC>
  | route.Deciders<SC>
  | spawn.Deciders<SC>
  | system.Deciders<SC>
  | tags.Deciders<SC>
  | timeout.Deciders<SC>
  | validate.Deciders<SC>
  | wildcards.Deciders<SC>;

/** What the machine's type carries from the features in use. */
export type FeatureBrand<D extends Shape, C extends AnyConfig> = On<D, "always", always.Brand<D, C>, {}> &
  On<D, "children", children.Brand<D, C>, {}> &
  On<D, "choice", choice.Brand<D, C>, {}> &
  On<D, "delays", delays.Brand<D, C>, {}> &
  On<D, "durable", durable.Brand<D, C>, {}> &
  On<D, "effects", effects.Brand<D, C>, {}> &
  On<D, "emit", emit.Brand<D, C>, {}> &
  On<D, "history", history.Brand<D, C>, {}> &
  On<D, "inspect", inspect.Brand<D, C>, {}> &
  On<D, "logic", logic.Brand<D, C>, {}> &
  On<D, "nested", nested.Brand<D, C>, {}> &
  On<D, "output", output.Brand<D, C>, {}> &
  On<D, "parallel", parallel.Brand<D, C>, {}> &
  On<D, "persist", persist.Brand<D, C>, {}> &
  On<D, "provide", provide.Brand<D, C>, {}> &
  On<D, "reenter", reenter.Brand<D, C>, {}> &
  On<D, "route", route.Brand<D, C>, {}> &
  On<D, "spawn", spawn.Brand<D, C>, {}> &
  On<D, "system", system.Brand<D, C>, {}> &
  On<D, "tags", tags.Brand<D, C>, {}> &
  On<D, "timeout", timeout.Brand<D, C>, {}> &
  On<D, "validate", validate.Brand<D, C>, {}> &
  On<D, "wildcards", wildcards.Brand<D, C>, {}>;

/** What `createActor`'s options take from the features in use. */
export type FeatureActorOptions<D extends Shape> = On<D, "always", always.ActorOptions<D>, {}> &
  On<D, "children", children.ActorOptions<D>, {}> &
  On<D, "choice", choice.ActorOptions<D>, {}> &
  On<D, "delays", delays.ActorOptions<D>, {}> &
  On<D, "durable", durable.ActorOptions<D>, {}> &
  On<D, "effects", effects.ActorOptions<D>, {}> &
  On<D, "emit", emit.ActorOptions<D>, {}> &
  On<D, "history", history.ActorOptions<D>, {}> &
  // wave1-actors: off, inspect's options are the fix (an actor option has no other place to say it).
  On<D, "inspect", inspect.ActorOptions<D>, inspect.OffActorOptions> &
  On<D, "logic", logic.ActorOptions<D>, {}> &
  On<D, "nested", nested.ActorOptions<D>, {}> &
  On<D, "output", output.ActorOptions<D>, {}> &
  On<D, "parallel", parallel.ActorOptions<D>, {}> &
  On<D, "persist", persist.ActorOptions<D>, {}> &
  On<D, "provide", provide.ActorOptions<D>, {}> &
  On<D, "reenter", reenter.ActorOptions<D>, {}> &
  On<D, "route", route.ActorOptions<D>, {}> &
  On<D, "spawn", spawn.ActorOptions<D>, {}> &
  On<D, "system", system.ActorOptions<D>, {}> &
  On<D, "tags", tags.ActorOptions<D>, {}> &
  On<D, "timeout", timeout.ActorOptions<D>, {}> &
  On<D, "validate", validate.ActorOptions<D>, {}> &
  On<D, "wildcards", wildcards.ActorOptions<D>, {}>;

/** The machine's problems from the features in use. */
export type FeatureProblems<D extends Shape, C extends AnyConfig> =
  | On<D, "always", always.Problems<D, C>>
  | On<D, "children", children.Problems<D, C>>
  | On<D, "choice", choice.Problems<D, C>>
  | On<D, "delays", delays.Problems<D, C>>
  | On<D, "durable", durable.Problems<D, C>>
  | On<D, "effects", effects.Problems<D, C>>
  | On<D, "emit", emit.Problems<D, C>>
  | On<D, "history", history.Problems<D, C>>
  | On<D, "inspect", inspect.Problems<D, C>>
  | On<D, "logic", logic.Problems<D, C>>
  | On<D, "nested", nested.Problems<D, C>>
  | On<D, "output", output.Problems<D, C>>
  | On<D, "parallel", parallel.Problems<D, C>>
  | On<D, "persist", persist.Problems<D, C>>
  | On<D, "provide", provide.Problems<D, C>>
  | On<D, "reenter", reenter.Problems<D, C>>
  | On<D, "route", route.Problems<D, C>>
  | On<D, "spawn", spawn.Problems<D, C>>
  | On<D, "system", system.Problems<D, C>>
  | On<D, "tags", tags.Problems<D, C>>
  | On<D, "timeout", timeout.Problems<D, C>>
  | On<D, "validate", validate.Problems<D, C>>
  | On<D, "wildcards", wildcards.Problems<D, C>>;

/** A feature's setup problems: on, its own; off, what means it's used (its options among them). */
type ShapeOf<D, F extends string, OnP, OffP, O> = On<
  D,
  F,
  OnP,
  OffP | `setup has "${keyof D & keyof O & string}": ${OptIn<F>}`
>;

/** A feature in use that needs another that isn't. */
type Need<D, F extends string, N extends string> = On<
  D,
  F,
  `${F} needs ${Exclude<N, Uses<D>>}: ${OptIn<Exclude<N, Uses<D>>>}`
>;

/** Setup's problems from the features: their own, their missing opt-ins, and their needs. */
export type FeatureShapeProblems<D extends Shape> =
  | ShapeOf<D, "always", always.ShapeProblems<D>, always.OffProblems<D>, always.Options>
  | ShapeOf<D, "children", children.ShapeProblems<D>, children.OffProblems<D>, children.Options>
  | ShapeOf<D, "choice", choice.ShapeProblems<D>, choice.OffProblems<D>, choice.Options>
  | ShapeOf<D, "delays", delays.ShapeProblems<D>, delays.OffProblems<D>, delays.Options>
  | ShapeOf<D, "durable", durable.ShapeProblems<D>, durable.OffProblems<D>, durable.Options>
  | ShapeOf<D, "effects", effects.ShapeProblems<D>, effects.OffProblems<D>, effects.Options>
  | ShapeOf<D, "emit", emit.ShapeProblems<D>, emit.OffProblems<D>, emit.Options>
  | ShapeOf<D, "history", history.ShapeProblems<D>, history.OffProblems<D>, history.Options>
  | ShapeOf<D, "inspect", inspect.ShapeProblems<D>, inspect.OffProblems<D>, inspect.Options>
  | ShapeOf<D, "logic", logic.ShapeProblems<D>, logic.OffProblems<D>, logic.Options>
  | ShapeOf<D, "nested", nested.ShapeProblems<D>, nested.OffProblems<D>, nested.Options>
  | ShapeOf<D, "output", output.ShapeProblems<D>, output.OffProblems<D>, output.Options>
  | ShapeOf<D, "parallel", parallel.ShapeProblems<D>, parallel.OffProblems<D>, parallel.Options>
  | ShapeOf<D, "persist", persist.ShapeProblems<D>, persist.OffProblems<D>, persist.Options>
  | ShapeOf<D, "provide", provide.ShapeProblems<D>, provide.OffProblems<D>, provide.Options>
  | ShapeOf<D, "reenter", reenter.ShapeProblems<D>, reenter.OffProblems<D>, reenter.Options>
  | ShapeOf<D, "route", route.ShapeProblems<D>, route.OffProblems<D>, route.Options>
  | ShapeOf<D, "spawn", spawn.ShapeProblems<D>, spawn.OffProblems<D>, spawn.Options>
  | ShapeOf<D, "system", system.ShapeProblems<D>, system.OffProblems<D>, system.Options>
  | ShapeOf<D, "tags", tags.ShapeProblems<D>, tags.OffProblems<D>, tags.Options>
  | ShapeOf<D, "timeout", timeout.ShapeProblems<D>, timeout.OffProblems<D>, timeout.Options>
  | ShapeOf<D, "validate", validate.ShapeProblems<D>, validate.OffProblems<D>, validate.Options>
  | ShapeOf<D, "wildcards", wildcards.ShapeProblems<D>, wildcards.OffProblems<D>, wildcards.Options>
  | Need<D, "always", always.Needs>
  | Need<D, "children", children.Needs>
  | Need<D, "choice", choice.Needs>
  | Need<D, "delays", delays.Needs>
  | Need<D, "durable", durable.Needs>
  | Need<D, "effects", effects.Needs>
  | Need<D, "emit", emit.Needs>
  | Need<D, "history", history.Needs>
  | Need<D, "inspect", inspect.Needs>
  | Need<D, "logic", logic.Needs>
  | Need<D, "nested", nested.Needs>
  | Need<D, "output", output.Needs>
  | Need<D, "parallel", parallel.Needs>
  | Need<D, "persist", persist.Needs>
  | Need<D, "provide", provide.Needs>
  | Need<D, "reenter", reenter.Needs>
  | Need<D, "route", route.Needs>
  | Need<D, "spawn", spawn.Needs>
  | Need<D, "system", system.Needs>
  | Need<D, "tags", tags.Needs>
  | Need<D, "timeout", timeout.Needs>
  | Need<D, "validate", validate.Needs>
  | Need<D, "wildcards", wildcards.Needs>;

/**
 * An app function's argument that needs feature `F` in the machine's `use` (`persist(actor)`,
 * `durable(machine, host)`): with it off, a required key whose name is the fix, which the error
 * names (`Property '"persist(actor) needs persist: add persist to…"' is missing`).
 */
export type NeedsOptIn<D, F extends FeatureName, What extends string> = On<
  D,
  F,
  unknown,
  { readonly [K in F as `${What} needs ${K}: ${OptIn<K>}`]: never }
>;
