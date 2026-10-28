// @reactre/plugin for Rollup. Options and modes are in ./index.ts.

import { reactre } from "./index.ts";

export type { CompatOptions, ReactreOptions } from "./index.ts";

/** The plugin for Rollup. */
const plugin: (typeof reactre)["rollup"] = reactre.rollup;
export default plugin;
