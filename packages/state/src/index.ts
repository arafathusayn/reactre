// @reactre/state (prototype): state machines that a model writing code gets right, or gets a
// type error that says what to change.
//
// Two layers hold a machine to its contract, and neither repeats the other. The types below check
// everything a type can say, in the editor and in `bun check`: targets, exact data (through
// spreads too), payloads, JSON contracts, the graph. The compiler (../compiler, run by the bundler
// through ../plugin) checks only what types can't see (pure transitions, casts and suppressions,
// data whose runtime keys could differ from its type's), and compiles the machine to a table of
// plain functions. So at runtime there is no `setup`, `types` or `to`: this module's runtime is the
// actor, about the size of a few closures, and the tasks and timers module only when a machine has one.
//
// The design follows from who writes the code. An LLM writes a machine from memory of other
// libraries, and its feedback is `bun check` and `bun test`. So:
//
//   - One way to do each thing. A transition is a function that returns `to(state, data)` or
//     nothing (declined). There are no action creators, guard objects, string targets or aliases
//     to mix up with XState v4/v5 syntax.
//   - The shape comes first (`setup`): each state's data, each event's payload. The behaviour
//     (`machine`) is checked against it: a misspelled target, a missing or extra field, data
//     handed to a state that takes none, an event a state can't receive.
//   - Each state has its own data. There is no shared context with optional fields, so a state
//     can't read what it doesn't have, and the snapshot narrows on `snapshot.state`.
//   - The graph is checked by the type checker. A state no transition reaches, a state no
//     transition leaves (not final), or a task whose event its state doesn't handle, is a type
//     error whose message names the state and the fix.
//   - Data is JSON by type, so a snapshot can always be persisted and restored; a Date, a Map or
//     a function in a state's data is a type error naming the path.
//   - A state's task gets an AbortSignal that aborts when the state exits, and a result that
//     arrives after the exit is dropped. A move to the same state doesn't exit it, so where the
//     state has a task or timer, `to` to itself is a type error: `reenter` restarts the work with
//     the new data, and `keep` leaves it running. The stale-response race can't happen by accident.
//   - Runtime errors carry a code and the fix, and `transition` is pure, so a model can test a
//     machine without timers, promises or a DOM.
//
// Hierarchy is in the names. A leaf "edit.draft" has the parent "edit": the parent has no data, its
// handlers apply to every leaf under it, and the type of a parent's handler argument is the union
// over its leaves, so `state === "edit.review"` narrows `data`. A parallel node is declared in
// setup (`parallel: ["player"]`), since the snapshot's type depends on it: its data is its regions.

// #region Types

// The features' types, composed by the registry (./features.ts). The hierarchy's names are read for
// every machine: a flat one has no dotted names and no parallel nodes, so they reduce to its leaves.
import type {
  FeatureActorOptions,
  FeatureArgs,
  FeatureBrand,
  FeatureDeciders,
  FeatureKeys,
  FeatureOptions,
  FeatureProblems,
  FeatureShapeProblems,
  FeatureState,
  OffKeyProblem,
  OptIn,
  Uses,
} from "./features.ts";
import type { TimerProblem } from "./features/delays/types.ts";
import type { FinalEntry, FinalKey, Raises, ResultEffects } from "./features/effects/types.ts";
import type { History } from "./features/history/types.ts";
import type { Chain, LeavesUnder, NodeName, ParentName, ParentTarget, Prefixes } from "./features/nested/types.ts";
import type {
  InnerOf,
  InParallel,
  ParallelName,
  RegionSteps,
  Seen,
  Unit,
  UnitData,
} from "./features/parallel/types.ts";
// wave1-statecharts: what route and wildcards change in the core's graph checks.
import type { RouteTargets } from "./features/route/types.ts";
import type { FinalKey as TagsFinalKey, FinalTags } from "./features/tags/types.ts";
import type { Covered, Wildcard, WildcardOff } from "./features/wildcards/types.ts";

export type { FeatureName, NeedsOptIn, OptIn, Uses } from "./features.ts";
export type { History, NodeName, ParallelName, ParentName, Unit };

/** A type, carried as a value: the shape of a state's data or an event's payload. */
export interface Type<T> {
  // A method, so a Type<{ url: string }> is a Type<object> (methods are bivariant).
  "~type"(value: T): T;
}

/**
 * The shape of a state's data or an event's payload: `types<{ url: string }>()`. Only the
 * compiler reads it: a call that reaches runtime is a file the plugin didn't compile, and throws.
 */
export function types<T extends object>(): Type<T>;
/** Not an object (`types<void>()`, `types<number>()`): a contract is an object, and its type is the fix. */
export function types<_T>(): {
  readonly "types<T> takes an object type: types<{}>() for no payload, types<{ count: number }>() for a value": never;
};
export function types(): never {
  throw uncompiled();
}

/**
 * A Standard Schema v1 (https://standardschema.dev): zod, valibot or arktype's schemas, or one
 * written by hand. In setup in place of `types<T>()`, it is also checked at runtime. Only the part
 * the types read is here: no dependency on a schema library.
 */
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** A state's data, an event's payload or the input: `types<T>()`, or a Standard Schema. */
export type Contract =
  | Type<object>
  // Any input: a coerce's unknown is refused by name (validate's LooseInput), not as "not a Contract".
  | StandardSchema<unknown, object>
  // Nothing is one (a function would have to return never): it is there so that `types<T>`
  // without its call, a function, is compared with it, and the error prints the fix.
  | ((fix: "call types: types<{ by: string }>(), not types<{ by: string }>") => never);

/** What `setup` takes. */
export type Types = { readonly [name: string]: Contract };

declare const FEATURE: unique symbol;

/**
 * An opt-in: the value `@reactre/state/<name>` exports by that name, listed in setup's `use`
 * (`use: [nested, history]`). It carries the feature's runtime hooks, which the compiler puts in the
 * table, so a bundle holds a feature's code only when the app imports it.
 */
export interface Feature<N extends string = string> {
  readonly [FEATURE]?: N;
}

/**
 * What `setup` takes: the data of each state, the payload of each event, and the features it opts
 * into. Each feature in `use` may add options (`parallel`, `children`: ./features.ts).
 */
export interface Shape extends FeatureOptions {
  /**
   * The features this machine uses, each imported by name from its own entry:
   * `import { nested } from "@reactre/state/nested"`, then `use: [nested]`.
   */
  readonly use?: readonly (Feature | string)[];
  /** Each leaf's data. `types<{}>()` for none. A dotted name ("edit.draft") is under its parents (`nested`). */
  readonly states: Types;
  /** The events callers send, with their payloads. */
  readonly events: Types;
  /** Events only the machine's own tasks produce: `actor.send` doesn't take them. */
  readonly internal?: Types;
  /** What `createActor` must be given, for `start`. */
  readonly input?: Contract;
  /** Bumped when the states' data changes, so an old snapshot is refused on restore. */
  readonly version?: number;
  /**
   * The hash of the version and the contracts written here, which the build computes and checks: a
   * persisted machine has one, so changing its states or events without a new version fails the build.
   */
  readonly shape?: string;
}

/** What a contract holds: a `types<T>()`'s T, a schema's output. */
type DataOf<T> =
  T extends Type<infer X>
    ? X
    : T extends { readonly "~standard": { readonly types?: infer S } }
      ? NonNullable<S> extends { readonly output: infer O }
        ? O
        : never
      : never;

/** What a contract takes: a `types<T>()`'s T, a schema's input (`send` and `createActor` take it). */
type InputOf<T> =
  T extends Type<infer X>
    ? X
    : T extends { readonly "~standard": { readonly types?: infer S } }
      ? NonNullable<S> extends { readonly input: infer I }
        ? I
        : never
      : never;

/** Readonly all the way down: a transition builds new data, it never edits the old. */
export type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The names of a shape's states: its leaves. */
export type StateName<D extends Shape> = keyof D["states"] & string;

/** A leaf's name and data, as one of a union. */
export type Pair<D extends Shape, L> =
  L extends StateName<D> ? { readonly state: L; readonly data: Data<D, L> } : never;

/** A leaf's data. */
export type Data<D extends Shape, S extends StateName<D>> = DeepReadonly<DataOf<D["states"][S]>>;

type Internal<D extends Shape> = D extends { readonly internal: infer I extends Types } ? I : {};

/** The names of the events callers send. */
export type ExternalName<D extends Shape> = keyof D["events"] & string;

/** The names of every event a state may handle: sent ones and its tasks' own. */
export type EventName<D extends Shape> = ExternalName<D> | (keyof Internal<D> & string);

type ContractOf<D extends Shape, E> = E extends keyof D["events"]
  ? D["events"][E]
  : E extends keyof Internal<D>
    ? Internal<D>[E]
    : never;

/** An event, as handlers get it: `{ type, ...payload }` (a schema's output). */
export type EventOf<D extends Shape, E extends EventName<D>> = E extends unknown
  ? Simplify<{ readonly type: E } & DeepReadonly<DataOf<ContractOf<D, E>>>>
  : never;

/** The events `actor.send` takes (a schema's input). */
export type SendEvent<D extends Shape> =
  ExternalName<D> extends infer E
    ? E extends ExternalName<D>
      ? Simplify<{ readonly type: E } & DeepReadonly<InputOf<ContractOf<D, E>>>>
      : never
    : never;

/**
 * What a task's `run` resolves to: an event as it is sent (a schema's input), since the runtime
 * parses it as it parses a sent one, and the handler gets the output.
 */
export type TaskResult<D extends Shape> =
  EventName<D> extends infer E
    ? E extends EventName<D>
      ? Simplify<{ readonly type: E } & DeepReadonly<InputOf<ContractOf<D, E>>>>
      : never
    : never;

/** What `start` gets (a schema's output). */
export type Input<D extends Shape> = D extends { readonly input: infer I } ? DeepReadonly<DataOf<I>> : undefined;

/** What `createActor` is given, for `start` (a schema's input). */
export type ActorInput<D extends Shape> = D extends { readonly input: infer I } ? DeepReadonly<InputOf<I>> : undefined;

/**
 * A snapshot: the state and its data. `snapshot.state === "loading"` narrows `data`. For a parallel
 * node, `data` is its regions.
 */
export type Snapshot<D extends Shape> = {
  [U in Unit<D>]: ["history"] extends [Uses<D>]
    ? {
        readonly state: U;
        readonly data: UnitData<D, U>;
        readonly version: number;
        /** Only for a machine that uses `back`: each parent's unit when it was last left. */
        readonly history?: History<D>;
      }
    : { readonly state: U; readonly data: UnitData<D, U>; readonly version: number };
}[Unit<D>];

/** A snapshot with what its running nodes saved, from `persist` (@reactre/state/persist). */
export type Persisted<D extends Shape> = Snapshot<D> & { readonly run?: __Persisted["run"] };

// Brands of the types only: the compiler turns `to(state, data)` into the snapshot it makes,
// `({ state, data, version })`.
declare const NEXT: unique symbol;
declare const INNER: unique symbol;

/**
 * Where a transition goes: made by `to` or `back`, never by hand. `In` is the leaves it reaches
 * inside its target too (a parallel node's regions, a parent's history), for the graph checks.
 */
export interface Next<S extends string, In extends string = never> {
  readonly [NEXT]: S;
  readonly [INNER]?: In;
  readonly data: unknown;
}

/** Any transition of a machine of this shape. */
export type AnyNext<D extends Shape> = Next<NodeName<D>, StateName<D>>;

declare const HOW: unique symbol;

/**
 * A move to the leaf the handler runs in that says what happens to the leaf's task and timers:
 * `keep` leaves them running, reenter's `reenter` restarts them. The graph check tells it from a
 * plain `to`, which it reports in a state with a task or timer.
 */
export interface Same<S extends string, How extends "keep" | "reenter"> extends Next<S> {
  readonly [HOW]: How;
}

/** The leaves a handler of node N runs in: `keep`'s and `reenter`'s state. */
export type OwnLeaf<D extends Shape, N extends string> = Extract<Seen<D, N>, StateName<D>>;

/** `keep`'s or `reenter`'s state, when it isn't one the handler runs in: the error, worded as the fix. */
export type OwnTarget<D extends Shape, N extends string, S, Move extends string> =
  S extends OwnLeaf<D, N>
    ? S
    : `${Move} the state the handler runs in: "${S & string}" is another, so go there with to("${S & string}", ...)`;

/**
 * `T`, when it has no key the state's data lacks; otherwise a type naming each extra key, which
 * `T` isn't. TypeScript checks extra keys only in an object literal written in place: a spread
 * (`{ ...data, code }`) or a variable gets none. So `to` infers its data's whole type, and this
 * holds it to the state's keys. (Not an intersection: a key of literal type would make it `never`,
 * and the error would name nothing.) Each member of a union is held (a parent's `data`).
 */
export type Exactly<T, W, S extends string> = [ExtraKeys<T, W>] extends [never]
  ? [AnyPaths<T, "">] extends [never]
    ? T
    : {
        readonly [
          K in AnyPaths<
            T,
            ""
          > as `state "${S}"'s data has ${K} typed any: give it a type (parse it with validate, or narrow it) before it is data`
        ]: never;
      }
  : {
      readonly [K in ExtraKeys<T, W> as `state "${S}" has no field ${K & string}: list only its fields`]: never;
    };

/**
 * The fields of data `T` typed `any` (`JSON.parse`'s, `res.json()`'s), as `by` or `user.name`: any is
 * assignable to the state's field, so it would be data unchecked. Not T itself (a whole `any` is
 * assignable to any parameter), and not past a depth a recursive type repeats at.
 */
type AnyPaths<T, P extends string, Depth extends readonly unknown[] = []> = Depth["length"] extends 6
  ? never
  : T extends Primitive | undefined
    ? never
    : T extends readonly (infer I)[]
      ? 0 extends 1 & I
        ? `${P}[]`
        : AnyPaths<I, `${P}[]`, [...Depth, 0]>
      : T extends object
        ? {
            [K in keyof T & string]-?: 0 extends 1 & T[K]
              ? `${P}${P extends "" ? "" : "."}${K}`
              : AnyPaths<T[K], `${P}${P extends "" ? "" : "."}${K}`, [...Depth, 0]>;
          }[keyof T & string]
        : never;

/** The keys any member of `T` has and `W` lacks (`keyof` a union would give only the shared ones). */
type ExtraKeys<T, W> = T extends unknown ? Exclude<keyof T, keyof W> : never;

type StepData<D extends Shape, S> =
  S extends ParallelName<D> ? RegionSteps<D, S> : S extends StateName<D> ? Data<D, S> : never;

// Distributive: a misspelled target leaves S at the union of the states, and the error must be
// about the name ("opne" is not "closed" | "open"), not about how many arguments `to` takes.
type DataArgs<D extends Shape, S, T> = S extends unknown
  ? S extends ParallelName<D>
    ? [regions: Exactly<T, RegionSteps<D, S>, S>]
    : S extends StateName<D>
      ? keyof DataOf<D["states"][S]> extends never
        ? []
        : [data: Exactly<T, Data<D, S>, S>]
      : []
  : never;

/**
 * `to("loading", { url })`: go to a leaf, with its data (none for a state that takes none). A
 * parallel node takes a step for each region: `to("player", { playback: to("player.playback.stopped"), ... })`.
 */
export type To<D extends Shape> = <S extends NodeName<D>, T extends StepData<D, S>>(
  state: ParentTarget<D, S, ParallelName<D>>,
  ...data: DataArgs<D, S, T>
) => Next<S, S extends ParallelName<D> ? InnerOf<T> : never>;

/**
 * `keep("loading", { q })`: stay in the leaf the handler runs in, with new data, and leave its task
 * and timers running with the data they started with. `to` to the same leaf does the same, so in
 * a state with a task or timer it is a type error that asks for this, or reenter's `reenter`
 * (which restarts them with the new data).
 */
export type Keep<D extends Shape, N extends string> = <S extends StateName<D>, T extends StepData<D, S>>(
  state: OwnTarget<D, N, S, "keep stays in">,
  ...data: DataArgs<D, S, T>
) => Same<S, "keep">;

/**
 * What a handler that decides a transition gets besides its state and data: `to`, `keep`, and what
 * the features add (`back` with history; with a feature off, its argument is a function whose
 * parameter is the fix).
 */
export type Moves<D extends Shape, N extends string> = { readonly to: To<D>; readonly keep: Keep<D, N> } & FeatureArgs<
  D,
  N
>;

/**
 * A handler's argument in node `N`: for each leaf it may run in, that leaf's `state` and `data`,
 * with `X`. A union of whole objects, so `if (state === "edit.review")` narrows a destructured
 * `data` too.
 */
export type Args<D extends Shape, N extends string, X> =
  Seen<D, N> extends infer U
    ? U extends string
      ? Simplify<{ readonly state: U; readonly data: UnitData<D, U> } & X>
      : never
    : never;

/** What an event's handler gets. */
export type OnArgs<D extends Shape, N extends string, E extends EventName<D>> = Args<
  D,
  N,
  { readonly event: EventOf<D, E> } & Moves<D, N>
>;

/**
 * An event's handler: `to(...)`, or `null` to decline the event (a guard). `null`, not
 * `undefined`: TypeScript lets a function whose return type includes `undefined` end without a
 * `return`, so a forgotten `return` would decline every event without an error. In a parent, `null`
 * passes the event on to the next parent up.
 */
export type Handler<D extends Shape, N extends string, E extends EventName<D>> = (
  args: OnArgs<D, N, E>,
) => AnyNext<D> | null;

/** What a task's `run` gets. */
export type RunArgs<D extends Shape, N extends string> = Args<
  D,
  N,
  {
    /** Aborts when the node exits: pass it to `fetch` and to the model's client. */
    readonly signal: AbortSignal;
    /** v5's onDone habit: typed as the fix, so a call says what to return instead. */
    readonly to: NotHere<'run returns an event, { type: "stored", ...payload }, and the state\'s on moves with to(...): a task makes no step'>;
  }
>;

/** What a task's `error` gets: the leaf now, when it fails. */
export type ErrorArgs<D extends Shape, N extends string> = Args<D, N, { readonly error: unknown } & Moves<D, N>>;

/** What a timer's handler gets: the leaf now, when it fires. */
export type AfterArgs<D extends Shape, N extends string> = Args<D, N, Moves<D, N>>;

/**
 * Async work a node runs while it is active: it resolves to an event, which the node's `on` (or a
 * leaf's under it) handles, or it throws, and `error` picks the next state. Leaving aborts it.
 */
export interface Task<D extends Shape, N extends string> {
  readonly run: (args: RunArgs<D, N>) => Promise<TaskResult<D>>;
  readonly error: (
    args: ErrorArgs<D, N>,
  ) => AnyNext<D> | { readonly type: "error returns a step, to(state, data), not an event: the events come from run" };
  /** v5's: typed as the fix, so a handler written here says where it goes. */
  readonly onDone?: (
    fix: "a task takes run and error only: run's result is an internal event, handled in on, on: { stored: ({ event, to }) => to(...) }",
  ) => never;
  /** v5's: typed as the fix. */
  readonly onError?: (
    fix: "a task takes run and error only: error decides where a failure goes, error: ({ error, to }) => to(...)",
  ) => never;
}

/** A task's keys: run and error (`onDone` and `onError` are typed as the fix, and reported). */
type TaskKey = "run" | "error";

/**
 * `"500ms"`, `"5s"`, `"2m"`, `"1h"`. TypeScript's `${number}` takes a sign, an exponent, hex and
 * spaces too ("-5s", "1e3ms", "0x10s", " 5s", ".5s"), which the compiler can't read: the checks hold
 * every duration to `DurationProblem`'s grammar, digits with an optional fraction, then the unit.
 */
export type Duration = `${number}${"ms" | "s" | "m" | "h"}`;

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Digits<S> = S extends `${Digit}${infer R}` ? (R extends "" ? true : Digits<R>) : false;
/** Digits, with an optional fraction: "5", "0.5", "1000". No sign, exponent, hex, space or leading dot. */
type Decimal<N> = N extends `${infer I}.${infer F}` ? (Digits<I> extends true ? Digits<F> : false) : Digits<N>;
type Zero<N> = N extends "" ? true : N extends `${"0" | "."}${infer R}` ? Zero<R> : false;
type Chars<S, T extends readonly unknown[] = []> = S extends `${string}${infer R}` ? Chars<R, [...T, 0]> : T;
type Trim0<S> = S extends `0${infer R extends `${Digit}${string}`}` ? Trim0<R> : S;
/** a < b, for two digits. */
type Below<A, B> = A extends B
  ? false
  : "0123456789" extends `${string}${A & string}${string}${B & string}${string}`
    ? true
    : false;
/** Two digit strings, digit by digit: from the left for an integer part of one length, or a fraction. */
type Order<A, B> = A extends `${infer a}${infer RA}`
  ? B extends `${infer b}${infer RB}`
    ? a extends b
      ? Order<RA, RB>
      : Below<a, b> extends true
        ? "lt"
        : "gt"
    : Zero<A> extends true
      ? "eq"
      : "gt"
  : Zero<B> extends true
    ? "eq"
    : "lt";
type Split<N> = N extends `${infer I}.${infer F}` ? [Trim0<I>, F] : [Trim0<N>, ""];
/** Decimal A is greater than decimal B. */
type Greater<A, B> =
  Split<A> extends [infer AI, infer AF]
    ? Split<B> extends [infer BI, infer BF]
      ? Chars<AI> extends [...Chars<BI>, unknown, ...unknown[]]
        ? true
        : Chars<BI> extends [...Chars<AI>, unknown, ...unknown[]]
          ? false
          : Order<AI, BI> extends "gt"
            ? true
            : Order<AI, BI> extends "lt"
              ? false
              : Order<AF, BF> extends "gt"
                ? true
                : false
      : never
    : never;
/** setTimeout's limit, 2147483647ms (2^31 - 1, 24.8 days), in each unit: past it, a timer fires at once. */
interface Limit {
  readonly ms: "2147483647";
  readonly s: "2147483.647";
  readonly m: "35791.39411666666666666";
  readonly h: "596.52323527777777777";
}
type DurationOf<K, U extends keyof Limit> = K extends `${infer N}${U}`
  ? Decimal<N> extends true
    ? Zero<N> extends true
      ? "zero"
      : Greater<N, Limit[U]> extends true
        ? "long"
        : "ok"
    : "bad"
  : never;
type Reading<K> = K extends `${string}ms`
  ? DurationOf<K, "ms">
  : K extends `${string}s`
    ? DurationOf<K, "s">
    : K extends `${string}m`
      ? DurationOf<K, "m">
      : K extends `${string}h`
        ? DurationOf<K, "h">
        : "bad";

/**
 * A duration's text (`K`, which `Duration` takes) the timers can't use: `${What} is "-5s", ...`, worded
 * as the fix, or never. Not digits and a unit (the compiler would skip it, and the timer would be
 * gone); zero (it fires at once, a tick that hides a decision); past setTimeout's limit (it fires
 * at once too).
 */
export type DurationProblem<What extends string, K> = K extends string
  ? Reading<K> extends "bad"
    ? `${What} is "${K}", which isn't digits and a unit: write it as "5s", "1000ms" or "0.5s"`
    : Reading<K> extends "zero"
      ? `${What} is "${K}", a timer that fires at once: decide in the handler, or use always`
      : Reading<K> extends "long"
        ? `${What} is "${K}", past setTimeout's limit (2147483647ms, 24.8 days), so it would fire at once: wait on a durable host, or re-check sooner`
        : never
  : never;

declare const MACHINE: unique symbol;
declare const FINALS: unique symbol;

/** A spread of a machine, refused: the fix. */
type SpreadFix = "a spread of a machine isn't a machine: wrap the actor (inspect, provide) instead";

/**
 * A machine's brand, for the type checker only: a method declared in a class, which a spread drops
 * (TypeScript keeps a class's methods out of `{ ...value }`) while the shape's symbol stays. So a
 * use site tells `{ ...machine }` (the symbol, no method) from a machine (both) and from a compiled
 * table written by hand (neither). Optional, so a table is still a machine to the runtime's tests.
 */
declare abstract class Opaque {
  "~opaque"?(): void;
}

/** `M`, the argument as written, is a machine spread into an object: the fix. */
type NotSpread<M> = typeof MACHINE extends keyof M ? ("~opaque" extends keyof M ? unknown : SpreadFix) : unknown;

/**
 * A machine, for `createActor`, `restoreActor`, `transition`, `initial` and `useActor`: the table
 * the compiler writes, with the shape in its type only (and its final states, for a parent's
 * `done`). A `MachineError` isn't one, so a machine with problems can't be run.
 */
// An interface, so an error names it (`Machine<Shape, string>`), not its members.
export interface Machine<D extends Shape, F extends string = string> extends __Compiled, Opaque {
  readonly [MACHINE]?: D;
  readonly [FINALS]?: F;
}

/** What a machine's type holds: its shape, and its final leaves (for a parent's `done`). */
export type MachineInfo<M> = {
  readonly shape: M extends { readonly [MACHINE]?: infer CD } ? Extract<NonNullable<CD>, Shape> : never;
  readonly finals: M extends { readonly [FINALS]?: infer F } ? NonNullable<F> : never;
};

/** The core's keys of a node that handles events. */
interface CoreState<D extends Shape, N extends string> {
  readonly final?: false;
  readonly on?: { readonly [E in EventName<D>]?: Handler<D, N, E> };
  readonly task?:
    | Task<D, N>
    // Nothing is one: a bare function (v5's fromPromise) is compared with it, and the error prints the fix.
    | ((
        fix: "a task is an object, task: { run: async ({ data, signal }) => event, error: ({ to }) => to(...) }",
      ) => never);
  /** Timers, cancelled when the node exits: `after: { "30s": ({ to }) => to("timedOut") }`. */
  readonly after?: { readonly [K in Duration]?: (args: AfterArgs<D, N>) => AnyNext<D> } & {
    // A bare number is a problem naming its unit (`Extra`); typed here, so its handler still is.
    readonly [ms: number]: (args: AfterArgs<D, N>) => AnyNext<D>;
  };
}

/**
 * A node that handles events: a leaf that isn't final, or a parent. The features add their keys
 * (`children`, a parallel node's `done`): ./features.ts.
 */
export type ActiveState<D extends Shape, N extends string> = CoreState<D, N> & FeatureState<D, N>;

/** A leaf the machine ends in (or, in a parallel node's region, the region ends in). */
export interface FinalState {
  readonly final: true;
}

/** What `machine` takes: where it starts, and each node's behaviour. Parents are optional. */
export interface Config<D extends Shape> {
  // `null` is typed so that a start that declines is a problem of the machine, which names the fix
  // (TypeScript's own error would print the step's type alone). start gets no event: the machine
  // starts before any is sent, so only input and to.
  readonly start: (args: { readonly input: Input<D>; readonly to: To<D> }) => AnyNext<D> | null;
  // wave1-effects: a final state takes effects's `entry` (a problem naming the import when it's off),
  // and tags's `tags`, `meta` and `description` (wave2: the same).
  readonly states: {
    readonly [S in StateName<D>]: ActiveState<D, S> | (FinalState & FinalEntry<D, S> & FinalTags);
  } & {
    readonly [P in ParentName<D>]?: ActiveState<D, P> | FinalState;
  };
}

// #endregion

// #region Checks: the type checker reads the machine's graph

/** Any machine's config, as the checks read it. */
export type AnyConfig = {
  readonly start: (...args: never[]) => unknown;
  readonly states: { readonly [state: string]: unknown };
};

/** The states a function's result goes to, with the leaves it reaches inside them. */
// A result typed any (a call of a name the handler doesn't get, `back` in start: its own error) goes
// nowhere: read as every state, the reach would recurse without end (TS2589).
export type Target<F> = F extends (...args: never[]) => infer R
  ? 0 extends 1 & R
    ? never
    : R extends Next<infer S, infer I>
      ? S | I
      : never
  : never;

/** The states a function's result names itself (`to`'s first argument). */
export type Top<F> = F extends (...args: never[]) => infer R
  ? 0 extends 1 & R
    ? never
    : R extends Next<infer S, string>
      ? S
      : never
  : never;

type Values<T> = T[keyof T];
/** A node config's `on`, or none. */
export type OnOf<SC> = SC extends { readonly on: infer O } ? O : {};
type AfterOf<SC> = SC extends { readonly after: infer A } ? A : {};

/** A node's config, by name: never when the config doesn't have it. */
export type Cfg<C extends AnyConfig, N> = N extends keyof C["states"] ? C["states"][N] : never;

/** Every function of a node that decides a transition: the core's, and the features'. */
export type Deciders<SC> =
  | Values<OnOf<SC>>
  | (SC extends { readonly task: { readonly error: infer F } } ? F : never)
  | Values<AfterOf<SC>>
  | FeatureDeciders<SC>;

/** The states a node's transitions may go to, read from what its functions return. */
type Out<SC> = SC extends unknown ? Target<Deciders<SC>> : never;

/** A leaf's (or a parallel node's) outs: its own, and its parents'. */
type OutAll<C extends AnyConfig, N extends string> = Out<Cfg<C, Chain<N>>>;

type Graph<D extends Shape, C extends AnyConfig> = { [N in StateName<D> | ParallelName<D>]: OutAll<C, N> };

type Reach<G, Frontier extends keyof G, Seen extends keyof G> = [Frontier] extends [never]
  ? Seen
  : Reach<G, Exclude<G[Frontier] & keyof G, Seen | Frontier>, Seen | Frontier>;

// wave1-statecharts: a route is taken from any state, so its targets are reached from the start.
type Reached<D extends Shape, C extends AnyConfig> = Reach<
  Graph<D, C>,
  (Target<C["start"]> | RouteTargets<C>) & keyof Graph<D, C>,
  never
>;

type Unreachable<D extends Shape, C extends AnyConfig> = Exclude<StateName<D>, Reached<D, C>>;

/** Leaves (and keys the shape lacks, which are reported too) that no transition leaves. */
type Bare<SC, S> = [keyof OnOf<SC>] extends [never] ? S : never;
// A state outside the shape is its own error, and its handlers' `to` is any, so its reach is
// unknown: it is a dead end only with no handlers at all.
type DeadEnd<D extends Shape, C extends AnyConfig> = {
  [S in Exclude<keyof C["states"] & string, ParentName<D>>]: S extends StateName<D> | Bare<Cfg<C, S>, S>
    ? Cfg<C, S> extends FinalState
      ? never
      : [OutAll<C, S>] extends [never]
        ? S
        : never
    : never;
}[Exclude<keyof C["states"] & string, ParentName<D>>];

/** The events a node config's task resolves to, by name. */
export type TaskEvent<SC> = SC extends { readonly task: { readonly run: (...args: never[]) => Promise<infer E> } }
  ? E extends { readonly type: infer T extends string }
    ? T
    : never
  : never;

/** The events a leaf's chain (the leaf and its parents) handles. */
// wave1-statecharts: `Covered` reads a wildcard key ("*", "a.*") as the events it matches.
type HandledOn<D extends Shape, C extends AnyConfig, L extends string> = {
  [K in Chain<L> & keyof C["states"]]: Covered<D, keyof OnOf<C["states"][K]>>;
}[Chain<L> & keyof C["states"]];

/** A node's task's events that some leaf under it (or the leaf itself) has no handler for. */
type IgnoredBy<D extends Shape, C extends AnyConfig, N extends string> = (
  N extends StateName<D> ? N : LeavesUnder<D, N>
) extends infer L
  ? L extends string
    ? Exclude<TaskEvent<Cfg<C, N>>, HandledOn<D, C, L>>
    : never
  : never;

type Ignored<D extends Shape, C extends AnyConfig> = {
  [S in keyof C["states"] & string]: `${S}" ignores its task's event "${IgnoredBy<D, C, S>}`;
}[keyof C["states"] & string];

/** The events some node handles. */
// wave1-statecharts: with wildcards, through `Covered`.
type HandledAnywhere<D extends Shape, C extends AnyConfig> = {
  [S in keyof C["states"]]: Covered<D, keyof OnOf<C["states"][S]>>;
}[keyof C["states"]];

/** The internal events some node's task produces. */
type ProducedAnywhere<C extends AnyConfig> = { [S in keyof C["states"]]: TaskEvent<C["states"][S]> }[keyof C["states"]];

/** The internal events that can arrive at a node: its tasks', its parents' and the nodes' under it. */
type Arriving<C extends AnyConfig, N extends string> = {
  [K in Extract<keyof C["states"], Chain<N> | `${N}.${string}`>]: TaskEvent<C["states"][K]>;
}[Extract<keyof C["states"], Chain<N> | `${N}.${string}`>];

/** Per node, the internal events it handles that no task on its chain produces: they never arrive there. */
type Stray<D extends Shape, C extends AnyConfig> = {
  [S in keyof C["states"] & string]: `state "${S}" handles internal event "${Exclude<
    keyof OnOf<C["states"][S]> & keyof Internal<D> & string,
    Arriving<C, S>
  >}", which its own task doesn't produce: only the current state's task's events arrive`;
}[keyof C["states"] & string];

/**
 * The states a function's result goes to with a plain `to`: not `keep`'s or `reenter`'s move. A
 * handler whose `to` lost its type (a misspelled key: its own problem) goes nowhere here.
 */
export type Plain<F> = F extends (...args: never[]) => infer R
  ? 0 extends 1 & R
    ? never
    : R extends Same<string, "keep" | "reenter">
      ? never
      : R extends Next<infer S, string>
        ? S
        : never
  : never;

/** The work a node's config starts when it is entered: its task, its timers (`after`, `timeout`). */
type Work<SC> =
  | (SC extends { readonly task: object } ? "task" : never)
  | ([keyof AfterOf<SC>] extends [never] ? (SC extends { readonly timeout: unknown } ? "timers" : never) : "timers");

/** How the stay problem names the work it leaves running. */
type StayWords<W> = [W] extends ["task"]
  ? { readonly work: "its task keeps"; readonly it: "it"; readonly them: "it" }
  : [W] extends ["timers"]
    ? { readonly work: "its timers keep"; readonly it: "they"; readonly them: "them" }
    : { readonly work: "its task and timers keep"; readonly it: "they"; readonly them: "them" };

type StayProblem<
  D extends Shape,
  S extends string,
  X extends { readonly work: string; readonly it: string; readonly them: string },
> = `state "${S}" goes to itself with to(...), and ${X["work"]} running with the data ${X["it"]} started with: write reenter("${S}", ...) to restart ${X["them"]} with the new data${[
  "reenter",
] extends [Uses<D>]
  ? ""
  : ` (${OptIn<"reenter">})`}, or keep("${S}", data), with the data ${X["it"]} started with, to leave ${X["them"]} running`;

/**
 * Leaves with a task or timer that a handler of their own moves to with a plain `to`. The move
 * doesn't exit the leaf, so the work keeps the data it started with: a typeahead's old query lands
 * on the new one, a debounce never restarts, a poll fires once. The model must say which it means.
 */
type Stay<D extends Shape, C extends AnyConfig> = {
  [S in StateName<D> & keyof C["states"]]: [Work<C["states"][S]>] extends [never]
    ? never
    : S extends Plain<Deciders<C["states"][S]>>
      ? StayProblem<D, S, StayWords<Work<C["states"][S]>>>
      : never;
}[StateName<D> & keyof C["states"]];

/** The paths in a task's result typed `any` (`res.json()`, `JSON.parse`) or `unknown`. */
type Untyped<T, P extends string> = 0 extends 1 & T
  ? `${P} typed any`
  : unknown extends T
    ? `${P} typed unknown`
    : T extends Primitive | undefined
      ? never
      : T extends readonly (infer I)[]
        ? Untyped<I, `${P}[]`>
        : T extends object
          ? { [K in keyof T & string]-?: Untyped<T[K], `${P}.${K}`> }[keyof T & string]
          : never;

/** The events a node's task resolves to, as `run` returns them. */
type RunEvent<SC> = SC extends { readonly task: { readonly run: (...args: never[]) => Promise<infer E> } } ? E : never;

/** A task's result is a boundary: an `any` in it would reach the state's data unchecked. */
type Unchecked<C extends AnyConfig> = {
  [S in keyof C["states"] & string]: RunEvent<C["states"][S]> extends infer E
    ? E extends { readonly type: infer T extends string }
      ? `state "${S}"'s task resolves to "${T}" with ${{
          [K in Exclude<keyof E, "type"> & string]-?: Untyped<E[K], K>;
        }[Exclude<keyof E, "type"> &
          string]}: check what you parse (res.json() and JSON.parse return any), and build the event from the checked value`
      : never
    : never;
}[keyof C["states"] & string];

/** A task resolving to a sent event: the app can send its result too, forged. */
type Public<D extends Shape, C extends AnyConfig> = {
  [S in keyof C["states"] & string]: `the task in "${S}" resolves to "${TaskEvent<C["states"][S]> &
    ExternalName<D>}", a public event: declare it in internal`;
}[keyof C["states"] & string];

/** The timers' keys of each config in a union (`keyof` a union would give only the shared ones). */
type AfterKeys<SC> = SC extends unknown ? keyof AfterOf<SC> : never;

/**
 * Leaves whose own task could hang them for good: no timer on their chain (`after`, `timeout`), no
 * child that could end, and no sent event their chain handles. With route in use, a route leaves any.
 */
type Hangs<D extends Shape, C extends AnyConfig> = ["route"] extends [Uses<D>]
  ? never
  : {
      [S in StateName<D> & keyof C["states"]]: C["states"][S] extends { readonly task: object }
        ? [AfterKeys<Cfg<C, Chain<S>>>] extends [never]
          ? [Extract<Cfg<C, Chain<S>>, { readonly timeout: unknown } | { readonly children: unknown }>] extends [never]
            ? [Extract<HandledOn<D, C, S>, ExternalName<D>>] extends [never]
              ? S
              : never
            : never
          : never
        : never;
    }[StateName<D> & keyof C["states"]];

/** Keys of a task other than run and error: v5's onDone, onError, src, input. */
type TaskKeys<C extends AnyConfig> = {
  [S in keyof C["states"] & string]: C["states"][S] extends { readonly task: infer T extends object }
    ? T extends (...args: never[]) => unknown
      ? never
      : `state "${S}"'s task has "${Exclude<keyof T, TaskKey> & string}", which a task doesn't take: it takes run and error only, and run's result is an internal event, handled in on`
    : never;
}[keyof C["states"] & string];

// A const type parameter is inferred from the literal, and an inferred type gets no excess
// property check: a misspelled event, a state the shape lacks, or XState's `entry` would be
// ignored without an error. So the checks list the keys the config has and shouldn't.

/** Where to go instead, for the keys other libraries use. */
type Hint<K> = K extends "entry" | "exit"
  ? `: do it in the handler that goes to or leaves the state, or in a task`
  : K extends "invoke"
    ? `: use task: { run, error }`
    : K extends "always"
      ? `: decide in the handler that goes to the state, with a ternary over to(...)`
      : K extends "context"
        ? `: each state's data is declared in setup's states, and given by to(state, data)`
        : K extends "initial"
          ? `: use start: ({ to }) => to(state, data)`
          : K extends "type"
            ? `: use final: true`
            : K extends "done" | "onDone"
              ? `: only a parallel node takes done (every region final); a child's goes in children: { name: { done } }`
              : "";

/** The core's keys of a node; the features in use add theirs (`FeatureKeys`). */
type StateKey = "final" | "on" | "task" | "after";

/** A key state S doesn't take: an off feature's (naming its opt-in), or one no feature has (with a hint). */
type KeyProblem<D extends Shape, S extends string, K> = [OffKeyProblem<D, S, K>] extends [never]
  ? `state "${S}" has "${K & string}", which states don't take${K extends EventName<D> ? `: handle the event in on, on: { ${K & string}: ... }` : Hint<K>}`
  : OffKeyProblem<D, S, K>;

type Extra<D extends Shape, C extends AnyConfig> =
  | {
      [K in Exclude<keyof C, "start" | "states"> & string]: `"${K}" is not a machine option${Hint<K>}`;
    }[Exclude<keyof C, "start" | "states"> & string]
  | `state "${Exclude<keyof C["states"], NodeName<D>> & string}" is not in the shape: add it to setup's states, or remove it`
  | {
      [S in keyof C["states"] & string]:
        | {
            [K in Exclude<keyof C["states"][S], StateKey | FeatureKeys<D, S>> & string]: KeyProblem<D, S, K>;
          }[Exclude<keyof C["states"][S], StateKey | FeatureKeys<D, S>> & string]
        // wave1-statecharts: a wildcard key is wildcards' (named by WildcardOff when it is off).
        | `state "${S}" handles "${Exclude<keyof OnOf<C["states"][S]>, EventName<D> | Wildcard<D>> & string}", which is not an event in the shape: check the name, or add it to setup's events`
        | WildcardOff<D, S, keyof OnOf<C["states"][S]>>
        // wave1-effects: delays's keys (ISO durations, named delays) are timers too, with it on.
        | `${TimerProblem<D, S, Exclude<keyof AfterOf<C["states"][S]>, Duration> & (string | number)>}`
        | `${DurationProblem<`state "${S}"'s timer`, Extract<keyof AfterOf<C["states"][S]>, Duration>>}`
        | (C["states"][S] extends FinalState
            ? S extends ParentName<D>
              ? `state "${S}" is a parent, and only leaves are final: mark the leaves it ends in { final: true }`
              : // wave1-effects: `entry` is effects's key on a final state too (its opt-in is checked above).
                `state "${S}" is final and has "${Exclude<keyof C["states"][S], "final" | FinalKey | TagsFinalKey> & string}": a final state takes no events, tasks or timers. Remove it, or drop final`
            : never);
    }[keyof C["states"] & string];

/** What the type checker found wrong in a machine, worded as the fix. */
export type Problem<D extends Shape, C extends AnyConfig> =
  | Extra<D, C>
  // A start that goes nowhere (null, or its own error) is its own problem: every state would read as unreachable.
  | `state "${[Target<C["start"]>] extends [never] ? never : Unreachable<D, C>}" is unreachable: no transition goes to it. Add one, or remove the state`
  | `state "${DeadEnd<D, C> & string}" is a dead end: no transition leaves it. Add one, or mark it { final: true }`
  | `state "${Ignored<D, C>}": add a handler for it to the state's "on"`
  | `event "${Exclude<ExternalName<D>, HandledAnywhere<D, C>>}" is declared but no state handles it: handle it, or remove it from setup's events`
  | `${Stay<D, C>}`
  | `${Unchecked<C>}`
  | `${Public<D, C>}`
  | `state "${Hangs<D, C>}" runs a task and no public event or timer leaves it: add a cancel event, an after, or a timeout`
  | ([Target<C["start"]>] extends [Finals<D, C>]
      ? `start goes to "${Target<C["start"]> & string}", a final state: the actor would be done before it starts; start in a state that does the work`
      : never)
  | `${TaskKeys<C>}`
  | (C["start"] extends (...args: never[]) => infer R
      ? 0 extends 1 & R
        ? never
        : null extends R
          ? `start can't decline with null: it returns the state the machine starts in, to(state, data), deciding from input`
          : never
      : never)
  // wave1-effects: with effects, a handler raises internal events too (`enq.raise`), which a type
  // can't see: the two checks of where internal events come from are the tasks-only machine's.
  | (Raises<D> extends true
      ? never
      : // In a template, so the error prints the strings, not these aliases.
        | `internal event "${Exclude<keyof Internal<D> & string, ProducedAnywhere<C>>}" is never produced by a task: produce it, or remove it`
        | `${Stray<D, C>}`)
  | `${FeatureProblems<D, C>}`;

/**
 * A machine with problems in its graph. `createActor`, `transition` and `initial` refuse it, and
 * the type error quotes the problems.
 *
 * Why the problems are the result's type and not an error on `machine`'s argument: any mention of
 * the config's type parameter beside the bare parameter (an intersection, a constraint, `this`, a
 * rest parameter) makes TypeScript fix it before the handlers' `to` and `data` are typed, so a
 * correct machine fails too.
 */
export interface MachineError<P extends string> {
  readonly problems: P;
}

/** The leaves the machine ends in (a region's final leaves end the region, not the machine). */
type Finals<D extends Shape, C extends AnyConfig> = {
  [S in StateName<D>]: Cfg<C, S> extends FinalState ? (S extends InParallel<D> ? never : S) : never;
}[StateName<D>];

/** The shape, with what the features in use carry for the app's functions (`children`'s "~children"). */
type Branded<D extends Shape, C extends AnyConfig> = Endless<
  [keyof FeatureBrand<D, C>] extends [never] ? D : D & FeatureBrand<D, C>,
  Finals<D, C>
>;

/** A machine with no final state carries it in its shape, so toPromise can refuse its actor. */
type Endless<D, F> = [F] extends [never] ? D & { readonly "~endless"?: true } : D;

/** `machine`'s result: the machine, or its problems. */
export type Checked<D extends Shape, C extends AnyConfig> =
  // A config with a type error where it is written (`tags: "busy"`, `back` in start) isn't
  // inferred: C falls back to Config<D> itself, whose graph would only report what isn't wrong (a
  // handler missing, an `entry` no one wrote) or run too deep (TS2589). The error where it is
  // written is the one to fix, so the machine adds none.
  [Config<D>] extends [C]
    ? Machine<D, never>
    : [Problem<D, C>] extends [never]
      ? Machine<Branded<D, C>, Finals<D, C>>
      : MachineError<Spelled<Problem<D, C>>>;

/** The problems as their strings: an error printing `Problem<{ ... }>` would show none of them. */
type Spelled<P> = P extends string ? `${P}` : never;

type Primitive = string | number | boolean | null;

/**
 * The paths in T that JSON can't hold, that turn checking off, that hold more than they say (a
 * field typed `{}` or `object` accepts a string, an array or a function), or that may be missing
 * (an optional field: `T | null` is a field always there). `Top` is a state's data or a payload
 * itself, which may be `{}` (no fields).
 */
type NotJson<T, P extends string, Top extends boolean = false, Depth extends readonly unknown[] = []> = 0 extends 1 & T
  ? `${P} (any: write the type)`
  : unknown extends T
    ? `${P} (unknown: write the type)`
    : [T] extends [never]
      ? `${P} (never, an empty literal's type: write its type, as string[] for an empty list)`
      : // A recursive type (a tree) is JSON: past this depth it is the same type again, read already.
        Depth["length"] extends 12
        ? never
        : NotJsonOf<T, P, Top, Depth>;

/**
 * What JSON can't hold in a value the features hand on (a child's input, a journaled step's result,
 * step logic's context): each path, with why, as `input.parent (an object with methods: ...)`.
 */
export type NotJsonPath<T, P extends string, Top extends boolean = true> = NotJson<T, P, Top>;

/** The prototype names a parsed object can't own as its fields (`__proto__` sets the prototype). */
type ProtoName = "__proto__" | "constructor" | "prototype" | "toString" | "valueOf" | "hasOwnProperty";

type NotJsonOf<T, P extends string, Top extends boolean, Depth extends readonly unknown[]> = T extends Primitive
  ? never
  : T extends undefined
    ? `${P} (undefined: write null for no value, T | null, and give null)`
    : T extends (...args: never[]) => unknown
      ? `${P} (a function)`
      : T extends Date
        ? `${P} (a Date: store an ISO string or a number)`
        : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
          ? `${P} (a Map or Set: store an array or a record)`
          : T extends bigint | symbol
            ? `${P} (a bigint or symbol)`
            : T extends readonly unknown[]
              ? Top extends true
                ? `${P} (an array: a contract is an object, so name the list, types<{ items: string[] }>())`
                : number extends T["length"]
                  ? [T[number]] extends [never]
                    ? `${P} (never[], an empty array's type: write its element type, as string[])`
                    : NotJson<T[number], `${P}[]`, false, [...Depth, 0]>
                  : `${P} (a tuple: use an array, or an object with named fields)`
              : T extends object
                ? string extends keyof T
                  ? `${P} (an index signature: list the fields)`
                  : [Extract<keyof T, symbol>] extends [never]
                    ? [keyof T] extends [never]
                      ? Top extends true
                        ? never
                        : `${P} ({} or object: it accepts a string, an array or a function. Write its fields)`
                      : // Read before the fields: a DOM node's run deep enough that TypeScript gives up (TS2589).
                        [Methods<T>] extends [never]
                        ? {
                            // An optional field is a contract loosened: a handler may leave it
                            // out, and every reader then checks for it (M307).
                            [K in keyof T & string]-?: K extends ProtoName
                              ? `${P}.${K} (a prototype name, which a parsed object can't own as a field: rename it)`
                              : {} extends Pick<T, K>
                                ? `${P}.${K} (optional: a handler may leave it out. Make it required, with null for no value: ${K}: T | null)`
                                : NotJson<T[K], `${P}.${K}`, false, [...Depth, 0]>;
                          }[keyof T & string]
                        : `${P} (an object with methods: a class instance, a DOM node, an actor or a Promise, which JSON can't hold. Store plain data: an id, or the fields you need)`
                    : `${P} (a symbol key, which JSON drops: use a string field)`
                : `${P}`;

/** The keys of T whose values are functions: an object that has any isn't plain data. */
type Methods<T> = { [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T];

/**
 * A Standard Schema whose output the JSON check can't blame on the user: one that doesn't type it
 * (no `~standard.types`), or one whose library types it `any`. The fix, or never.
 */
type SchemaProblem<C, P extends string> = C extends { readonly "~standard": infer S }
  ? S extends { readonly types?: infer T }
    ? NonNullable<T> extends { readonly output: infer O }
      ? 0 extends 1 & O
        ? `${P} is a schema whose library types its output any: give the schema an output type (z.object({ ... }), not z.any() or z.custom()), or use types<T>()`
        : never
      : `${P} is a Standard Schema without ~standard.types, so its output has no type: use a library that types it (zod, valibot, arktype), or types<T>()`
    : never
  : never;

type TypeProblems<T extends Types, What extends string> = {
  [K in keyof T & string]:
    | ([SchemaProblem<T[K], `${What} "${K}"`>] extends [never]
        ? NotJson<DataOf<T[K]>, `${What} "${K}"`, true>
        : SchemaProblem<T[K], `${What} "${K}"`>)
    | ("type" extends keyof DataOf<T[K]> ? `${What} "${K}".type (reserved for the event's name)` : never);
}[keyof T & string];

/** The last segment of a state's name: `draft` of `edit.draft`. */
type LastSegment<N extends string> = N extends `${string}.${infer R}` ? LastSegment<R> : N;

/**
 * Which of leaf `S` and its parents a field named `K` repeats: `isOpen`, `hasOpen` or `open` in
 * "open" (`isEdit` in "edit.draft"), where it can only be true. Another state's name isn't one: a
 * choice's `vip: boolean` picks the state "vip", and says nothing of where the machine is.
 */
type Repeats<S extends string, K extends string> = {
  [N in S | Prefixes<S>]: Lowercase<K> extends
    Lowercase<LastSegment<N>> | `is${Lowercase<LastSegment<N>>}` | `has${Lowercase<LastSegment<N>>}`
    ? N extends S
      ? `the state it is in: the state is the flag. Remove the field, and read snapshot.state === "${N}"`
      : `its parent "${N}": the state is the flag. Remove the field, and read isIn(snapshot, "${N}")`
    : never;
}[S | Prefixes<S>];

/** A boolean in a state's data named after the state: what `snapshot.state` says already (M41). */
type FlagProblems<D extends Shape> = {
  [S in StateName<D>]: {
    [K in keyof DataOf<D["states"][S]> & string]: 0 extends 1 & DataOf<D["states"][S]>[K]
      ? never
      : [DataOf<D["states"][S]>[K]] extends [boolean]
        ? `state "${S}" has "${K}", a flag that repeats ${Repeats<S, K>}`
        : never;
  }[keyof DataOf<D["states"][S]> & string];
}[StateName<D>];

type ShapeProblem<D extends Shape> =
  | `${FlagProblems<D>}`
  | `not JSON: ${TypeProblems<D["states"], "state">}`
  | `not JSON: ${TypeProblems<D["events"], "event">}`
  | `not JSON: ${TypeProblems<Internal<D>, "event">}`
  | `event "${keyof D["events"] & keyof Internal<D> & string}" is both sent and internal: rename one`
  | NameProblems<keyof D["states"], "state">
  | NameProblems<keyof D["events"] | keyof Internal<D>, "event">
  | `event "${Extract<keyof D["events"] | keyof Internal<D>, `${string}*${string}`> & string}" has * in its name, which wildcards read as a pattern: rename it`
  | {
      [
        N in UseNames<D>
      ]: `use lists "${N}", a name: list the feature itself, import { ${N} } from "@reactre/state/${N}", then use: [${N}]`;
    }[UseNames<D>]
  | `${FeatureShapeProblems<D>}`
  | `setup has no option "${Exclude<keyof D, keyof Shape> & string}": it takes use, states, events, internal, input and version, and what a feature in use adds (parallel, children)`;

/** The names of Object.prototype's members: a lookup by such a name finds the prototype's. */
type PrototypeMember = keyof Object | "__proto__" | "__defineGetter__" | "__lookupGetter__";

/**
 * A kind's names (`What`: states, or events and internal ones) that mislead: a number (its key
 * reorders, and it never equals the number), an Object.prototype member's, or two that differ only
 * by case.
 */
type NameProblems<Names, What extends string> =
  | `${What} ${Extract<Names, number>} is named by a number, whose key reorders and never equals it: name it with a word ("step${Extract<Names, number>}")`
  | `${What} "${Extract<Names, PrototypeMember> & string}" is named after an Object.prototype member: rename it`
  | {
      [
        K in Names & string
      ]: `${What}s "${K}" and "${Exclude<Names & string, K> extends infer J ? (J extends string ? (Lowercase<J> extends Lowercase<K> ? J : never) : never) : never}" differ only by case: rename one`;
    }[Names & string];

/** The names (strings) setup's `use` lists, where features belong. */
type UseNames<D> = D extends { readonly use: readonly (infer F)[] } ? Extract<F, string> : never;

/** No problems: nothing to add. Problems: required keys of type never, which the error names. */
export type ShapeCheck<D extends Shape> = [ShapeProblem<D>] extends [never]
  ? unknown
  : { readonly [K in ShapeProblem<D>]: never };

// #endregion

// #region Runtime

/** `setup(shape).machine(config)`. */
export interface Setup<D extends Shape> {
  machine<const C extends Config<D>>(config: C): Checked<D, C>;
}

/** An error of this library: its code, what went wrong and what to do. */
export class StateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[@reactre/state ${code}] ${message}`);
    this.code = code;
  }
}

function uncompiled(): StateError {
  return new StateError(
    "S0",
    'this file wasn\'t compiled. Add the plugin before any plugin that strips types: in Vite, `import state from "@reactre/state/plugin/vite"` and `plugins: [state(), ...]`.',
  );
}

/**
 * Declare the shape: each state's data and each event's payload. Then write the behaviour with
 * `.machine({ start, states })`, which the type checker and the compiler hold to it. The compiler
 * removes the call: one that reaches runtime is a file the plugin didn't compile, and throws.
 */
export function setup<const D extends Shape>(shape: D & ShapeCheck<D>): Setup<D>;
export function setup(_shape: Shape): never {
  throw uncompiled();
}

/** Internal: an exported shape, compiled. Its `machine` is for the file that calls `setup`. */
export function __shape(): { machine(): never } {
  return {
    machine() {
      throw new StateError(
        "S4",
        "machine() is called on a shape from another file. Call shape.machine({ ... }) in the file that calls setup(), and export the machine.",
      );
    },
  };
}

/**
 * Why `send` or `transition` didn't move: `unhandled` (the state has no handler for the event),
 * `declined` (the handler returned `null`), `unknown` (internal, or not an event of the machine),
 * `invalid` (the payload failed its schema; `issues` says how), `inactive` (the actor is done or
 * stopped).
 */
export type Refusal = __Refusal;

/** What `send` and `transition` return. */
export type Result<D extends Shape> =
  // wave1-effects: with effects in use, what the transition enqueued, unrun (`fx`).
  | ({ readonly ok: true; readonly snapshot: Snapshot<D> } & ResultEffects<D>)
  | {
      readonly ok: false;
      readonly reason: Refusal;
      readonly snapshot: Snapshot<D>;
      /** For `invalid`: what the schema said. */
      readonly issues?: readonly __Issue[];
    };

/**
 * `isIn(snapshot, "edit")`: the snapshot is in a leaf under `edit` (or is the parallel node
 * `edit`). A type guard: it narrows to those states.
 */
export function isIn<S extends { readonly state: string }, P extends Prefixes<S["state"]> | S["state"]>(
  snapshot: S,
  parent: P,
): snapshot is Extract<S, { readonly state: P | `${P}.${string}` }> {
  return snapshot.state === parent || snapshot.state.startsWith(`${parent}.`);
}

// The runtime works on the compiled table (./internal.ts). The compiler checked its contract, so the
// runtime checks only what comes from outside the build: an event's type and payload, a restored
// snapshot.

export type * from "./internal.ts";
import type {
  __Compiled,
  __Event,
  __Issue,
  __Live,
  __Options,
  __Persisted,
  __Refusal,
  __Result,
  __Snapshot,
  __Step,
  __To,
} from "./internal.ts";

/**
 * Internal: the data of every `to` without data (`to("closed")`): one object, so no step allocates
 * it. Frozen in production too, since every snapshot without data shares it.
 */
export const __none: object = /* @__PURE__ */ Object.freeze({});

/**
 * Internal: the snapshot a step leads to from `from`. A machine with a hierarchy (`m.g`) builds
 * regions and keeps history; a flat one's step is its snapshot.
 */
export function __snap(m: __Compiled, step: __Step, from?: __Snapshot): __Snapshot {
  // No graph: a flat machine, whose steps are all `to`s (back and reenter come with a graph). `m.d`
  // (development) freezes the data in place.
  return m.g?.snap(m, step, from) ?? (m.d?.((step as __To).data), step as __To);
}

/**
 * A use site's `this`: nothing for a machine or snapshot with a type. For one typed `any` (a cast,
 * `JSON.parse`, an untyped import), which would turn every check off, it is the fix, and a call
 * (whose `this` is `void`) is the type error: `any` is assignable to any parameter, so only `this`
 * can refuse it. `M` is the argument as written, which the parameter `Given<M> & Machine<D>` infers.
 */
export type NotAny<M, Fix extends string, Else = unknown> = 0 extends 1 & M ? Fix : Else;

/**
 * A parameter's part that infers the argument as written (`M`) and adds nothing to its type, unless
 * it is `any`: TypeScript infers a type parameter through a conditional's branches, and the
 * conditional is `unknown` for anything else, so an error prints `Machine<…>` alone, as before.
 */
export type Given<M> = 0 extends 1 & M ? M : unknown;

/** The fix for a machine typed `any`. */
export type AnyMachine =
  "the machine is typed any, so nothing about it is checked: pass the value .machine() returned, without a cast or an any annotation";

/** The fix for a type argument `any` (`createActor<any>(machine)`): `D` is the shape it gives. */
export type AnyShape =
  "the type argument is any, so nothing about the machine is checked: leave it out, the machine gives it";

/** The fix for an event typed `any` (`send(JSON.parse(text))`). */
export type AnySent =
  "send takes an event typed any (JSON.parse returns any): parse it with validate's schema, or narrow it to the machine's events";

/** The fix for input typed `any` (`{ input: JSON.parse(text) }`). */
export type AnyInput =
  "createActor's input is typed any (JSON.parse returns any): parse it with the machine's input schema, or narrow it";

/** `options`' input, when it is typed any: the fix. */
type InputNotAny<O> = 0 extends 1 & O
  ? AnyInput
  : [O] extends [{ readonly input: infer I }]
    ? NotAny<I, AnyInput>
    : unknown;

/** A durable run's snapshot (`run.snapshot()`), which restoreActor would run outside its journal. */
type NotDurable<S, Else = unknown> = S extends
  { readonly entries: unknown } | { readonly tasks: unknown } | { readonly timers: unknown }
  ? "restoreActor takes a snapshot from persist; a durable run's snapshot resumes with durable(machine, host).resume(snapshot)"
  : Else;

/**
 * Another machine's snapshot (M574): its state names a state the machine lacks. A state typed
 * string (a snapshot built by hand, widened) is the parameter's own check.
 */
type OwnSnapshot<D extends Shape, S> = S extends { readonly state: infer T extends string }
  ? string extends T
    ? unknown
    : [Exclude<T, Snapshot<D>["state"]>] extends [never]
      ? unknown
      : "the snapshot's state isn't one of this machine's: it is another machine's snapshot. Restore it into the machine whose actor persist saved it"
  : unknown;

/** The fix for a snapshot typed `any`. */
export type AnySnapshot =
  "the snapshot is typed any (JSON.parse returns any), so its state and data go unchecked: read it with migrations(machine) from @reactre/state/persist, restoreActor(machine, migrations(machine)(JSON.parse(text)))";

/** The snapshot `start` gives for `input`: pure, no task or timer runs. */
export function initial<D extends Shape, M = unknown>(
  this: NotAny<M, AnyMachine, ShapeNotAny<D, M>>,
  machine: Given<M> & Machine<D>,
  input: ActorInput<D>,
): Snapshot<D>;
export function initial(m: __Compiled, input: unknown): __Snapshot {
  return __snap(m, m.i(input));
}

/**
 * Internal: the pure step. `internal` is true for an event from the machine's own tasks or
 * children, which callers can't send. A machine with a hierarchy or schemas steps through `m.y`.
 */
export function __step(m: __Compiled, from: __Snapshot, event: __Event, internal: boolean): __Result {
  if (!internal && !m.e[event.type]) return { ok: false, reason: "unknown", snapshot: from };
  // A flat machine's fallback is its own call; a feature's hook takes the internal-event flag too.
  return m.y?.(m, from, event, internal) ?? __flat(m, from, event);
}

/**
 * Internal: the flat step: the leaf's handler for `e`. A step hook that wraps no other (a flat
 * machine's `validate`) calls it.
 */
export function __flat(m: __Compiled, from: __Snapshot, e: __Event): __Result {
  const next = m.o[from.state]?.[e.type]?.(from.data, e, from.state);
  return next
    ? { ok: true, snapshot: __snap(m, next) }
    : { ok: false, reason: next === null ? "declined" : "unhandled", snapshot: from };
}

/**
 * The snapshot an event leads to from `snapshot`: pure, no task or timer runs. A test can walk a
 * machine with it, event by event, without an actor.
 */
export function transition<D extends Shape, M = unknown, S = unknown>(
  this: NotAny<M, AnyMachine, ShapeNotAny<D, M, NotAny<S, AnySnapshot>>>,
  machine: Given<M> & Machine<D>,
  snapshot: Given<S> & Snapshot<D>,
  event: SendEvent<D>,
): Result<D>;
export function transition(m: __Compiled, from: __Snapshot, event: __Event): __Result {
  return __step(m, from, event, false);
}

/** What `createActor` takes: `input` for `start`, and a clock for timers. */
export type ActorOptions<D extends Shape> = ([ActorInput<D>] extends [undefined]
  ? {
      /** Typed as the fix: the machine declares no input. */
      readonly input?:
        | undefined
        | "this machine takes no input: leave input out, or declare it in setup's input, input: types<{ ... }>()";
    }
  : { readonly input: ActorInput<D> }) & {
  /** XState's: typed as the fix. */
  readonly systemId?: "systemId is XState's: register a child by its key with registryKey in setup's children (add system to setup's use)";
  /** XState's: typed as the fix. */
  readonly devTools?: "devTools is XState's: watch the actor with inspect (add inspect to setup's use, then createActor(machine, { inspect }))";
  /** The clock timers' deadlines are read from: `Date.now` by default. */
  readonly now?: () => number;
  /** XState's: there is no context. Typed as the fix, so passing it says what to write instead. */
  readonly context?: "createActor takes no context: each state's data is given by to(state, data), and what start needs by setup's input and { input }";
  /** XState v6's way to restore (its E8). Typed as the fix. */
  readonly snapshot?: "createActor starts the machine at start: restore a saved snapshot with restoreActor(machine, snapshot)";
} & FeatureActorOptions<D>;

/**
 * `createActor`'s options: required when the machine takes input. `O` is the options as written
 * (`Given`), so `this` can refuse an input typed any.
 */
export type StartArgs<D extends Shape, O = unknown> = [ActorInput<D>] extends [undefined]
  ? [options?: Given<O> & ActorOptions<D>]
  : [options: Given<O> & ActorOptions<D>];

/** A use site's `this` (createActor's, useActor's): the machine, its type argument and its input not any. */
export type UseSite<D, M, O = unknown> = NotAny<M, AnyMachine, ShapeNotAny<D, M, NotSpread<M> & InputNotAny<O>>>;

/**
 * An explicit type argument `any` (`createActor<any>(machine)`): `M` is then unknown, its default,
 * since a machine passed in place infers it. (A generic `D` in a library's own call isn't checked.)
 */
type ShapeNotAny<D, M, Else = unknown> = unknown extends M ? NotAny<D, AnyShape, Else> : Else;

/** "active" until a final state ("done") or `stop()` ("stopped"). */
export type Status = "active" | "done" | "stopped";

/** A running machine. */
export interface Actor<D extends Shape> {
  /** The current state and its data. */
  readonly snapshot: () => Snapshot<D>;
  readonly status: () => Status;
  /**
   * Send an event. The result says whether the machine moved, and if not, why. `E` is the event as
   * written, so that `this` refuses one typed any.
   */
  readonly send: <E = unknown>(this: NotAny<E, AnySent>, event: Given<E> & SendEvent<D>) => Result<D>;
  /**
   * Called after each transition, with the new snapshot. Returns the unsubscribe. The listener's
   * result is ignored, so it may not be a promise (its writes would overlap and land out of order).
   */
  readonly subscribe: <R>(listener: (snapshot: Snapshot<D>) => R & NotAwaited<R>) => () => void;
  /** Abort the state's task, cancel its timers, stop its children, and take no more events. */
  readonly stop: () => void;
}

/** A listener's result, when it is a promise no one awaits: the fix. */
export type NotAwaited<R> =
  R extends PromiseLike<unknown>
    ? {
        readonly "a subscribe listener returns a promise no one awaits, so its writes overlap and land out of order: queue the writes, or save with persist": never;
      }
    : unknown;

/** Internal: an actor as the runtime holds it. */
export interface __Actor {
  readonly snapshot: () => __Snapshot;
  readonly status: () => Status;
  readonly send: (event: __Event) => __Result;
  readonly subscribe: (listener: (snapshot: __Snapshot) => void) => () => void;
  readonly stop: () => void;
  /**
   * The runners at work (undefined for a machine without tasks, timers or children).
   * @reactre/state/persist reads it for `persist`, and @reactre/state/children for `child`: one
   * field, so an app using neither ships neither.
   */
  readonly "~r": __Live | undefined;
}

/**
 * Run a machine: enter `start`'s state, run its task and timers, and take events. Leaving a state
 * aborts its task and cancels its timers.
 */
export function createActor<D extends Shape, M = unknown, O = unknown>(
  this: UseSite<D, M, O>,
  machine: Given<M> & Machine<D>,
  ...options: StartArgs<D, O>
): Actor<D>;
export function createActor(m: __Compiled, options?: __Options): __Actor {
  return __run(m, __snap(m, m.i(options?.input)), options);
}

/**
 * Run a machine from a saved snapshot (storage, a network), or a persisted one with what its nodes
 * saved (`persist`, @reactre/state/persist): its version and state are checked, since the build
 * never saw it, and its nodes' tasks, timers and children start again (timers with the time they
 * had left, from `run`). A function of its own, so an app that never restores ships none of it.
 *
 * @throws StateError S2 for a snapshot of another version, S1 for a state the machine lacks, S7
 *   for data its state's schema refuses.
 */
export function restoreActor<D extends Shape, M = unknown, S = unknown>(
  this: NotAny<M, AnyMachine, ShapeNotAny<D, M, NotAny<S, AnySnapshot, NotDurable<S, OwnSnapshot<D, S>>>>>,
  machine: Given<M> & Machine<D>,
  snapshot: Given<S> & Persisted<D>,
  options?: { readonly now?: () => number },
): Actor<D>;
export function restoreActor(
  m: __Compiled,
  saved: __Snapshot & { readonly run?: __Persisted["run"] },
  options?: { readonly now?: () => number },
): __Actor {
  const { state, data, version } = saved;
  if (version !== m.v)
    throw new StateError(
      "S2",
      `the snapshot is of version ${version}, and the machine is at version ${m.v}. Migrate the snapshot's data to the new shape, then restore it.`,
    );
  const names = [...Object.keys(m.o), ...Object.keys(m.f ?? {})];
  // A leaf: a name in the table that no other name is under (that one is a parent).
  const leaf = (s: unknown): boolean =>
    typeof s === "string" && names.includes(s) && !names.some((n) => n.startsWith(`${s}.`));
  const regions = m.p?.[state];
  const bad =
    regions === undefined
      ? leaf(state)
        ? undefined
        : state
      : regions
          .map((r): unknown => {
            const at: unknown = typeof data === "object" && data !== null ? Reflect.get(data, r) : undefined;
            return typeof at === "object" && at !== null ? Reflect.get(at, "state") : undefined;
          })
          // wave1-statecharts: a region's unit may be a parallel node inside it (with its own regions).
          .find(
            (s, i) => !(leaf(s) || m.p?.[String(s)] !== undefined) || !String(s).startsWith(`${state}.${regions[i]}.`),
          );
  if (bad !== undefined || (regions !== undefined && regions.length === 0))
    throw new StateError(
      "S1",
      `there is no state "${String(bad)}"${regions === undefined ? "" : ` in a region of "${state}"`}. The states are: ${[
        ...names.filter(leaf),
        ...Object.keys(m.p ?? {}),
      ].join(", ")}.`,
    );
  // M187: a history leaf is a state's name too. A rename leaves the saved history pointing at a
  // state the machine no longer has, and `back` would fall back silently: refuse it here, as the
  // root's name is refused, naming the parent and the leaf.
  for (const [parent, held] of Object.entries(saved.history ?? {}))
    if (!leaf(held.state))
      throw new StateError(
        "S1",
        `the saved history of "${parent}" holds "${held.state}", which isn't a state of this machine. The states are: ${[
          ...names.filter(leaf),
          ...Object.keys(m.p ?? {}),
        ].join(
          ", ",
        )}. Migrate the saved snapshot (bump setup's version and rename the state in its step), then restore it.`,
      );
  m.z?.(m, saved);
  return __run(m, __snap(m, { state, data, version }, saved), { ...options, run: saved.run });
}

/**
 * Internal: run a compiled machine from `first`. `options` go to the lifecycle: the clock, and on
 * restore the persisted snapshot's `run`, given back to each runner of each node it enters first.
 */
export function __run(m: __Compiled, first: __Snapshot, options?: __Options): __Actor {
  let status: Status = "active";
  // An array, not a Set: no hash table to build per actor, and no iterator per round. A listener
  // subscribed during a round is told in it, as in a Set; an unsubscribe copies the array, so the
  // round in progress still tells a listener it removed. A function subscribed twice is told twice,
  // and its unsubscribe removes both.
  let listeners: ((snapshot: __Snapshot) => void)[] = [];
  // Handlers are pure and can't send, so a transition nests in another only through a listener
  // that sends. Listeners are told after the transition, and again while one of them moved it.
  // `at` is the round's snapshot, and 0 when no round is telling: a move that nests in another
  // (a listener's send) sees it set and doesn't tell again. 0, not undefined: a snapshot is an
  // object, so 0 is a sentinel no round can hold, and it is fewer bytes.
  let at: __Snapshot | 0 = 0;
  let current = first;
  // M51: a development build's round check, made once per actor (`d.round`). Production has no
  // `d`, so `bounded` is undefined and nothing is counted.
  // 0 and 1, not false and true: the same two values, and fewer bytes.
  const bounded: ((told: 0 | 1) => void) | undefined = m.d?.round?.();

  /** Enter a result's snapshot, and tell the listeners. */
  const move = (result: __Result): __Result => {
    if (result.ok && status === "active") {
      current = result.snapshot;
      status = m.f?.[current.state] ? "done" : status;
      runners?.enter(current, status === "active", result);
      // No listeners, no round. A round per snapshot: a listener that sends starts another, once
      // this one is told. `at` is the round's snapshot, set once per round (fewer bytes). A
      // listener that throws doesn't stop the others: the first error is thrown after the rounds.
      if (!at && listeners[0]) {
        let failed: [unknown] | undefined;
        // `finally`: a listener's throw, or the round check's (M51), must not leave `at` set, or
        // every later move would skip its listeners. The first error is thrown after the rounds.
        try {
          // A root move starts the count over; each further round of it (a listener sent, so the
          // actor moved again) counts, and past the limit the check throws S29 instead of hanging.
          bounded?.(0);
          for (; at !== current; bounded?.(1))
            for (const listener of ((at = current), listeners))
              try {
                listener(at);
              } catch (error) {
                failed ??= [error];
              }
        } catch (error) {
          failed ??= [error];
        }
        at = 0;
        if (failed) throw failed[0];
      }
    }
    return result;
  };

  // Tasks, timers and features' runners: only a machine that has one has `r`.
  const runners = m.r?.(m, move, () => current, options);
  // The start, as a move with no listeners yet: final at once, or its nodes' runners entered.
  move({ ok: true, snapshot: first });

  return {
    snapshot: () => current,
    status: () => status,
    send: (event) =>
      status === "active"
        ? move(__step(m, current, event, false))
        : { ok: false, reason: "inactive", snapshot: current },
    subscribe: (listener) => (listeners.push(listener), () => (listeners = listeners.filter((l) => l !== listener))),
    stop() {
      if (status !== "active") return;
      status = "stopped";
      runners?.stop();
    },
    "~r": runners,
  };
}

// #endregion

// #region XState's names
//
// A model writes from memory of XState, and imports what XState exports. These names aren't this
// library's: each is declared for the type checker only, as a function whose parameter is the fix,
// so a call is a type error that says what to write instead (TypeScript's own "has no exported
// member" names nothing). Nothing is exported at runtime, so an import of one fails there too.

/** A name of XState's that this library doesn't have: calling it is a type error whose parameter is the fix. */
export type NotHere<Fix extends string> = (fix: Fix, ...rest: readonly unknown[]) => never;

/** XState's guard combinator. */
export declare const and: NotHere<"and is XState's: a guard here is a condition in the handler, (a && b ? to(...) : null)">;
/** XState's guard combinator. */
export declare const or: NotHere<"or is XState's: a guard here is a condition in the handler, (a || b ? to(...) : null)">;
/** XState's guard combinator. */
export declare const not: NotHere<"not is XState's: a guard here is a condition in the handler, (!a ? to(...) : null)">;
/** XState's guard on another state. */
export declare const stateIn: NotHere<"stateIn is XState's: a handler gets the state it runs in, ({ state, to }) => (state === \"edit.review\" ? to(...) : null); a parallel node's handler reads its regions from data">;
/** XState's action creator. */
export declare const assign: NotHere<"assign is XState's: there is no context to assign to. Return the next state with its data, to(state, { ...data, field })">;
/** XState's action creator. */
export declare const raise: NotHere<"raise is XState's: with effects in setup's use, a handler raises with enq.raise(event) (import { effects } from \"@reactre/state/effects\")">;
/** XState's action creator. */
export declare const sendTo: NotHere<"sendTo is XState's: with effects in setup's use, a handler sends with enq.sendTo(target, event) (import { effects } from \"@reactre/state/effects\")">;
/** XState's action creator. */
export declare const enqueueActions: NotHere<"enqueueActions is XState's: with effects in setup's use, every handler gets enq, ({ enq, to }) => { enq.log(...); return to(...) } (import { effects } from \"@reactre/state/effects\")">;
/** XState's action creator. */
export declare const escalate: NotHere<"escalate is XState's: a child fails by throwing, and the parent's children: { name: { error } } decides where to go">;
/** XState's machine creator. */
export declare const createMachine: NotHere<"createMachine is XState's: declare the shape with setup({ states, events }), then the behaviour with .machine({ start, states })">;
/** XState v4's interpreter. */
export declare const interpret: NotHere<"interpret is XState v4's: createActor(machine) runs a machine">;
/** XState's invoke. */
export declare const invoke: NotHere<"invoke is XState's: a state's async work is task: { run, error }, and a child machine is in children (import { children } from \"@reactre/state/children\")">;

// #endregion
