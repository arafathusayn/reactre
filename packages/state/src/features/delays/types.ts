// delays's types: `after` takes ISO 8601 durations ("PT1M30S", "P1D", "P1W") and the names of setup's
// delays (`setup({ use: [delays], delays: { retry: "PT2S", sla: ({ data }: { data: { slaMs: number }
// }) => data.slaMs } })`, then `after: { retry: ... }`). A delay is a number of milliseconds, a
// duration, or a function of the state's data, read when the state is entered.
//
// A delay function is declared in setup, before any state, so its argument can't be typed from the
// state that uses it: give it the type of what it reads (`{ data: { slaMs: number } }`), and every
// state that uses it is checked to have that (a problem names the state otherwise). Unannotated, its
// `data` is `never`, so reading a field is an error at once.

import type { OptIn, Uses } from "../../features.ts";
import type { AfterArgs, AnyConfig, AnyNext, Args as ArgsOf, Duration, DurationProblem, Shape } from "../../index.ts";
import type { __Step } from "../../internal.ts";

export type Name = "delays";

/** A delay in setup: milliseconds, a duration, or a function of the data of the state using it. */
export type DelayValue = number | string | ((args: { readonly state: string; readonly data: never }) => number);

/** Setup's named delays. */
type Declared<D> = D extends { readonly delays: infer T } ? T : {};

/** The names of setup's delays. */
export type DelayName<D> = keyof Declared<D> & string;

/** `S` is `<number><unit>...` with units in `U`'s order, each at most once. */
type Units<S extends string, U extends readonly string[]> = S extends ""
  ? true
  : U extends readonly [infer H extends string, ...infer T extends readonly string[]]
    ? S extends `${infer N}${H}${infer R}`
      ? N extends `${number}`
        ? Units<R, T>
        : false
      : Units<S, T>
    : false;

/**
 * An ISO 8601 duration of fixed length: weeks, days, then `T` and hours, minutes, seconds
 * ("P1W", "P1DT12H", "PT1M30S"). A year or a month has no fixed length: write days.
 */
export type IsIso<K> = K extends `P${infer R}`
  ? R extends ""
    ? false
    : R extends `${infer Day}T${infer Time}`
      ? Time extends ""
        ? false
        : Units<Day, ["W", "D"]> extends true
          ? Units<Time, ["H", "M", "S"]>
          : false
      : Units<R, ["W", "D"]>
  : false;

/** A timer key or a delay that is a duration: the core's ("5s") or, with delays, ISO 8601. */
type IsDuration<D, K> = K extends Duration ? true : [Name] extends [Uses<D>] ? IsIso<K> : false;

/** Why the text isn't a duration, worded as the fix. */
type NotDuration<K extends string> = K extends `P${string}`
  ? `an ISO 8601 duration here takes weeks, days, hours, minutes and seconds ("PT1M30S", "P1D", "P1DT12H"); a year or a month has no fixed length: write days`
  : `write a number and a unit ("500ms", "5s", "2m", "1h") or an ISO 8601 duration ("PT1M30S")`;

/**
 * Timer keys of state S that aren't durations: what ../../index.ts reports for `after`. Off, the
 * core's wording (an ISO duration names the opt-in); on, a named delay is a timer too. A bare
 * number is milliseconds to a model, and nothing to the library: its unit is the fix.
 */
export type TimerProblem<D, S extends string, K extends string | number> = K extends number
  ? `state "${S}" has a timer ${K}, a bare number: write it with its unit, "${K}ms"`
  : K extends string
    ? [Name] extends [Uses<D>]
      ? K extends DelayName<D>
        ? never
        : IsIso<K> extends true
          ? never
          : `state "${S}" has a timer "${K}", which is neither a duration nor one of setup's delays: ${NotDuration<K>}, or add it to setup's delays`
      : K extends `P${string}`
        ? `state "${S}" has a timer "${K}": an ISO 8601 duration needs delays: ${OptIn<Name>}`
        : `state "${S}" has a timer "${K}": write a number and a unit, "500ms", "5s", "2m" or "1h"`
    : never;

/** A delay's text (a timer key, a timeout), or a name: never when it is one, else its problem. */
export type DelayProblem<D, What extends string, K> = K extends string
  ? K extends DelayName<D>
    ? never
    : IsDuration<D, K> extends true
      ? DurationProblem<What, Extract<K, Duration>>
      : [Name] extends [Uses<D>]
        ? `${What} is "${K}", which is neither a duration nor one of setup's delays: ${NotDuration<K>}, or add it to setup's delays`
        : IsIso<K> extends true
          ? `${What} is "${K}": an ISO 8601 duration needs delays: ${OptIn<Name>}`
          : `${What} is "${K}": ${NotDuration<K>} (ISO 8601 durations and named delays need delays: ${OptIn<Name>})`
  : never;

type AfterOf<SC> = SC extends { readonly after: infer A } ? A : {};

/** The names a state uses: its timers' keys, and its timeout when it's a name. */
type Named<SC> = keyof AfterOf<SC> | (SC extends { readonly timeout: infer T extends string } ? T : never);

/** A state whose data a delay function it uses can't read. */
type Unread<D extends Shape, C extends AnyConfig> = {
  [S in keyof C["states"] & string]: {
    [K in Named<C["states"][S]> & DelayName<D>]: Declared<D>[K] extends (args: infer A) => number
      ? ArgsOf<D, S, {}> extends A
        ? never
        : `state "${S}" uses delay "${K}", whose argument's type its data doesn't have: give the delay's argument a type every state using it has`
      : never;
  }[Named<C["states"][S]> & DelayName<D>];
}[keyof C["states"] & string];

/**
 * Setup's delays that are strings but not durations, and delays named like a duration: `after: {
 * "5s": ... }` would read as five seconds, whatever the delay says.
 */
type BadDeclared<D> = {
  [K in DelayName<D>]:
    | (Declared<D>[K] extends string ? DelayProblem<D, `delay "${K}"`, Declared<D>[K]> : never)
    | (IsDuration<D, K> extends true
        ? `delay "${K}" is named like a duration, so after: { "${K}": ... } reads as one: name it for what it waits for ("debounce", "retry")`
        : never);
}[DelayName<D>];

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {
  /**
   * Named delays, for `after` (and `timeout`): `{ retry: "PT2S", short: 300, sla: ({ data }: { data:
   * { slaMs: number } }) => data.slaMs }`. `provide(machine, { delays })` replaces them in tests.
   */
  readonly delays?: { readonly [name: string]: DelayValue };
};
export type Needs = never;
export type State<D extends Shape, N extends string> = {
  readonly after?: {
    readonly [K in DelayName<D> | `P${string}`]?: (args: AfterArgs<D, N>) => AnyNext<D>;
  };
};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<D extends Shape, C extends AnyConfig> = `${Unread<D, C>}`;
export type ShapeProblems<D extends Shape> = `${BadDeclared<D>}`;
export type OffProblems<_D extends Shape> = never;

declare module "../../internal.ts" {
  interface __Compiled {
    /**
     * Timers whose delay is resolved when the node is entered (@reactre/state/delays, timeout): a
     * name in `w`, milliseconds, or a function of the leaf's data. Each fires its handler, as `a`'s.
     */
    readonly l?: {
      readonly [node: string]:
        | readonly (readonly [
            delay: string | number | ((data: unknown, state: string) => number),
            handler: (data: unknown, state: string) => __Step,
          ])[]
        | undefined;
    };
    /** Setup's named delays: milliseconds, or a function of the data (`provide` replaces them). */
    readonly w?: { readonly [name: string]: number | ((data: unknown, state: string) => number) | undefined };
  }
}
