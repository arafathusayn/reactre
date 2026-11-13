// @reactre/state/react/dev (prototype): the React adapter's development build. The compiler rewrites
// an app's `@reactre/state/react` import to this entry only when `dev` is on, so a production bundle
// ships none of it. Each hook is the plain one (./react.ts) with a check that warns, once, with the
// fix; the actor's behaviour is unchanged.
//
//   - M313: `useActor(machine, { input })` with an input that changes between renders. The options
//     are read once, at the first render (as `useState`'s initial value), so the new input is
//     ignored: the actor keeps the first. Warn, and say how to get a new actor.
//   - M314: a different machine passed on a later render. The first is kept, as `useState`'s
//     initial value: warn, and say how to get a new actor.
//   - M315: `useSelector(actor, (s) => ({ a, b }))` with no `compare`. The selector builds a new
//     object on each notification, so `Object.is` never matches and the component re-renders on
//     every move: warn, and say to pass a structural compare.
//   - M316: a send from an effect that runs once (`[]`), to start the machine. Strict Mode's second
//     mount replaces the actor, and the first one's sends are lost: warn, and say the actor starts
//     itself, so send from an event handler or an effect that depends on the actor.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type Actor,
  type Given,
  type Machine,
  type Shape,
  type Snapshot,
  type StartArgs,
  type UseSite,
} from "../index.ts";
import type { __Actor, __Compiled, __Options } from "../index.ts";
import { idle, useSelector as useSelectorPlain } from "./react.ts";

/**
 * Warns once per distinct message, so a render loop doesn't flood the console. `once` is the hook
 * instance's own set (a ref), so two components with the same mistake each warn: a module-level set
 * would let the first hide the second.
 */
function warn(once: Set<string>, message: string): void {
  if (once.has(message)) return;
  once.add(message);
  console.warn(`@reactre/state/react: ${message}`);
}

/**
 * Whether two values are equal by structure: the same keys, each value equal by this rule, arrays by
 * index. Cycle-safe (a pair already being compared is equal), and depth-limited, so a deep or a
 * cyclic input doesn't hang the check. Development only.
 */
function same(a: unknown, b: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (depth > 8 || seen.has(a)) return true;
  seen.add(a);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka)
    if (
      !Object.hasOwn(b, k) ||
      !same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen, depth + 1)
    )
      return false;
  return true;
}

/** The options' input, as the actor reads it: `options[0]?.input`. */
function inputOf(options: readonly unknown[]): unknown {
  const first = options[0];
  return typeof first === "object" && first !== null ? (first as { readonly input?: unknown }).input : undefined;
}

/** The actor with its `send` counted, so the effect knows the first actor was used before it was replaced. */
function counted(actor: __Actor, dev: { sent: boolean }): __Actor {
  return {
    snapshot: actor.snapshot,
    status: actor.status,
    subscribe: actor.subscribe,
    stop: actor.stop,
    send: (event: Parameters<__Actor["send"]>[0]) => {
      dev.sent = true;
      return actor.send(event);
    },
    get "~r"() {
      return actor["~r"];
    },
  };
}

/**
 * Creates the machine's actor once, starts it when the component mounts, and stops it on unmount,
 * warning when a later render passes a different machine or input (M313, M314) or when Strict Mode's
 * second mount drops the first actor's sends (M316). The actor is the plain one (./react.ts's
 * `idle`), with its `send` counted.
 */
export function useActorRef<D extends Shape, M = unknown>(
  this: UseSite<D, M>,
  machine: Given<M> & Machine<D>,
  ...options: StartArgs<D>
): Actor<D>;
export function useActorRef(machine: __Compiled, options?: __Options): __Actor {
  // One ref, declared before the state (whose initializer counts sends through it), so the hook's
  // slots are the ref then the state, as the plain hook's are.
  const dev = useRef<{
    sent: boolean;
    first: { readonly machine: __Compiled; readonly input: unknown } | null;
    actor: __Actor | null;
    warned: Set<string>;
  }>({ sent: false, first: null, actor: null, warned: new Set() });
  const [made, setMade] = useState(() => {
    const [actor, start] = idle(machine, options);
    return { actor: counted(actor, dev.current), start };
  });
  const { actor, start } = made;

  // M316: a new actor replaced one that had been sent to (Strict Mode's second mount, or a remount
  // that re-ran the state's initializer), so those sends are lost.
  if (dev.current.actor !== null && dev.current.actor !== actor && dev.current.sent)
    warn(
      dev.current.warned,
      "Strict Mode's second mount replaced the actor, and the sends the first one got are lost: the actor starts itself on mount, so send from an event handler, or from an effect that depends on the actor ([actor]) so it runs again for the new one",
    );
  if (dev.current.actor !== actor) {
    dev.current.actor = actor;
    dev.current.sent = false;
  }

  // M313, M314: the options and the machine are read once, at the first render.
  if (dev.current.first === null) dev.current.first = { machine, input: inputOf([options]) };
  else {
    if (dev.current.first.machine !== machine)
      warn(
        dev.current.warned,
        "a different machine was passed on a later render, and the first is kept (the options are read once, at the first render): to run another machine, give the component a `key` that changes with it, so React mounts a new one",
      );
    if (!same(dev.current.first.input, inputOf([options])))
      warn(
        dev.current.warned,
        "the input changed on a later render, and the actor keeps the first (the options are read once, at the first render): to start from a new input, give the component a `key` that changes with it, so React mounts a new actor",
      );
  }

  useEffect(() => {
    // Strict mode's second mount: the first one's cleanup stopped it.
    if (actor.status() === "stopped") {
      // M316: the first actor was sent to, and this mount replaces it, so those sends are lost.
      if (dev.current.sent)
        warn(
          dev.current.warned,
          "Strict Mode's second mount replaced the actor, and the sends the first one got are lost: the actor starts itself on mount, so send from an event handler, or from an effect that depends on the actor ([actor]) so it runs again for the new one",
        );
      const [next, nextStart] = idle(machine, options);
      setMade({ actor: counted(next, dev.current), start: nextStart });
    } else start();
    return () => actor.stop();
  }, [actor]);

  return actor;
}

/** The selected value of an actor's snapshot, warning when a selector builds a new object with no `compare` (M315). */
export function useSelector<D extends Shape, T>(
  actor: Actor<D>,
  selector: (snapshot: Snapshot<D>) => T,
  compare?: (a: T, b: T) => boolean,
): T {
  // The last snapshot the selector ran on and its value: a warning is for a real move (a new
  // snapshot), not for a render that reads the same one again.
  const last = useRef<{ readonly s: Snapshot<D>; readonly v: T } | null>(null);
  const warned = useRef<Set<string>>(new Set());
  const wrapped = useCallback(
    (snapshot: Snapshot<D>): T => {
      const next = selector(snapshot);
      const was = last.current;
      last.current = { s: snapshot, v: next };
      // M315: no compare, a new object on a new snapshot, and the same shape as the last: a
      // re-render per move.
      if (
        compare === undefined &&
        was !== null &&
        was.s !== snapshot &&
        typeof next === "object" &&
        next !== null &&
        !Object.is(was.v, next) &&
        same(was.v, next)
      )
        warn(
          warned.current,
          "the selector returns a new object on each notification, and with no compare the component re-renders on every move: pass a compare, (a, b) => a.a === b.a && a.b === b.b, or select one value",
        );
      return next;
    },
    [selector, compare],
  );
  return compare === undefined ? useSelectorPlain(actor, wrapped) : useSelectorPlain(actor, wrapped, compare);
}

/** Runs a machine for as long as the component, warning as `useActorRef` does (M313, M314, M316). */
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
  // The whole snapshot, as the plain `useActor` selects it: no M315 check (it is not a selector an
  // app wrote, and the snapshot is a new object each move by design).
  return [useSelectorPlain(actor, (s) => s), actor];
}
