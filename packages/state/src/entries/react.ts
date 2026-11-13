// @reactre/state/react (prototype): a React adapter on `useSyncExternalStore` (xstate docs:
// frameworks.md). `react` is an optional peer: an app without React never imports this entry.
//
//   const [snapshot, actor] = useActor(checkoutMachine);
//   const actor = useActorRef(checkoutMachine, { input });
//   const total = useSelector(actor, (s) => (s.state === "paying" ? s.data.total : 0));
//
// Design decisions:
//   - `useActor` returns `[snapshot, actor]`, as ../signals.ts does, not XState's `[snapshot, send,
//     actorRef]`: `actor.send` is the send, so one way to reach it.
//   - The actor runs for as long as the component is mounted: a render makes it without starting
//     it, its effect starts it, and the effect's cleanup stops it (React's way for an external
//     resource). A render runs nothing: on the server no effect runs, and a render React throws
//     away (strict mode's second call of `useState`'s initializer, one that suspends before it
//     mounts) never starts its actor, so no task, timer or child is left running. Until it starts,
//     it holds `start`'s snapshot (`initial`); a listener subscribed before then is told of a move
//     the start makes. Whatever needs it running starts it at once: a `send`, or a feature reading
//     its runners (`child`, `persist`), as a child component's effect does, which runs before its
//     parent's.
//   - React's strict mode runs effects twice in development (mount, unmount, mount); an actor
//     can't start again once stopped, so the second mount creates a new one from the machine, and
//     the component renders with it. Its options are read once, at the first render, as
//     `useState`'s initial value.
//   - `useSelector` re-renders only when the selected value changes by `compare` (default
//     `Object.is`): a selector that builds an object takes a structural compare.
//   - The machine is compiled like any other: nothing here reads the table.
//   - Vue, Svelte and Solid adapters are out of scope for the prototype.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  type __Actor,
  __run,
  __snap,
  type Actor,
  type Given,
  type Machine,
  type Shape,
  type Snapshot,
  type StartArgs,
  type UseSite,
} from "../index.ts";
import type { __Compiled, __Options, __Snapshot } from "../internal.ts";

/**
 * An actor made and not started: `start`'s snapshot until `start()` runs it (as `createActor`
 * would have), and stopped for good by a `stop()` before then. A `send` or a read of its runners
 * (`~r`) starts it.
 */
export function idle(m: __Compiled, options?: __Options): readonly [actor: __Actor, start: () => void] {
  const first = __snap(m, m.i(options?.input));
  let running: __Actor | undefined;
  let stopped = false;
  // Listeners subscribed before the start, each given to the actor when it starts.
  let waiting: { readonly listener: (s: __Snapshot) => void; off?: () => void; gone?: true }[] = [];
  const start = (): __Actor | undefined => {
    if (running === undefined && !stopped) {
      const a = (running = __run(m, first, options));
      for (const w of waiting) w.off = a.subscribe(w.listener);
      // A move the start made (a raised start event, say) came before them.
      if (a.snapshot() !== first) for (const w of waiting) if (!w.gone) w.listener(a.snapshot());
      waiting = [];
    }
    return running;
  };
  const actor: __Actor = {
    snapshot: () => running?.snapshot() ?? first,
    status: () => running?.status() ?? (stopped ? "stopped" : m.f?.[first.state] ? "done" : "active"),
    send: (event) => start()?.send(event) ?? { ok: false, reason: "inactive", snapshot: first },
    subscribe(listener) {
      if (running !== undefined) return running.subscribe(listener);
      const w: (typeof waiting)[number] = { listener };
      waiting.push(w);
      return () => {
        w.gone = true;
        waiting = waiting.filter((x) => x !== w);
        w.off?.();
      };
    },
    stop() {
      stopped = true;
      running?.stop();
    },
    get "~r"() {
      return start()?.["~r"];
    },
  };
  return [actor, start];
}

/**
 * Creates the machine's actor once, starts it when the component mounts, and stops it on unmount:
 * a render alone starts nothing (on the server, or one React throws away). A machine typed `any` is
 * refused, as `createActor` refuses it.
 */
export function useActorRef<D extends Shape, M = unknown>(
  this: UseSite<D, M>,
  machine: Given<M> & Machine<D>,
  ...options: StartArgs<D>
): Actor<D>;
export function useActorRef(machine: __Compiled, options?: __Options): __Actor {
  const [made, setMade] = useState(() => idle(machine, options));
  const [actor, start] = made;
  useEffect(() => {
    // Strict mode's second mount: the first one's cleanup stopped it.
    if (actor.status() === "stopped") setMade(idle(machine, options));
    else start();
    return () => actor.stop();
  }, [actor]);
  return actor;
}

/** The selected value of an actor's snapshot: the component re-renders when it changes by `compare`. */
export function useSelector<D extends Shape, T>(
  actor: Actor<D>,
  selector: (snapshot: Snapshot<D>) => T,
  compare: (a: T, b: T) => boolean = Object.is,
): T {
  const subscribe = useCallback((changed: () => void) => actor.subscribe(changed), [actor]);
  // The last snapshot, the selector it went through and its value: React calls `get` on each
  // render and on each change, and a new value only when it differs.
  const last = useRef<{ readonly s: Snapshot<D>; readonly f: (s: Snapshot<D>) => T; readonly v: T } | null>(null);
  const get = (): T => {
    const s = actor.snapshot();
    const was = last.current;
    if (was && was.s === s && was.f === selector) return was.v;
    const next = selector(s);
    const v = was && compare(was.v, next) ? was.v : next;
    last.current = { s, f: selector, v };
    return v;
  };
  return useSyncExternalStore(subscribe, get, get);
}

const whole = <S>(s: S): S => s;

/**
 * Runs a machine for as long as the component: its snapshot (re-rendering on each move), and the
 * actor. A machine typed `any` is refused, as `createActor` refuses it.
 */
export function useActor<D extends Shape, M = unknown>(
  this: UseSite<D, M>,
  machine: Given<M> & Machine<D>,
  ...options: StartArgs<D>
): readonly [Snapshot<D>, Actor<D>];
export function useActor<D extends Shape>(
  machine: Machine<D>,
  ...options: StartArgs<D>
): readonly [Snapshot<D>, Actor<D>] {
  const actor = useActorRef(machine, ...options);
  return [useSelector(actor, whole), actor];
}
