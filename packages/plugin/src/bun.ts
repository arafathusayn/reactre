// @reactre/plugin for Bun. Options and modes are in ./index.ts.

import { reactre } from "./index.ts";

export type { CompatOptions, ReactreOptions } from "./index.ts";

/** The plugin for Bun. */
const plugin: (typeof reactre)["bun"] = reactre.bun;
export default plugin;
