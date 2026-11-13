// @reactre/state/signals (prototype): an actor as a signal, for @reactre/core components.
//
// Design decisions:
//   - A separate entry, so a machine used on a server or in a worker ships no UI code, and an app
//     that never imports it ships nothing of it.
//   - The snapshot is one signal. A hole that reads `snapshot().state` re-runs on each
//     transition; `snapshot().state === "loading"` narrows `data`, in a hole or in `<Show>`.
//   - The actor stops with the component (`onCleanup`), so its task is aborted and its timers
//     cancelled when the view that drove it goes away.

import { onCleanup, signal } from "@reactre/core";

import {
  type Actor,
  createActor,
  type Given,
  type Machine,
  type Shape,
  type Snapshot,
  type StartArgs,
  type UseSite,
} from "./index.ts";

/**
 * Run a machine for as long as the component: its snapshot as a signal, and the actor. A machine
 * typed `any` is refused, as `createActor` refuses it.
 */
export function useActor<D extends Shape, M = unknown>(
  this: UseSite<D, M>,
  machine: Given<M> & Machine<D>,
  ...options: StartArgs<D>
): readonly [() => Snapshot<D>, Actor<D>];
export function useActor<D extends Shape>(
  machine: Machine<D>,
  ...options: StartArgs<D>
): readonly [() => Snapshot<D>, Actor<D>] {
  const actor = createActor(machine, ...options);
  const [snapshot, setSnapshot] = signal(actor.snapshot());
  const unsubscribe = actor.subscribe((next) => setSnapshot(() => next));
  onCleanup(() => {
    unsubscribe();
    actor.stop();
  });
  return [snapshot, actor];
}
