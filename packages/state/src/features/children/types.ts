// children's types: setup names each child machine or actor logic (`children: { upload: uploadMachine }`),
// and a node runs it while it is active (`children: { upload: { input, done, error, update, on } }`, or
// `each`). Child machines are named in setup, not in the node: a property can't type its sibling in
// an inferred config (README, "What TypeScript doesn't allow", 7).

import type {
  __Compiled,
  __Event,
  __Options,
  __Step,
  ActorInput,
  AnyConfig,
  AnyNext,
  Args as ArgsOf,
  MachineInfo,
  Moves,
  NotJsonPath,
  OptIn,
  Pair,
  Shape,
  Snapshot,
  StateName,
  Uses,
} from "../../index.ts";
import type { InfoOf } from "../logic/types.ts";
import type { Prefixes } from "../nested/types.ts";

export type Name = "children";

declare module "../../internal.ts" {
  interface __Child {
    /** The child failed (a logic's `error` state, or a start that threw): `error` is what it threw. */
    readonly x?: (data: unknown, error: unknown, state: string, key?: string) => __Step;
    /** The events the child sends back (actor logic's `sendBack`), by type. */
    readonly o?: {
      readonly [event: string]:
        ((data: unknown, event: __Event, state: string, key?: string) => __Step | null) | undefined;
    };
    /** The child's key in its system's registry (`registryKey`, with `system` in use). */
    readonly g?: string;
  }
  interface __RunContext {
    /** The actor's options, as it was created with them: its children inherit what they share. */
    readonly options?: __Options | undefined;
  }
}

/** The child machines setup declares, by name. */
export type ChildName<D extends Shape> = D extends { readonly children: infer K } ? keyof K & string : never;

/** A child machine, by setup's name. */
export type ChildMachine<D extends Shape, K> = D extends { readonly children: infer C }
  ? K extends keyof C
    ? C[K]
    : never
  : never;

/** A child machine's shape. */
export type ChildShape<D extends Shape, K> = MachineInfo<ChildMachine<D, K>>["shape"];

/** A child machine's final leaves. */
type ChildFinal<D extends Shape, K> = Extract<MachineInfo<ChildMachine<D, K>>["finals"], StateName<ChildShape<D, K>>>;

/** What a child is, when it is actor logic (@reactre/state/logic): its output, sends, and whether it fails. */
type ChildLogic<D extends Shape, K> = InfoOf<ChildMachine<D, K>>;

/** What a child ended in: a machine's final `{ state, data }`, or a logic's output. */
export type ChildOutput<D extends Shape, K> = [ChildLogic<D, K>] extends [never]
  ? Pair<ChildShape<D, K>, ChildFinal<D, K>>
  : ChildLogic<D, K>["output"];

/** The events a child sends back (actor logic's `sendBack`). */
type Sent<D extends Shape, K> = [ChildLogic<D, K>] extends [never] ? never : ChildLogic<D, K>["sends"];

/** An event union's types (distributive: none for never). */
type TypeOf<E> = E extends { readonly type: infer T extends string } ? T : never;

/** The types of the events a child sends back. */
type SentType<D extends Shape, K> = TypeOf<Sent<D, K>>;

/** The child's key in its system's registry: a string with `system` in use, the fix without it. */
type RegistryKey<D extends Shape> = ["system"] extends [Uses<D>]
  ? string
  : `registryKey needs system: ${OptIn<"system">}`;

/** The children a node runs, by setup's name. */
export interface ChildSpec<D extends Shape, N extends string, K extends string> {
  /** The child's input, from the leaf when the node is entered. */
  readonly input?: (args: ArgsOf<D, N, {}>) => ActorInput<ChildShape<D, K>>;
  /**
   * A keyed collection instead of one child: the children the data asks for now. Reconciled on
   * entry and whenever the node stays: new keys start, keys that are gone stop.
   */
  readonly each?: (
    args: ArgsOf<D, N, {}>,
  ) => readonly { readonly key: string; readonly input: ActorInput<ChildShape<D, K>> }[];
  /** The child ended: `output` is a machine's final `{ state, data }`, or a logic's output. */
  readonly done?: (
    args: ArgsOf<
      D,
      N,
      {
        readonly output: ChildOutput<D, K>;
        /** The child's key, in a keyed collection (`each`). */
        readonly key?: string;
      } & Moves<D, N>
    >,
  ) => AnyNext<D>;
  /**
   * The child failed: a logic's error (what its run threw, a TimeoutError), or a start that threw
   * (an input its schema refused). Required for logic that can fail.
   */
  readonly error?: (args: ArgsOf<D, N, { readonly error: unknown; readonly key?: string } & Moves<D, N>>) => AnyNext<D>;
  /** The child moved: `child` is its `{ state, data }` now. `null` stays. */
  readonly update?: (
    args: ArgsOf<
      D,
      N,
      {
        // Never a final state: update runs while the child runs, and its end is `done`'s.
        readonly child: Snapshot<ChildShape<D, K>> extends infer S
          ? S extends { readonly state: infer X; readonly data: infer Y }
            ? X extends ChildFinal<D, K>
              ? never
              : { readonly state: X; readonly data: Y }
            : never
          : never;
        readonly key?: string;
      } & Moves<D, N>
    >,
  ) => AnyNext<D> | null;
  /** The events the child sends back (actor logic's `sendBack`), by type. `null` ignores one. */
  readonly on?: {
    readonly [E in SentType<D, K>]?: (
      args: ArgsOf<
        D,
        N,
        { readonly event: Extract<Sent<D, K>, { readonly type: E }>; readonly key?: string } & Moves<D, N>
      >,
    ) => AnyNext<D> | null;
  };
  /** Registers the child in its system (`createSystem`) under this key while it runs. */
  readonly registryKey?: RegistryKey<D>;
}

type KidsOf<SC> = SC extends { readonly children: infer K } ? K : {};

type OnOf<Spec> = Spec extends { readonly on: infer O } ? O : {};

/** One child of node `N`, named `K`, given `Spec` (its input, each, done, error, on). */
type KidProblem<D extends Shape, N extends string, K extends string, Spec> =
  K extends ChildName<D>
    ? | ([ChildFinal<D, K>] extends [never]
          ? "done" extends keyof Spec
            ? `state "${N}" has done for child "${K}", which has no final state: remove done`
            : never
          : "done" extends keyof Spec
            ? never
            : `state "${N}" runs child "${K}", which can end, and has no done for it: add done: ({ output, to }) => to(...)`)
      | (true extends ChildLogic<D, K>["fails"]
          ? "error" extends keyof Spec
            ? never
            : `state "${N}" runs child "${K}", which can fail, and has no error for it: add error: ({ error, to }) => to(...)`
          : never)
      | `state "${N}" runs child "${K}", which sends "${Exclude<SentType<D, K>, keyof OnOf<Spec>>}", and doesn't handle it: add on: { ${Exclude<SentType<D, K>, keyof OnOf<Spec>>}: ({ event, to }) => to(...) }`
      | `state "${N}" handles "${Exclude<keyof OnOf<Spec>, SentType<D, K>> & string}" from child "${K}", which doesn't send it: check the name, or remove it`
      | (Spec extends { readonly input: (...args: never[]) => infer R }
          ? `state "${N}" gives child "${K}" ${NotJsonPath<R, "input"> & string}, which isn't JSON: pass what it needs as data, and send to the parent with sendBack`
          : never)
      | ("each" extends keyof Spec
          ? "registryKey" extends keyof Spec
            ? `state "${N}"'s child "${K}" has each and registryKey: a child takes each or registryKey, not both; register each item's child by its key`
            : never
          : never)
      | ("input" extends keyof Spec
          ? "each" extends keyof Spec
            ? `state "${N}" gives child "${K}" both input and each: keep one`
            : never
          : "each" extends keyof Spec
            ? never
            : [ActorInput<ChildShape<D, K>>] extends [undefined]
              ? never
              : `state "${N}" runs child "${K}" without its input: add input: ({ data }) => ({ ... }), or each`)
    : `state "${N}" runs "${K}", which is not in setup's children: add it there, or check the name`;

/** The nodes above N that run a child named K too. */
type Above<C extends AnyConfig, N extends string, K extends string> = {
  [P in Prefixes<N> & keyof C["states"]]: K extends keyof KidsOf<C["states"][P]> ? P : never;
}[Prefixes<N> & keyof C["states"]];

type ChildProblem<D extends Shape, C extends AnyConfig> = {
  [N in keyof C["states"] & string]: {
    [K in keyof KidsOf<C["states"][N]> & string]:
      | KidProblem<D, N, K, KidsOf<C["states"][N]>[K]>
      // A node and a node above it are active together: two live children at one address.
      | `the child "${K}" runs on "${Above<C, N, K> & string}" and on "${N}", which are active together: give one another name, or run it on one`;
  }[keyof KidsOf<C["states"][N]> & string];
}[keyof C["states"] & string];

/** The config's children, by name, for `child(actor, name)`. */
export type ChildrenUsed<C extends AnyConfig> = {
  [N in keyof C["states"]]: keyof KidsOf<C["states"][N]>;
}[keyof C["states"]];

type Values<T> = T[keyof T];

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {
  /** The machines (and actor logic) nodes run as child actors, by name: `children: { upload: uploadMachine }`. */
  readonly children?: { readonly [name: string]: __Compiled };
};
export type Needs = never;
export type State<D extends Shape, N extends string> = {
  /** Child actors, by setup's `children` name: they run while the node is active. */
  readonly children?: { readonly [K in ChildName<D>]?: ChildSpec<D, N, K> };
};
export type Keys<_D extends Shape, _N extends string> = "children";
export type OffKeys = "children";
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<SC> = {
  [K in keyof KidsOf<SC>]:
    | (KidsOf<SC>[K] extends { readonly done: infer F } ? F : never)
    | (KidsOf<SC>[K] extends { readonly error: infer F } ? F : never)
    | (KidsOf<SC>[K] extends { readonly update: infer F } ? F : never)
    | Values<OnOf<KidsOf<SC>[K]>>;
}[keyof KidsOf<SC>];

/**
 * The children the machine's type carries, for `child(actor, name)`: the config's (each node's,
 * merged by name), on the shape as `"~children"`.
 */
export type Brand<D extends Shape, C extends AnyConfig> = [ChildrenUsed<C>] extends [never]
  ? {}
  : {
      readonly "~children"?: {
        readonly [K in ChildrenUsed<C> & ChildName<D>]: { readonly machine: ChildMachine<D, K> } & (true extends {
          [N in keyof C["states"]]: K extends keyof KidsOf<C["states"][N]>
            ? "each" extends keyof KidsOf<C["states"][N]>[K]
              ? true
              : false
            : false;
        }[keyof C["states"]]
          ? { readonly each: true }
          : {});
      };
    };
export type ActorOptions<_D extends Shape> = {};
export type Problems<D extends Shape, C extends AnyConfig> = `${ChildProblem<D, C>}`;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
