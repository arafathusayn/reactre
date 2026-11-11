// persist's types: the opt-in puts saved timer deadlines in the machine (its tasks runner saves
// them), and the app functions (./index.ts: `persist(actor)`, `migrations(machine)`,
// `processEvent(machine, stored, event)`) accept only a machine that has it. The machine's types
// gain nothing else: a migration's types are its own (`Migrate` in ./index.ts).

import type { AnyConfig, Shape } from "../../index.ts";

export type Name = "persist";

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {};
export type Needs = never;
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
/**
 * The machine's type says when a node has a task: processEvent starts it and stops it with the
 * request. (A timer is persisted with its deadline, which processEvent keeps: it is the app's to fire.)
 */
export type Brand<_D extends Shape, C extends AnyConfig> = true extends {
  [S in keyof C["states"]]: "task" extends keyof C["states"][S] ? true : false;
}[keyof C["states"]]
  ? { readonly "~work"?: true }
  : {};

/** processEvent's machine, when it has a task: the fix, as a required key. */
export type NoWork<D> = "~work" extends keyof D
  ? {
      readonly "processEvent can't run a task (the actor stops with the request, and aborts it): run the machine with durable(machine, host)": never;
    }
  : unknown;

/** A stored value that is still text (`localStorage.getItem`, a row's column): the fix, as a required key. */
export type NotText<V> = V extends string
  ? { readonly "the stored value is text: JSON.parse it first, processEvent(machine, JSON.parse(text), event)": never }
  : unknown;

/** A migration step's old states, typed any or by an index signature: the fix. */
export type OldStates<S> = 0 extends 1 & S
  ? "a migration's states are typed any: write the old version's data types, .from<1, { idle: {}; saving: { text: string } }>(...)"
  : string extends keyof S
    ? "a migration's states are an index signature: list the old version's states and their data types"
    : {
          [K in keyof S]: 0 extends 1 & S[K] ? K : never;
        }[keyof S] extends never
      ? unknown
      : "a migration's state data is typed any: write the old version's data types";
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
