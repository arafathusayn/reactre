// @reactre/state/provide (prototype): named actions and guards in setup, and `provide`, which swaps
// implementations. `setup({ use: [effects, provide], actions: { track: (params: { key: string }) =>
// analytics.track(params.key) }, guards: { isAdmin: (role: string) => role === "admin" } })`, then
// `({ event, actions, guards, enq, to }) => guards.isAdmin(event.role) ? (enq(actions.track, { key:
// "admin" }), to("admin")) : null`. In a test: `provide(machine, { actions: { track: spy }, delays: {
// retry: 0 } })`.
//
// Design decisions:
//   - A named action is enqueued by name: `{ type: "action", name: "track", params }` is data, JSON
//     whenever its params are, and the runner looks its implementation up when it runs, in the
//     machine's `j`. So `provide` replaces it without recompiling, and a test asserts it as data.
//   - Guards are pure, called during the transition, and can't be replaced: a test gives a pure
//     function its inputs instead. (XState's `provide` swaps them too.)
//   - `provide` replaces actions and delays (../delays). Named actors are the actors features'.
//   - `extend` and `createStateConfig` aren't offered: the compiler checks and compiles a machine
//     written in place, with its shape in the same file (README, decision 5), so a setup built from
//     another, or a state's config built apart, couldn't be compiled. Write the machine whole.

import type { Feature, Machine, NeedsOptIn, Shape } from "../../index.ts";
import type { __Compiled, __EffectRunners } from "../../internal.ts";
import type { EffectBy } from "../effects/types.ts";
import type { Implementations } from "./types.ts";

/**
 * Internal: what a handler's `actions` compiles to: `actions.track` is the name `"track"`, which
 * `enq` records as a named action (../effects).
 */
const names: { readonly [name: string]: string } = /* @__PURE__ */ new Proxy({}, { get: (_, name) => name });

/** The `action` effect's runner: the machine's implementation (`j`, which `provide` replaces). */
const runners: __EffectRunners = {
  action: (e, ctx) => {
    const { name, params } = e as EffectBy["action"];
    ctx.live.m?.j?.[name]?.(params);
  },
};

function swap(m: __Compiled, { actions, delays }: { readonly actions?: object; readonly delays?: object }): __Compiled {
  return { ...m, ...(actions && { j: { ...m.j, ...actions } }), ...(delays && { w: { ...m.w, ...delays } }) };
}

/** The provide opt-in, and the function that swaps a machine's implementations. */
export interface Provide extends Feature<"provide"> {
  /**
   * The machine with other implementations of its named actions and delays (a test's spies, a
   * delay of 0): its states, events and types stay the same.
   */
  <D extends Shape, F extends string>(
    machine: Machine<D, F> & NeedsOptIn<D, "provide", "provide(machine, ...)">,
    implementations: Implementations<D>,
  ): Machine<D, F>;
  /** Internal: `actions` in handlers (`actions.track` is `"track"`). */
  readonly n: { readonly [name: string]: string };
  /** Internal: the `action` effect's runner. */
  readonly q: __EffectRunners;
}

/**
 * `setup({ use: [provide], actions, guards })`, then `provide(machine, { actions, delays })`: the
 * machine with other implementations.
 */
// A cast: `swap`'s parameters are the runtime's view of a machine; the signature above is the app's.
export const provide: Provide = /* @__PURE__ */ Object.assign(swap, { n: names, q: runners }) as unknown as Provide;
