// @reactre/state/utils/getNextTransitions (prototype): each event a snapshot handles, with the
// nodes that handle it and the states it goes to (xstate docs: utilities.md).
// `getNextTransitions(machine, snapshot)`, or with payload samples: `getNextTransitions(machine,
// snapshot, { push: [{ by: "ann" }] })`.
//
// Design decisions:
//   - The handling nodes are read from the table (`o`, wildcards' "a.*" and "*" keys included) for
//     the snapshot's active nodes (the hierarchy's, `g`), innermost first, as the step asks them.
//   - Targets aren't data here: a handler is a function, so its targets are known by taking it,
//     through the pure step (as @reactre/state/graph does). Each event is taken with its samples,
//     or `{ type }` alone by default: a target that depends on a payload field shows with a sample
//     that has it. A sample every handler declines adds no target.
//   - The events callers send (setup's), not internal ones (tasks', raised): callers can't send those.

import { __step, type Machine, type SendEvent, type Shape, type Snapshot } from "../index.ts";
import type { __Compiled, __Handler } from "../internal.ts";
import { __nodes } from "../run.ts";

/** Payload samples by event type, without `type`. */
export type TransitionSamples<D extends Shape> = {
  readonly [E in SendEvent<D>["type"]]?: readonly Omit<Extract<SendEvent<D>, { readonly type: E }>, "type">[];
};

/** An event the snapshot handles. */
export interface NextTransition<D extends Shape> {
  readonly type: SendEvent<D>["type"];
  /** The active nodes with a handler for it, innermost first: the first that moves takes it. */
  readonly sources: readonly string[];
  /** The states it goes to, taken with each sample (or `{ type }`): none when every handler declines. */
  readonly targets: readonly string[];
}

type Handlers = { readonly [event: string]: __Handler | undefined };

/** The node handles `type`: exactly, by a prefix ("a.*"), or by "*" (wildcards' keys). */
const handles = (handlers: Handlers, type: string): boolean =>
  handlers[type] !== undefined ||
  handlers["*"] !== undefined ||
  type.split(".").some((_, i, parts) => i > 0 && handlers[`${parts.slice(0, i).join(".")}.*`] !== undefined);

/** `getNextTransitions(machine, snapshot)`: each event the snapshot handles, its nodes and its targets. */
export function getNextTransitions<D extends Shape>(
  machine: Machine<D>,
  snapshot: Snapshot<D>,
  samples?: TransitionSamples<D>,
): readonly NextTransition<D>[];
export function getNextTransitions(
  m: __Compiled,
  s: { readonly state: string; readonly data: unknown; readonly version: number },
  samples?: { readonly [type: string]: readonly object[] | undefined },
): readonly { readonly type: string; readonly sources: readonly string[]; readonly targets: readonly string[] }[] {
  const nodes = __nodes(m, s)
    .map((n) => n.node)
    .reverse();
  return Object.keys(m.e).flatMap((type) => {
    const sources = nodes.filter((node) => handles(m.o[node] ?? {}, type));
    if (sources.length === 0) return [];
    const targets = new Set<string>();
    for (const sample of samples?.[type] ?? [{}]) {
      try {
        const r = __step(m, s, { ...sample, type }, false);
        if (r.ok) targets.add(r.snapshot.state);
      } catch {
        // A handler that needs a payload field the sample lacks: give a sample with it.
      }
    }
    return [{ type, sources: [...new Set(sources)], targets: [...targets] }];
  });
}
