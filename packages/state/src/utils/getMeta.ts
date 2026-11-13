// `getMeta(machine, snapshot)`: the meta of the active nodes that have some, by node name (with tags
// in use; xstate docs: snapshots.md, `getMeta`, keyed by node id there, by name here).

import type { Machine, NeedsOptIn, Shape, Snapshot } from "../index.ts";
import type { __Compiled } from "../internal.ts";
import { __nodes } from "../run.ts";
import type { MetaOf } from "./getStateNodes.ts";

/** `getMeta(machine, snapshot)`: `{ [node]: meta }` for each active node with meta. */
export function getMeta<D extends Shape>(
  machine: Machine<D> & NeedsOptIn<D, "tags", "getMeta(machine, snapshot)">,
  snapshot: Snapshot<D>,
): { readonly [node: string]: MetaOf<D> };
export function getMeta(
  m: __Compiled,
  s: { readonly state: string; readonly data: unknown },
): { [node: string]: unknown } {
  const out: { [node: string]: unknown } = {};
  for (const { node } of __nodes(m, s)) {
    const meta = m.k?.[node]?.[1];
    if (meta !== undefined) out[node] = meta;
  }
  return out;
}
