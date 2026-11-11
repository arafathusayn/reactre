// timeout's types: a state's `timeout` (milliseconds, a duration, one of setup's delays with `delays`,
// or a function of the state's data) and its `onTimeout`, a handler that decides where to go when it
// expires. Each needs the other. Off, either key is a problem naming the import.

import type { AfterArgs, AnyConfig, AnyNext, Args as ArgsOf, Duration, DurationProblem, Shape } from "../../index.ts";
import type { DelayName, DelayProblem } from "../delays/types.ts";

export type Name = "timeout";

/** A state's deadline: milliseconds, a duration ("5s", or ISO with delays), a delay's name, or a function of its data. */
export type Timeout<D extends Shape, N extends string> =
  number | Duration | `P${string}` | DelayName<D> | ((args: ArgsOf<D, N, {}>) => number);

type Problem<D extends Shape, S extends string, SC> = SC extends { readonly timeout: unknown }
  ? SC extends { readonly onTimeout: unknown }
    ? SC extends { readonly timeout: infer T extends string }
      ? DelayProblem<D, `state "${S}"'s timeout`, T>
      : SC extends { readonly timeout: infer T extends number }
        ? number extends T
          ? never
          : DurationProblem<`state "${S}"'s timeout`, `${T}ms`>
        : never
    : `state "${S}" has a timeout and no onTimeout: add onTimeout: ({ to }) => to(...), where to go when it expires`
  : SC extends { readonly onTimeout: unknown }
    ? `state "${S}" has onTimeout and no timeout: add timeout: "30s" (or milliseconds), when it expires`
    : never;

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {};
export type Needs = never;
export type State<D extends Shape, N extends string> = {
  /** The state's deadline, from when it is entered: `timeout: "30s"`. Leaving the state cancels it. */
  readonly timeout?: Timeout<D, N>;
  /** Where to go when the deadline passes: `onTimeout: ({ to }) => to("escalated")`. */
  readonly onTimeout?: (args: AfterArgs<D, N>) => AnyNext<D>;
};
export type Keys<_D extends Shape, _N extends string> = "timeout" | "onTimeout";
export type OffKeys = "timeout" | "onTimeout";
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<SC> = SC extends { readonly onTimeout: infer F } ? F : never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<D extends Shape, C extends AnyConfig> = `${{
  [S in keyof C["states"] & string]: Problem<D, S, C["states"][S]>;
}[keyof C["states"] & string]}`;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
