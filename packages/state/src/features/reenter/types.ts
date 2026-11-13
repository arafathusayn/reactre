// reenter's types: `reenter(state, data)` in a handler is `to(state, data)` that exits and enters
// the leaf again even when it is the current one, so its task, timers and children restart. Without
// the opt-in, a handler's `reenter` is a function whose only parameter is the fix.

import type { AnyConfig, Data, Exactly, OwnTarget, Same, Shape, StateName } from "../../index.ts";
import type { __Snapshot } from "../../internal.ts";

declare module "../../internal.ts" {
  interface __Compiled {
    /** The lifecycle asks: did the move to `next` re-enter `node`? (@reactre/state/reenter) */
    readonly re?: (next: __Snapshot, node: string) => boolean;
  }
}

export type Name = "reenter";

/**
 * `reenter("loading", { url })`: exit the leaf the handler runs in and enter it again, with new data,
 * so its task, timers and children restart. `to` to the current leaf stays in it (as `keep` does),
 * and another leaf is `to`'s: so its state is one the handler runs in, and the error says so.
 */
export type Reenter<D extends Shape, N extends string> = <S extends StateName<D>, T extends Data<D, S>>(
  state: OwnTarget<D, N, S, "reenter restarts">,
  ...data: keyof Data<D, S> extends never ? [] : [data: Exactly<T, Data<D, S>, S>]
) => Same<S, "reenter">;

export type Options = {};
export type Needs = never;
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<D extends Shape, N extends string> = { readonly reenter: Reenter<D, N> };
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, C extends AnyConfig> = `${{
  [S in keyof C["states"] & string]: C["states"][S] extends {
    readonly task: { readonly error: (...args: never[]) => infer R };
  }
    ? [R] extends [never]
      ? never
      : [R] extends [Same<S, "reenter">]
        ? `error in "${S}" only reenters "${S}", which retries at once and forever: go to a failed state with after, the attempt in its data`
        : never
    : never;
}[keyof C["states"] & string]}`;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
