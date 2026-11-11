// @reactre/state/dev (prototype): what a development build adds. The compiler imports it only with
// `dev` on, so a production bundle ships none of it.

import { __child, __later, type __Pending } from "./features/effects/index.ts";
import { StateError } from "./index.ts";
import type { __Effect, __EffectContext, __EffectRunners, __Event } from "./internal.ts";

/** A path in data, as a reader writes it: `data.ratio`, `data.items[0].n`. */
function at(path: string, key: string | number): string {
  return typeof key === "number" ? `${path}[${key}]` : `${path}.${key}`;
}

/**
 * Internal: freezes data all the way down, so a transition that edits it throws where it does, and
 * checks it is JSON a snapshot can hold: a number that is finite (M35: `NaN` and `±Infinity` become
 * `null` through JSON), and no cycle (M36: JSON.stringify throws on one, and a frozen cycle is a
 * snapshot no store can save). `ancestors` is the path's own chain, not every object seen: a value
 * shared by two fields (a module constant, `__none`) is not a cycle.
 *
 * @throws StateError S3, naming the path and the fix.
 */
function freeze(value: unknown, path = "data", ancestors: Set<object> = new Set()): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new StateError(
        "S3",
        `${path} is ${String(value)}, which JSON turns into null: a snapshot holds finite numbers only. Guard the division (a total of 0), or keep the value out of data.`,
      );
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value))
    throw new StateError(
      "S3",
      `${path} is a cycle: it holds an object that holds it. JSON.stringify throws on one, so the snapshot can't be saved. Copy the value instead of pointing back at it.`,
    );
  ancestors.add(value);
  if (Array.isArray(value)) value.forEach((v, i) => freeze(v, at(path, i), ancestors));
  else for (const [k, v] of Object.entries(value)) freeze(v, at(path, k), ancestors);
  ancestors.delete(value);
  // A frozen object is walked too: it may hold a NaN or a cycle (a module constant, `__none`).
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
}

/** How many listener rounds one move may take before it is a loop (M51). */
const ROUNDS = 100;

/**
 * Internal: the listener-round check of one actor (M51), made once when the actor is created. The
 * core's `__run` calls the returned function with `0` when a move starts telling its listeners
 * (a root move: the count starts over) and with `1` for each further round of that move (a
 * listener sent, so the actor moved again). A listener that sends on every snapshot it is told
 * never rests: past `ROUNDS` rounds the check throws, naming the listener's fix. A move that nests
 * in another (a listener's send) doesn't reset the count, so a chain of them is bounded too.
 * Production has no `d`, so nothing is counted.
 *
 * @throws StateError S29, naming the fix.
 */
function round(): (told: 0 | 1) => void {
  let count = 0;
  return (told) => {
    if (!told) count = 0;
    else if (++count > ROUNDS)
      throw new StateError(
        "S29",
        `a listener sent an event on every snapshot it was told, so the actor moved ${ROUNDS} times without resting: a subscribe listener that sends must stop sending once the state it waits for is reached (check the state it tests), or the send belongs in a task or an effect.`,
      );
  };
}

/**
 * Internal: `enq.sendTo` to a child by name that isn't running (M149). The send is dropped, which
 * is right (the child may start later), but silently: a development build says so, naming the
 * child and the fix. The lookup happens when the send happens: now, or when a delayed one fires,
 * so a child that starts in between isn't a false positive.
 */
function dead(name: string, key: string | undefined): void {
  console.warn(
    `[@reactre/state S29] enq.sendTo("${name}"${key === undefined ? "" : `, key "${key}"`}) found no running child of that name, so the event was dropped: send it from a state whose children include "${name}", or check the child is running before sending.`,
  );
}

/**
 * Internal: a development build's effect runners (M149): `effects.q`'s `sendTo`, with a warning
 * when the child it names isn't running. The compiler emits `q: __reactreStateDevEffects(effects.q)`
 * only with `dev` on, so a production build's runner map is `effects.q` itself and ships none of
 * this. Every other effect type is the runner it was given.
 */
export function __effects(q: __EffectRunners): __EffectRunners {
  const sendTo = q["sendTo"];
  if (sendTo === undefined) return q;
  return {
    ...q,
    sendTo: (e: __Effect, ctx: __EffectContext): void => {
      const { to, event, key } = e as unknown as {
        readonly to: unknown;
        readonly event: __Event;
        readonly key?: string;
      };
      // A reference (`to` an actor) is the app's own, and isn't checked. A child by name is looked
      // up when the send happens: now, or when a delayed one fires, so a child that starts in
      // between isn't a false positive.
      if (typeof to !== "string") return sendTo(e, ctx);
      __later(ctx, e as __Pending["e"], () => {
        const at = __child(ctx.live, to, key);
        if (at === undefined) return dead(to, key);
        at.send(event);
      });
    },
  };
}

/**
 * Internal: the development value the compiler emits as `d: __reactreStateFreeze`: the freeze, with
 * the round check and the dead-child warning on it, so a development build's `d` is one value and a
 * production build has none. The properties are assigned here, once, at import: the compiler's
 * `d: __reactreStateFreeze` is this value, so `m.d.round` and `m.d.dead` are there.
 */
export const __freeze: typeof freeze & {
  readonly round: () => (told: 0 | 1) => void;
  readonly dead: (name: string, key: string | undefined) => void;
} = Object.assign(freeze, { round, dead });

/** The same value, under the name a hand-written table in a test reads. */
export const __dev: typeof __freeze = __freeze;
