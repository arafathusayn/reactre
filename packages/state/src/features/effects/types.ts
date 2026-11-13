// effects's types: `enq` in every handler that decides a transition (`on`, `after`, a task's
// `error`, the features' handlers), and a node's `entry` and `exit`, which get `enq` too. What a
// handler enqueues is recorded as data during the pure transition and run after it (the contract is
// "The effect registry" in ../../internal.ts): `transition()` returns it unrun, on the result's `fx`.
//
// Off, `enq` is a function whose only parameter is the fix, and `entry` or `exit` is a problem that
// names the import (../../features.ts, `Off` and `OffKeyProblem`).
//
// Other features add methods to `enq` (emit's `emit`, spawn's `spawn`, ...) by augmenting `EnqBy`
// below, keyed by their name: on, their methods are typed; off, each is a function whose parameter
// is the fix. They add their effects' descriptors to `Effect` by augmenting `EffectBy`.

import type { OptIn, Uses } from "../../features.ts";
import type {
  AnyConfig,
  Args as ArgsOf,
  Cfg,
  Deciders as AllDeciders,
  DurationProblem,
  Plain,
  SendEvent,
  Shape,
  StateName,
  TaskResult,
} from "../../index.ts";
import type { __Event } from "../../internal.ts";
import type { ChildName, ChildShape } from "../children/types.ts";
import type { EntryProvide } from "../provide/types.ts";

export type Name = "effects";

/** `enq.raise`'s and `enq.sendTo`'s options: a delay in milliseconds, and an id `enq.cancel` takes. */
export interface Later {
  /** Milliseconds: the event is sent then, unless `enq.cancel(id)` comes first. */
  readonly delay?: number;
  /** For `enq.cancel(id)`. */
  readonly id?: string;
}

/**
 * A delay written as a number literal that a timer can't use (0, which fires at once; past
 * setTimeout's limit, which fires at once too): the fix, as a required key.
 */
export type DelayCheck<O> = O extends { readonly delay: infer N extends number }
  ? number extends N
    ? unknown
    : { readonly [K in DurationProblem<"the delay", `${N}ms`>]: never }
  : unknown;

/**
 * A delayed send to an actor by reference, with persist in use: the reference isn't saved, so a
 * restored actor would lose it. A child by name is.
 */
type Kept<D, T, O> = ["persist"] extends [Uses<D>]
  ? T extends string
    ? unknown
    : O extends { readonly delay: number }
      ? {
          readonly 'a delayed sendTo to an actor by reference doesn\'t survive persist: send to a child by name, enq.sendTo("child", event, { delay })': never;
        }
      : unknown
  : unknown;

/** What `enq.sendTo` sends to: a child's name (`children`), or an actor (anything with `send`). */
export type Target<D extends Shape> = ChildName<D> | { readonly send: (event: never) => unknown };

/** The event a target takes: a child's sendable events, or what the actor's `send` takes. */
export type EventFor<D extends Shape, T> = T extends string
  ? SendEvent<ChildShape<D, T>>
  : T extends { readonly send: (event: infer E) => unknown }
    ? E
    : never;

declare const ACTION: unique symbol;

/**
 * A named action (`provide`): `enq(actions.track, { key })` runs setup's `actions.track` after the
 * transition, and `provide(machine, { actions })` can replace it. Not a function: enqueue it.
 */
export interface NamedAction<P extends readonly unknown[]> {
  readonly [ACTION]: P;
}

/** The keys of T whose values are functions: an object with none is plain data. */
type Methods<T> = { [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T];

/**
 * What an effect's function may return, given what it does return (`R`): anything but a Promise (a
 * rejection nobody sees) and plain data (an `assign` habit: data is written by the next state).
 * The incidental results of calls (`map.set`'s map, `push`'s length) are fine.
 */
export type Ignored<R> =
  R extends PromiseLike<unknown>
    ? {
        readonly "an effect's Promise is awaited by nobody, so its rejection is lost: for work the machine waits on, use task: { run, error }; else catch it in place, enq(() => { void send(x).catch(report) })": never;
      }
    : R extends readonly unknown[] | ((...args: never[]) => unknown)
      ? unknown
      : R extends object
        ? [Methods<R>] extends [never]
          ? {
              readonly "an effect returns nothing, and data isn't written here: return the next state's data from the handler, to(state, { ...data, field })": never;
            }
          : unknown
        : unknown;

/** `enq` itself, and the methods every machine with effects has. */
export interface EnqCore<D extends Shape> {
  /** A named action from setup's `actions` (`provide`), with its params: `enq(actions.track, { key })`. */
  <P extends readonly unknown[]>(action: NamedAction<P>, ...params: P): void;
  /**
   * Runs `fn(...args)` after the transition: `enq(() => console.log(data))`. The function is the
   * effect, so it may do anything; the handler around it stays pure. What it returns is ignored, so
   * it may not return a Promise or data (`Ignored`). Last of the two: a failed call shows its error.
   */
  <A extends readonly unknown[], R>(fn: (...args: A) => R & Ignored<R>, ...args: A): void;
  /**
   * Sends an event (sent or internal) to this machine. Without a delay it is handled right after the
   * transition, in the same step: listeners see only where it ends. `{ delay, id }` sends it later,
   * unless `enq.cancel(id)` comes first.
   */
  // The event as sent (a schema's input): the runtime parses a raised event as it parses a sent one.
  readonly raise: <const O extends Later = Later>(event: TaskResult<D>, options?: O & DelayCheck<O>) => void;
  /** Cancels a delayed `raise` or `sendTo` by its id. */
  readonly cancel: (id: string) => void;
  /**
   * Sends an event to a child (by its name in setup's `children`; `key` for one of a keyed
   * collection) or to an actor. A child that isn't running drops it.
   */
  readonly sendTo: <T extends Target<D>, const O extends Later & { readonly key?: string } = Later>(
    target: T,
    event: EventFor<D, T>,
    options?: O & DelayCheck<O> & Kept<D, T, O>,
  ) => void;
  /** Logs the values (console.log) after the transition. */
  readonly log: (...values: readonly unknown[]) => void;
  /**
   * Runs `fn` after the transition; the function it returns, if any, cleans up: when the state whose
   * `entry` enqueued it exits, or, from any other handler, when the actor stops.
   */
  readonly effect: (fn: () => unknown) => void;
}

/**
 * What other features add to `enq`, by feature name: augment it from your types.ts,
 * `declare module "../effects/types.ts" { interface EnqBy<D extends Shape> { spawn: { readonly spawn: ... } } }`.
 */
export interface EnqBy<D extends Shape> {
  /** Not a feature: keeps `D` used, so augmentations can name it. */
  readonly "~": { readonly "~shape"?: D };
}

type Intersect<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

/** A feature's `enq` methods, off: each is a function whose only parameter is the fix. */
type OffMethods<M, F extends string> = {
  readonly [K in keyof M]: (fix: `enq.${K & string} needs ${F}: ${OptIn<F>}`, ...rest: readonly unknown[]) => never;
};

/** The other features' methods: typed when on, the fix when off. */
type Added<D extends Shape> = Intersect<
  {
    [F in Exclude<keyof EnqBy<D>, "~">]: [F] extends [Uses<D>] ? EnqBy<D>[F] : OffMethods<EnqBy<D>[F], F & string>;
  }[Exclude<keyof EnqBy<D>, "~">]
>;

/**
 * A handler's `enq`: what it enqueues runs after the transition, in order. Exits' effects come
 * first (innermost first), then the handler's, then entries' (outermost first).
 */
export type Enq<D extends Shape> = EnqCore<D> & ([Exclude<keyof EnqBy<D>, "~">] extends [never] ? unknown : Added<D>);

/** The effects a feature adds to `Effect`, by its name: augment it as `EnqBy`. */
export interface EffectBy {
  readonly fn: { readonly type: "fn"; readonly fn: (...args: never[]) => unknown; readonly args: readonly unknown[] };
  readonly action: { readonly type: "action"; readonly name: string; readonly params?: unknown };
  readonly raise: { readonly type: "raise"; readonly event: __Event } & Later;
  readonly cancel: { readonly type: "cancel"; readonly id: string };
  readonly sendTo: {
    readonly type: "sendTo";
    readonly to: string | { readonly send: (event: never) => unknown };
    readonly event: __Event;
    readonly key?: string;
  } & Later;
  readonly log: { readonly type: "log"; readonly values: readonly unknown[] };
  /** `node`: the node whose entry enqueued it, which its cleanup runs with. */
  readonly effect: { readonly type: "effect"; readonly fn: () => unknown; readonly node?: string };
}

/** An effect, as `transition()` returns it on `fx`: data, run after the transition. */
export type Effect = EffectBy[keyof EffectBy];

/** What `entry` and `exit` get: the node's state and data, `enq`, and provide's actions and guards. */
export type EntryArgs<D extends Shape, N extends string> = ArgsOf<D, N, { readonly enq: Enq<D> } & EntryProvide<D, N>>;

/**
 * What `entry` and `exit` return besides nothing (what `enq` returns): `{ [K in EntryFix]: never }`,
 * written out at each use, not behind an alias, so the error for returned data prints the fix.
 */
export type EntryFix =
  "entry and exit return nothing, and can't write data: return the next state's data from the handler that moves, to(state, { ...data, field })";

/**
 * With the opt-in, handlers raise internal events (`enq.raise`), not only tasks: ../../index.ts
 * drops its checks of where internal events come from, which can't see a raise.
 */
export type Raises<D> = [Name] extends [Uses<D>] ? true : false;

/** The result's effects, with the opt-in: `transition(machine, s, e).fx` (../../index.ts, `Result`). */
export type ResultEffects<D> = [Name] extends [Uses<D>] ? { readonly fx: readonly Effect[] } : {};

/**
 * A final state's `entry`, which runs when the machine ends in it (XState's too): ../../index.ts's
 * `Config`. Off, it is a problem naming the import, as on any node.
 */
export type FinalEntry<D extends Shape, N extends string> = {
  readonly entry?: (args: EntryArgs<D, N>) => void | undefined | { readonly [K in EntryFix]: never };
};

/** The key a final state may have besides `final` (../../index.ts's check of final states). */
export type FinalKey = "entry";

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {};
export type Needs = never;
export type State<D extends Shape, N extends string> = {
  /**
   * Effects when the node is entered: `entry: ({ data, enq }) => enq(() => focus(data.field))`. It
   * decides nothing: the handler that goes to the node does.
   */
  readonly entry?: (args: EntryArgs<D, N>) => void | undefined | { readonly [K in EntryFix]: never };
  /** Effects when the node exits: `exit: ({ enq }) => enq.cancel("debounce")`. */
  readonly exit?: (args: EntryArgs<D, N>) => void | undefined | { readonly [K in EntryFix]: never };
};
export type Keys<_D extends Shape, _N extends string> = "entry" | "exit";
export type OffKeys = "entry" | "exit";
export type Args<D extends Shape, _N extends string> = { readonly enq: Enq<D> };
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<D extends Shape, C extends AnyConfig> = `${SelfMove<D, C>}`;

/** A node's entry and exit, as words. */
type EntryWords<K> = [K] extends ["entry"] ? "entry" : [K] extends ["exit"] ? "exit" : "entry and exit";
// Two checks: ["entry" | "exit"] is assignable to ["entry"] | ["exit"].
type EntryIt<K> = [K] extends ["entry"] ? "it" : [K] extends ["exit"] ? "it" : "them";

/**
 * Leaves with entry or exit that a handler of their own moves to with a plain `to`: the move doesn't
 * exit the leaf, so neither runs again (XState's habit, where a self-transition re-enters).
 */
type SelfMove<D extends Shape, C extends AnyConfig> = {
  [S in StateName<D> & keyof C["states"]]: [Extract<keyof Cfg<C, S>, "entry" | "exit">] extends [never]
    ? never
    : S extends Plain<AllDeciders<Cfg<C, S>>>
      ? `state "${S}" has ${EntryWords<Extract<keyof Cfg<C, S>, "entry" | "exit">>}, and its own handler goes to it with to(...), which doesn't run ${EntryIt<Extract<keyof Cfg<C, S>, "entry" | "exit">>} again: keep("${S}", ...) to stay without ${EntryIt<Extract<keyof Cfg<C, S>, "entry" | "exit">>}, reenter("${S}", ...) to run ${EntryIt<Extract<keyof Cfg<C, S>, "entry" | "exit">>} again`
      : never;
}[StateName<D> & keyof C["states"]];
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;

declare module "../../internal.ts" {
  interface __Compiled {
    /**
     * Each node's `entry` and `exit` (@reactre/state/effects), compiled: `(data, state) => void`,
     * each recording what it enqueues. A node with neither isn't here.
     */
    readonly b?: {
      readonly [node: string]:
        | readonly [
            entry: ((data: unknown, state: string) => void) | 0,
            exit: ((data: unknown, state: string) => void) | 0,
          ]
        | undefined;
    };
  }
}
