// logic's types: actor logic beyond machines (xstate docs: actor-logic.md, invoke.md). Each kind is
// a machine whose shape this file writes, so `createActor`, `child`, `persist` and `restoreActor`
// take it as they take a compiled machine:
//
//   - states: `active` (its data is the kind's: the input, the last value, the context), `done`
//     (`{ output }`) and `error` (`{ error }`, the thrown value as it was);
//   - events: what it takes (`send`), from the events it receives;
//   - `"~logic"`: what a parent reads: its output, the events it sends back, and whether it can fail.
//
// With `use: [children]`, a node runs one as a child (setup's `children` names it); that needs
// `use: [logic]` too, a type error naming the import when it's off (`OffProblems`). As a root actor
// it needs no setup: `createActor(load, { input })`.

import type { __Event, AnyConfig, Machine, MachineInfo, NotJsonPath, OptIn, Shape, Type } from "../../index.ts";
import type { Prefixes } from "../nested/types.ts";

export type Name = "logic";

declare module "../../internal.ts" {
  interface __Compiled {
    /** Actor logic (@reactre/state/logic): its kind ("async", "callback", ...) or its `id`. */
    readonly lg?: string;
  }
  interface __Options {
    /**
     * Where the actor's sent-back events go (callback logic's `sendBack`, event observables): the
     * parent's children runner sets it.
     */
    readonly parent?: ((event: __Event) => void) | undefined;
  }
}

/** An event as logic takes and sends it. */
export type AnyEvent = { readonly type: string };

/** A union of events as a shape's `events`: each type, with its payload. */
export type EventMap<E> = {
  readonly [K in E extends AnyEvent ? E["type"] : never]: Type<Omit<Extract<E, { readonly type: K }>, "type">>;
};

/** What a parent reads from a logic: its output, what it sends back, and whether it can fail. */
export interface LogicInfo<O, S, F extends boolean> {
  readonly output: O;
  readonly sends: S;
  readonly fails: F;
}

/** The shape of a logic actor. `A` is its `active` data, `R` the events it receives. */
export type LogicShape<I extends object | undefined, A extends object, O, R, S, F extends boolean> = {
  readonly states: {
    readonly active: Type<A>;
    readonly done: Type<{ readonly output: O }>;
    readonly error: Type<{ readonly error: unknown }>;
  };
  readonly events: EventMap<R>;
  readonly "~logic": LogicInfo<O, S, F>;
} & ([I] extends [undefined] ? {} : { readonly input: Type<NonNullable<I>> });

/**
 * Actor logic: a machine of shape `LogicShape`, whose final states are `done` when it can end
 * (`E`), for a parent's `done`. Its `error` is final too, but reaches a parent's `error`.
 */
export type Logic<
  I extends object | undefined,
  A extends object,
  O,
  R,
  S,
  F extends boolean,
  E extends boolean,
> = Machine<
  // A shape whatever `I` is; TypeScript can't see through the input's conditional while I is open.
  Extract<LogicShape<I, A, O, R, S, F>, Shape>,
  E extends true ? "done" : never
>;

/** What createListenerLogic's `type` may be: one of the events, a prefix with `.*`, or `*`. */
export type ListenType<E extends AnyEvent> = E["type"] | `${Prefixes<E["type"]>}.*` | "*";

/** `type` as written (`T`), when the emitter's events have it; otherwise the fix. */
export type ListenCheck<E extends AnyEvent, T extends string> = string extends E["type"] | T
  ? T
  : T extends ListenType<E>
    ? T
    : `the actor has no event "${T}": listen to one of its events, a prefix of one with .* ("upload.*"), or "*"`;

/** The events `type` matches, which `map` gets. */
export type Listened<E extends AnyEvent, T extends string> = string extends T | E["type"]
  ? E
  : T extends "*"
    ? E
    : T extends `${infer P}.*`
      ? Extract<E, { readonly type: `${P}.${string}` }>
      : Extract<E, { readonly type: T }>;

/** Step logic's context, when JSON can't hold it (it is its snapshot's data): the fix, as a required key. */
export type ContextJson<C> = [NotJsonPath<C, "context">] extends [never]
  ? unknown
  : {
      readonly [
        P in NotJsonPath<C, "context"> as `step logic's ${P & string} isn't JSON: use an array or a record`
      ]: never;
    };

/** A recorded step's result, when JSON can't hold it (the snapshot records it): the fix, as a required key. */
export type StepJson<T> = [NotJsonPath<T, "result", false>] extends [never]
  ? unknown
  : {
      readonly [
        P in NotJsonPath<
          T,
          "result",
          false
        > as `enq.step's ${P & string} can't be recorded: return its JSON, (await res.json()) checked`
      ]: never;
    };

/** A machine's logic info, when it is actor logic. */
export type InfoOf<M> = MachineInfo<M>["shape"] extends {
  readonly "~logic": infer L extends LogicInfo<unknown, unknown, boolean>;
}
  ? L
  : never;

/** The setup children that are actor logic. */
type LogicChildren<D> = D extends { readonly children: infer K }
  ? { [N in keyof K & string]: [InfoOf<K[N]>] extends [never] ? never : N }[keyof K & string]
  : never;

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
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<D extends Shape> = `setup's child "${LogicChildren<D>}" is actor logic: ${OptIn<"logic">}`;
