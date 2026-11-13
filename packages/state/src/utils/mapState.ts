// `mapState(snapshot, mapper)`: a value per state, picked by the snapshot: the mapper's functions for
// every path the snapshot is in, most specific first (xstate docs: utilities.md, `mapState`). XState
// nests the mapper like its state config; here the keys are dotted names, as states are.

import { __matches, type Matching, type Paths } from "./matches.ts";

/** The functions, by path: each gets the snapshot narrowed to that path. */
export type Mapper<S, R> = { readonly [P in Paths<S> & string]?: (snapshot: Matching<S, P>) => R };

/**
 * `mapState(snapshot, { edit: () => "Editing", "edit.review": (s) => s.data.by })`: the results of
 * the functions whose path the snapshot is in, most specific (the longest path) first.
 */
export function mapState<S extends { readonly state: string; readonly data: unknown }, R>(
  snapshot: S,
  mapper: Mapper<S, R>,
): R[];
export function mapState(
  s: { readonly state: string; readonly data: unknown },
  mapper: { readonly [path: string]: ((snapshot: never) => unknown) | undefined },
): unknown[] {
  return (
    Object.keys(mapper)
      .filter((path) => __matches(s, path))
      .sort((a, b) => b.split(".").length - a.split(".").length)
      // A cast: each function takes the snapshot narrowed to its path, which `__matches` just checked.
      .map((path) => mapper[path]?.(s as never))
  );
}
