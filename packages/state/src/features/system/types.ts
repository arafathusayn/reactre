// system's types (xstate docs: systems.md, system-transitions.md). A system is made by
// `createSystem({ registry })` and holds a registry of actors by key; an actor joins it by
// `registryKey` (`system.createActor(machine, { registryKey })`, or a child spec's, which needs
// `use: [system]`). The pure system transitions (`initialSystem`, `systemTransition`,
// `advanceSystemTime`) need no opt-in: they are app functions over any machine.

import type { __Actor, AnyConfig, Shape } from "../../index.ts";

export type Name = "system";

/** Internal: a system, as the runners that register actors in it see it. */
export interface __System {
  /** Registers `actor` under `key`: StateError S32 when another actor has it. */
  readonly "~add": (key: string, actor: __Actor) => void;
  /** Removes `actor` from `key`, if it is still the one there. */
  readonly "~del": (key: string, actor: __Actor) => void;
}

declare module "../../internal.ts" {
  interface __Options {
    /** The system the actor belongs to (`createSystem`): its children with a registryKey join it. */
    readonly system?: __System | undefined;
    /** The actor's key in its system's registry. */
    readonly registryKey?: string | undefined;
  }
}

// The registry's parts (see ../../features.ts for what each one is). The opt-in types a child
// spec's `registryKey` (../children/types.ts reads `use`), and costs nothing in the table.

export type Options = {};
export type Needs = never;
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
