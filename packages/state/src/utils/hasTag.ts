// `hasTag(machine, snapshot, tag)`: some active node has `tag` (with tags in use; xstate docs:
// snapshots.md). A snapshot is plain JSON here, so the machine (which holds the tags) comes first;
// its type holds the tags written, so a misspelled one is a type error.

import type { Machine, NeedsOptIn, Shape, Snapshot } from "../index.ts";
import type { __Compiled } from "../internal.ts";
import { __nodes } from "../run.ts";
import type { TagOf } from "./getStateNodes.ts";

/** `hasTag(machine, snapshot, "busy")`: some active node is tagged "busy". */
export function hasTag<D extends Shape>(
  machine: Machine<D> & NeedsOptIn<D, "tags", "hasTag(machine, snapshot, tag)">,
  snapshot: Snapshot<D>,
  tag: TagOf<D>,
): boolean;
export function hasTag(m: __Compiled, s: { readonly state: string; readonly data: unknown }, tag: unknown): boolean {
  return __nodes(m, s).some(({ node }) => m.k?.[node]?.[0].some((t) => t === tag) === true);
}
