// emit's types: setup declares the events the machine emits (`emitted: { played: types<{ trackId:
// string }>() }`), `enq.emit(event)` takes one of them, and `on(actor, type, listener)` hands the
// listener that type's event (`"*"`: every one). It records an effect, so it needs effects.

import type { AnyConfig, DeepReadonly, Shape, Type, Types } from "../../index.ts";
import type { __Event } from "../../internal.ts";

export type Name = "emit";

/** What a contract holds: a `types<T>()`'s T, a Standard Schema's output. */
type PayloadOf<T> =
  T extends Type<infer X>
    ? X
    : T extends { readonly "~standard": { readonly types?: infer S } }
      ? NonNullable<S> extends { readonly output: infer O }
        ? O
        : never
      : never;

type Declared<D> = D extends { readonly emitted: infer E extends Types } ? E : {};

/** The events the machine emits, as listeners get them: `{ type, ...payload }`. */
export type Emitted<D> = {
  [K in keyof Declared<D> & string]: { readonly type: K } & DeepReadonly<PayloadOf<Declared<D>[K]>>;
}[keyof Declared<D> & string];

/** What `enq.emit` takes: an emitted event, or, with none declared, the fix. */
type EmitArg<D> = [Emitted<D>] extends [never]
  ? "declare the events the machine emits in setup: emitted: { played: types<{ trackId: string }>() }"
  : Emitted<D>;

/** The event a listener of `type` gets. */
export type Heard<D, T> = T extends "*" ? Emitted<D> : Extract<Emitted<D>, { readonly type: T }>;

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {
  /** The events the machine emits (`enq.emit`), with their payloads: `{ played: types<{ id: string }>() }`. */
  readonly emitted?: Types;
};
export type Needs = "effects";
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<D extends Shape> =
  `emitted event "${{ [K in keyof Declared<D> & string]: "type" extends keyof PayloadOf<Declared<D>[K]> ? K : never }[keyof Declared<D> & string]}" has a field named type, which is the event's name: rename it`;
export type OffProblems<_D extends Shape> = never;

declare module "../effects/types.ts" {
  interface EnqBy<D extends Shape> {
    readonly emit: {
      /** Emits an event to the actor's listeners (`on(actor, type, listener)`), after the transition. */
      readonly emit: (event: EmitArg<D>) => void;
    };
  }
  interface EffectBy {
    readonly emit: { readonly type: "emit"; readonly event: __Event };
  }
}
