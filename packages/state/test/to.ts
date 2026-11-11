// The step a compiled `to(state, data)` is (`__To`: the snapshot itself), for the tables tests
// write by hand. `version` is the table's `v`.

import type { __To } from "../src/internal.ts";

export const to = (state: string, data: unknown = {}, version = 0): __To => ({ state, data, version });
