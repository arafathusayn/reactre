// validate's types: any contract in setup may be a Standard Schema instead of `types<T>()`. The
// core's types read a schema's output for handlers and its input for `send` whether or not the
// opt-in is there (../../index.ts, `DataOf` and `InputOf`); what the opt-in adds is the runtime
// check, so a schema without it is a problem: it would look checked and not be.

import type { OptIn } from "../../features.ts";
import type { AnyConfig, Shape } from "../../index.ts";

export type Name = "validate";

type Schemas<T> = { [K in keyof T & string]: T[K] extends { readonly "~standard": unknown } ? K : never }[keyof T &
  string];

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
export type ShapeProblems<D extends Shape> =
  | `${Transforms<D["states"]>}`
  | `${Async<D["states"], "state">}`
  | `${Async<D["events"] & Internal<D>, "event">}`
  | `${LooseInput<D["events"]>}`
  | (D extends { readonly input: infer I } ? (UntypedIn<InOf<I>> extends true ? InputLoose : never) : never);

type Internal<D> = D extends { readonly internal: infer I } ? I : {};

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A schema's input and output, when it types them. */
type InOf<S> = S extends { readonly "~standard": { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly input: infer I }
    ? I
    : never
  : never;
type OutOf<S> = S extends { readonly "~standard": { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly output: infer O }
    ? O
    : never
  : never;

/** The fields whose input and output differ (a transform, a coerce, a default). */
type Changed<I, O> = {
  [K in keyof O | keyof I]: K extends keyof O
    ? K extends keyof I
      ? Equal<I[K], O[K]> extends true
        ? never
        : K
      : K
    : K;
}[keyof O | keyof I];

/**
 * A state's schema whose input and output differ: the data is stored as the output, and every
 * transition and restore checks it as the input (S23).
 */
type Transforms<T> = {
  [K in Schemas<T>]: Equal<InOf<T[K]>, OutOf<T[K]>> extends true
    ? never
    : `the schema of "${K}" transforms ${[Changed<InOf<T[K]>, OutOf<T[K]>>] extends [never] ? "its value" : `\`${Changed<InOf<T[K]>, OutOf<T[K]>> & string}\``} (its input and output differ): parse it at the edge, and keep the state's schema plain`;
}[Schemas<T>];

/** An async schema (valibot's `objectAsync`): a transition can't wait for it. */
type Async<T, What extends string> = {
  [K in keyof T & string]: T[K] extends { readonly async: true }
    ? `the schema of ${What} "${K}" is async, which a transition can't wait for: check it in a task`
    : never;
}[keyof T & string];

/** The input is any or unknown, or a field of it is: `send` would take anything. */
type UntypedIn<I> = 0 extends 1 & I
  ? true
  : unknown extends I
    ? true
    : I extends object
      ? true extends { [K in keyof I]-?: 0 extends 1 & I[K] ? true : unknown extends I[K] ? true : false }[keyof I]
        ? true
        : false
      : false;

type LooseInput<T> = {
  [K in Schemas<T>]: UntypedIn<InOf<T[K]>> extends true
    ? `the input of the event "${K}"'s schema is unknown (a coerce or preprocess): send the parsed value, typed`
    : never;
}[Schemas<T>];

type InputLoose =
  "the input of setup's input schema is unknown (a coerce or preprocess): give createActor the parsed value, typed";

/** A schema without the opt-in: it would be read as a type, and never checked. */
export type OffProblems<D extends Shape> =
  | `state "${Schemas<D["states"]>}" is a Standard Schema: ${OptIn<Name>}`
  | `event "${Schemas<D["events"]> | Schemas<D extends { readonly internal: infer I } ? I : {}>}" is a Standard Schema: ${OptIn<Name>}`
  | (D extends { readonly input: { readonly "~standard": unknown } }
      ? `input is a Standard Schema: ${OptIn<Name>}`
      : never);
