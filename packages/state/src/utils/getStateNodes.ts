// `getStateNodes(machine, snapshot)`: the snapshot's active nodes, outermost first (each parent of
// the leaf, then the leaf; for a parallel node, each region's), with what tags put on them
// (xstate docs: snapshots.md, `snapshot.nodes`). Its node graph is the machine's: no hierarchy code
// ships with a flat machine.

import type { NodeName } from "../features/nested/types.ts";
import type { Machine, Shape, Snapshot } from "../index.ts";
import type { __Compiled } from "../internal.ts";
import { __nodes } from "../run.ts";

/** Tags written on a machine's nodes (with tags in use), from its type. */
export type TagOf<D> = D extends { readonly "~tags": infer T } ? T : never;
/** The meta written on a machine's nodes (with tags in use), from its type. */
export type MetaOf<D> = D extends { readonly "~meta": infer M } ? M : never;

/** An active node: its name, the unit under it (`state`, `data`), and its tags, meta and description. */
export interface StateNode<D extends Shape> {
  readonly node: NodeName<D>;
  /** The leaf (or a parallel node) under it now, and its data. */
  readonly state: string;
  readonly data: unknown;
  readonly tags: readonly TagOf<D>[];
  readonly meta: MetaOf<D> | undefined;
  readonly description: string | undefined;
}

/** `getStateNodes(machine, snapshot)`: the active nodes, outermost first. */
export function getStateNodes<D extends Shape>(machine: Machine<D>, snapshot: Snapshot<D>): StateNode<D>[];
export function getStateNodes(m: __Compiled, s: { readonly state: string; readonly data: unknown }): unknown[] {
  return __nodes(m, s).map(({ node, state, data }) => {
    const [tags = [], meta, description] = m.k?.[node] ?? [];
    return { node, state, data, tags, meta, description };
  });
}
