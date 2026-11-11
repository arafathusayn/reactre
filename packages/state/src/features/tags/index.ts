// @reactre/state/tags (prototype): tags, meta and descriptions on nodes, `setup({ use: [tags], ... })`,
// then `uploading: { tags: ["busy"], meta: { label: "Uploading" }, description: "...", on: ... }`.
//
// Design decisions:
//   - XState's `tags`, `meta` and `description`, with `snapshot.hasTag(tag)` and `getMeta()`. A
//     snapshot here is plain JSON (`{ state, data }`), so the helpers take the machine too:
//     `hasTag(machine, snapshot, "busy")`, `getMeta(machine, snapshot)` and `getStateNodes(...)`
//     in @reactre/state/utils. The machine's type carries the tags written, so a misspelled tag is
//     a type error there (XState needs `schemas.tags` for that).
//   - The compiler writes them in the table (`k`), only for a machine that has some: this value
//     carries no code.

import type { Feature } from "../../index.ts";

/** The tags opt-in: `tags`, `meta` and `description` on nodes. */
export const tags: Feature<"tags"> = {};
