// @reactre/state/emit (prototype): emitted events. `setup({ use: [effects, emit], emitted: { played:
// types<{ trackId: string }>() } })`, then `enq.emit({ type: "played", trackId })` in a handler, and
// `on(actor, "played", (event) => ...)` in the app (`"*"` for every event). Also `trigger(actor)`, a
// typed shorthand for `send` (`trigger(actor).play({ trackId })`), which any machine has.
//
// Design decisions:
//   - `on` and `trigger` are functions of this entry, not methods of the actor: the core's actor
//     doesn't grow for apps that don't use them. `on` reaches the actor's lifecycle through
//     `actor["~r"]`, as `child` does (../children/index.ts).
//   - An emitted event is an effect: it reaches listeners after the transition, so a listener that
//     reads the snapshot sees where the transition went.
//   - `on` returns the function that removes the listener, as `subscribe` does (XState returns a
//     subscription object). A listener that throws doesn't stop the actor or the other listeners:
//     its error is reported (console.error), as XState reports it.

import {
  type __Actor,
  type Actor,
  type Feature,
  type NeedsOptIn,
  type Result,
  type SendEvent,
  type Shape,
  StateError,
} from "../../index.ts";
import type { __EffectRunners, __Event, __Live } from "../../internal.ts";
import type { __Recorders } from "../effects/index.ts";
import type { EffectBy } from "../effects/types.ts";
import type { Emitted, Heard } from "./types.ts";

type Listener = (event: __Event) => void;

const listeners = new WeakMap<__Live, Map<string, Set<Listener>>>();

/** This feature's runner: hands an emitted event to its type's listeners, then to `"*"`'s. */
const runners: __EffectRunners = {
  emit: (e, { live }) => {
    const { event } = e as EffectBy["emit"];
    const map = listeners.get(live);
    for (const listener of [...(map?.get(event.type) ?? []), ...(map?.get("*") ?? [])])
      try {
        listener(event);
      } catch (error) {
        console.error(error);
      }
  },
};

/** This feature's `enq` method. */
const recorders: __Recorders = { emit: (event: __Event) => ({ type: "emit", event }) };

/** The emit opt-in: `enq.emit(event)` in handlers. `setup({ use: [effects, emit], emitted: { ... } })`. */
export const emit: Emit = { e: recorders, q: runners };

/** The emit opt-in's type: an interface, so a type error names it `Emit`, not its hooks. */
export interface Emit extends Feature<"emit"> {
  /** Internal: `enq.emit`'s recorder. */
  readonly e: __Recorders;
  /** Internal: the `emit` effect's runner. */
  readonly q: __EffectRunners;
}

/**
 * Calls `listener` with each event of `type` the actor emits (`enq.emit`), or every one for `"*"`,
 * after the transition that emitted it. Returns the function that removes it.
 *
 * @throws StateError S62 for an actor whose machine records no effects (code the type checker didn't see).
 */
export function on<D extends Shape, T extends (Emitted<D>["type"] & string) | "*">(
  actor: Actor<D> & NeedsOptIn<D, "emit", "on(actor, ...)">,
  type: T,
  listener: (event: Heard<D, T>) => void,
): () => void;
// `"~r"` is optional here only because the public `Actor` doesn't name it; every actor has it.
export function on(
  actor: Pick<__Actor, "send"> & Partial<Pick<__Actor, "~r">>,
  type: string,
  heard: (event: never) => void,
): () => void {
  // The overload typed the listener by the type it listens to, which is the only type it gets.
  const listener = heard as Listener;
  const live = actor["~r"];
  if (!live)
    throw new StateError(
      "S62",
      `on(actor, "${type}", ...) needs a machine that emits: add effects and emit to setup's use (import { effects } from "@reactre/state/effects"; import { emit } from "@reactre/state/emit"), and emit with enq.emit(...) in a handler.`,
    );
  let map = listeners.get(live);
  if (!map) listeners.set(live, (map = new Map()));
  let set = map.get(type);
  if (!set) map.set(type, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

/** `trigger(actor).save({ text })`: `send`, by event. An event without a payload takes no argument. */
export type Trigger<D extends Shape> = {
  readonly [E in SendEvent<D>["type"]]: (
    ...payload: keyof Omit<Extract<SendEvent<D>, { readonly type: E }>, "type"> extends never
      ? []
      : [payload: Omit<Extract<SendEvent<D>, { readonly type: E }>, "type">]
  ) => Result<D>;
};

/** A typed shorthand for `send`: `trigger(actor).save({ text })` is `actor.send({ type: "save", text })`. */
export function trigger<D extends Shape>(actor: Actor<D>): Trigger<D>;
export function trigger(actor: Pick<__Actor, "send">): unknown {
  return new Proxy({}, { get: (_, type) => (payload?: object) => actor.send({ ...payload, type: String(type) }) });
}
