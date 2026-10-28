// @reactre/plugin for webpack. Options and modes are in ./index.ts.

import { reactre } from "./index.ts";

export type { CompatOptions, ReactreOptions } from "./index.ts";

/** The plugin for webpack. */
const plugin: (typeof reactre)["webpack"] = reactre.webpack;
export default plugin;
