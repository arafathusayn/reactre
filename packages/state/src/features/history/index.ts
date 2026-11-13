// @reactre/state/history (prototype): `back(parent, fallback)` in a handler, which goes to the leaf
// the parent held when it was last left: `setup({ use: [nested, history], ... })`. It needs nested,
// whose snapshot keeps each tracked parent's last leaf (../nested/index.ts); the compiler lists the
// parents `back` goes to in `h`, so this value carries no code.
//
// Design decisions:
//   - Deep history is `back(parent, fallback)`: the last leaf, whole, with its data.
//   - Shallow history is `back(parent, fallback, { child: to(...) })`: the parent's last direct
//     child. XState re-enters that child at its `initial`; here a leaf needs its data, which a parent
//     doesn't have, so each direct child that is a parent gets a step in the third argument (types
//     require one for each). A direct child that is a leaf comes back whole, as with deep history.
//   - Both fall back to `fallback` when the parent was never left (XState's required default target).

import type { Feature } from "../../index.ts";

/** The history opt-in (with nested): handlers get `back`. */
export const history: Feature<"history"> = {};
