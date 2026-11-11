// spawn's types: `enq.spawn`, `enq.stop`, `enq.subscribeTo` and `enq.listen` (xstate docs: spawn.md,
// listen-and-subscribe.md), methods of `enq` (../effects/types.ts, `EnqBy`), with `use: [children,
// effects, spawn]`. A spawned child is one of setup's `children`, by name and key; what it reports
// comes back as one of the machine's own events, named in the effect (data, so it persists).
//
// Off, each method is a function whose only parameter is the fix (effects's `OffMethods`).

import type { ActorInput, AnyConfig, EventName, EventOf, NotJsonPath, Shape, Snapshot } from "../../index.ts";
import type { __Compiled } from "../../internal.ts";
import type { ChildMachine, ChildName, ChildOutput, ChildrenUsed, ChildShape } from "../children/types.ts";
import type { Emitted } from "../emit/types.ts";

export type Name = "spawn";

/** The machine's events (sent or internal) whose data `P` fits: where a report can go. */
type EventWith<D extends Shape, P> = {
  [E in EventName<D>]: P extends Omit<EventOf<D, E>, "type"> ? E : never;
}[EventName<D>];

/** An event name for a report of `P`, or the fix when the machine has none. */
type ReportTo<D extends Shape, P, What extends string> = [EventWith<D, P>] extends [never]
  ? `add an internal event for ${What}: internal: { name: types<${What}>() }`
  : EventWith<D, P>;

/** `enq.spawn`'s options: the key it is reached by (`child(actor, name, key)`), and its input. */
type SpawnArgs<D extends Shape, K, I> = [ActorInput<ChildShape<D, K>>] extends [undefined]
  ? [options?: { readonly key?: string }]
  : [options: { readonly key?: string; readonly input: I & ActorInput<ChildShape<D, K>> & InputJson<I> }];

/** The input as written (`I`), when JSON can't hold it: the fix, as a required key. */
type InputJson<I> = [NotJsonPath<I, "input">] extends [never]
  ? unknown
  : {
      readonly [
        P in NotJsonPath<
          I,
          "input"
        > as `the child's ${P & string} isn't JSON: pass what it needs as data, and send to the parent with sendBack`
      ]: never;
    };

/** What a spawned child reports, and the machine's events each report becomes. */
export interface Reports<D extends Shape, K> {
  /** The child's key, when it was spawned with one. */
  readonly key?: string;
  /** Each move of the child, as `{ type, snapshot }`. */
  readonly snapshot?: ReportTo<D, { readonly snapshot: Snapshot<ChildShape<D, K>> }, "{ snapshot }">;
  /** The child ended, as `{ type, output }`: a machine's final `{ state, data }`, or a logic's output. */
  readonly done?: ReportTo<D, { readonly output: ChildOutput<D, K> }, "{ output }">;
  /** The child (actor logic) failed, as `{ type, error }`. */
  readonly error?: ReportTo<D, { readonly error: unknown }, "{ error: unknown }">;
}

/** An event a child emits (`enq.emit` in it, with emit in its use), by type. */
type ChildEmitted<D extends Shape, K> = Emitted<ChildShape<D, K>>;

declare module "../effects/types.ts" {
  interface EnqBy<D extends Shape> {
    readonly spawn: {
      /**
       * Starts one of setup's `children` as this actor's child, until `enq.stop` or the actor stops:
       * `enq.spawn("worker", { key: data.id, input: { id: data.id } })`. One per name and key.
       */
      readonly spawn: <K extends ChildName<D>, I = unknown>(name: K, ...options: SpawnArgs<D, K, I>) => void;
      /** Stops a spawned child. One that isn't running is ignored. */
      readonly stop: <K extends ChildName<D>>(name: K, key?: string) => void;
      /**
       * Turns a spawned child's moves, end or failure into this machine's events:
       * `enq.subscribeTo("worker", { key, done: "workerDone" })` sends `{ type: "workerDone", output }`.
       */
      readonly subscribeTo: <K extends ChildName<D>>(name: K, reports: Reports<D, K>) => void;
      /**
       * Turns an event a spawned child emits into this machine's event of type `as`, with the same
       * payload: `enq.listen("player", "played", "trackPlayed")`.
       */
      readonly listen: <K extends ChildName<D>, T extends ChildEmitted<D, K>["type"] & string>(
        name: K,
        type: T,
        as: ReportTo<D, Omit<Extract<ChildEmitted<D, K>, { readonly type: T }>, "type">, `the payload of "${T}"`>,
        options?: { readonly key?: string },
      ) => void;
    };
  }

  interface EffectBy {
    readonly spawn: { readonly type: "spawn"; readonly name: string; readonly key?: string; readonly input?: unknown };
    readonly stop: { readonly type: "stop"; readonly name: string; readonly key?: string };
    readonly subscribeTo: {
      readonly type: "subscribeTo";
      readonly name: string;
      readonly key?: string;
      readonly snapshot?: string;
      readonly done?: string;
      readonly error?: string;
    };
    readonly listen: {
      readonly type: "listen";
      readonly name: string;
      readonly key?: string;
      readonly event: string;
      readonly as: string;
    };
  }
}

declare module "../../internal.ts" {
  interface __Compiled {
    /** The machines `enq.spawn` starts, by setup's name (@reactre/state/spawn). */
    readonly sp?: { readonly [name: string]: __Compiled | undefined };
  }
}

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {};
// Not children: setup's `children`, which `enq.spawn` names, is children's option, and needs it.
export type Needs = "effects";
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
/**
 * Setup's children that no node runs are reachable as spawned children: `child(actor, "worker",
 * key)`. (One that a node runs is typed by children's brand, without a key.)
 */
export type Brand<D extends Shape, C extends AnyConfig> = [Exclude<ChildName<D>, ChildrenUsed<C>>] extends [never]
  ? {}
  : {
      readonly "~children"?: {
        readonly [K in Exclude<ChildName<D>, ChildrenUsed<C>>]: {
          readonly machine: ChildMachine<D, K>;
          readonly each: true;
        };
      };
    };
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
