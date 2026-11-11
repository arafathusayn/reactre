// @reactre/state/inspect (prototype): `inspect` and `logger`, actor options of a machine with
// `use: [inspect]` (xstate docs: inspection.md, inspect-actor-systems.md). An inspector gets an
// event when an actor starts, for each event it steps, for each move, and when it stops or ends;
// `logger` gets the same as readable lines.
//
// Design decisions:
//   - Opted into per machine, so a machine without it ships none of it, and an actor of it pays one
//     check per move when no inspector is given. Listed, it is used: it wraps the step and the
//     lifecycle (`y: inspect.y(...)`, `r: inspect.w(...)`), which is its cost.
//   - The step sees each event and its result, and the lifecycle sees each move and the actor's
//     options. They meet through the snapshot: the lifecycle marks each snapshot the actor enters as
//     its own, and the step reports for the actor whose snapshot it steps from. So `transition()` on
//     a live actor's current snapshot is reported to that actor's inspector too.
//   - Children inherit the inspector (the children runner passes the options down), each with its
//     path as id ("root/upload"): a child machine that also lists inspect reports itself. Actor
//     logic doesn't (its tables have no inspect hooks).
//   - An event the machine doesn't know at all (not in its events) is refused before any step, so
//     it isn't reported. An inspector that throws doesn't stop the actor: the error is rethrown in a
//     microtask, and the actor goes on.
//   - XState's `@xstate.actor` and `@xstate.transition` are "actor", and "event" (what an event did,
//     refused or not) with "transition" (each move, with its effects); stop is its own event.

import { __flat, type Feature } from "../../index.ts";
import type { __Effect, __Lifecycle, __Snapshot, __StepHook } from "../../internal.ts";
import type { InspectionEvent, Inspector } from "./types.ts";

export type { InspectedSnapshot, InspectionEvent, Inspector } from "./types.ts";

/** Each snapshot an inspected actor entered, and the inspector to tell about steps from it. */
const owners = new WeakMap<__Snapshot, { readonly id: string; readonly tell: Inspector }>();

/** Internal: the step that reports each event, and what it did, to the actor that stepped it. */
export function __inspected(inner?: __StepHook): __StepHook {
  return (m, from, event, internal) => {
    const r = inner ? inner(m, from, event, internal) : __flat(m, from, event);
    const o = owners.get(from);
    o?.tell({
      type: "event",
      id: o.id,
      event,
      internal,
      ok: r.ok,
      ...(r.ok ? {} : { reason: r.reason }),
      snapshot: r.snapshot,
    });
    return r;
  };
}

/** Each inspection event as a line: `[root] checkout → paying`. */
function lines(log: (line: string) => void): Inspector {
  let stepped = false;
  return (e) => {
    const at = `[${e.id}]`;
    if (e.type === "actor") log(`${at} started in ${e.snapshot.state}${e.parent ? ` (child of ${e.parent})` : ""}`);
    else if (e.type === "event") {
      stepped = e.ok;
      log(`${at} ${e.event.type} ${e.ok ? `→ ${e.snapshot.state}` : `refused: ${e.reason ?? ""}`}`);
    } else if (e.type === "transition") {
      // A move an event made was logged with the event.
      if (!stepped) log(`${at} → ${e.snapshot.state}`);
      stepped = false;
    } else log(`${at} ${e.status} in ${e.snapshot.state}`);
  };
}

/** Internal: the lifecycle that tells the actor's inspector (and logger) what happens, around `inner`. */
export function __watched(inner?: __Lifecycle): __Lifecycle {
  return (m, move, current, options) => {
    const live = inner?.(m, move, current, options);
    const inspect = options?.inspect;
    const log = options?.logger && lines(options.logger);
    if (!inspect && !log) return live ?? { enter() {}, stop() {} };
    const id = options?.id ?? "root";
    const slash = id.lastIndexOf("/");
    const tell: Inspector = (e: InspectionEvent) => {
      for (const f of [inspect, log])
        try {
          f?.(e);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
    };
    const own = { id, tell };
    let started = false;
    return {
      ...(live?.works && { works: live.works }),
      m: live?.m ?? m,
      enter(next, active, result) {
        owners.set(next, own);
        const effects: readonly __Effect[] = (result.ok && result.fx) || [];
        if (started) tell({ type: "transition", id, snapshot: next, effects });
        else {
          started = true;
          tell({ type: "actor", id, ...(slash > 0 && { parent: id.slice(0, slash) }), snapshot: next });
        }
        live?.enter(next, active, result);
        if (!active) tell({ type: "stop", id, status: "done", snapshot: next });
      },
      stop() {
        live?.stop();
        tell({ type: "stop", id, status: "stopped", snapshot: current() });
      },
    };
  };
}

/** The inspect opt-in: `setup({ use: [inspect] })`, then `createActor(machine, { inspect, logger })`. */
export const inspect: Inspect = { y: __inspected, w: __watched };

/** The inspect opt-in's type: an interface, so a type error names it `Inspect`, not its hooks. */
export interface Inspect extends Feature<"inspect"> {
  /** Internal: the step that reports events (`y: inspect.y(inner)`). */
  readonly y: typeof __inspected;
  /** Internal: the lifecycle that reports moves (`r: inspect.w(inner)`). */
  readonly w: typeof __watched;
}
