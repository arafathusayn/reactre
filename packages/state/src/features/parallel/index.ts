// @reactre/state/parallel (prototype): parallel nodes, whose regions are each in a leaf at once:
// `setup({ use: [nested, parallel], parallel: ["player"], ... })`. It needs nested, whose graph and
// step run the regions (../nested/index.ts); the compiler writes the regions in `p` and each node's
// `done` in `n`, so this value carries no code.

import type { Feature } from "../../index.ts";

/** The parallel opt-in (with nested): setup's `parallel` lists the parallel nodes. */
export const parallel: Feature<"parallel"> = {};
