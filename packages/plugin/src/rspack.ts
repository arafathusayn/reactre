// @reactre/plugin for Rspack. Options and modes are in ./index.ts.

import { reactre } from "./index.ts";

export type { CompatOptions, ReactreOptions } from "./index.ts";

/** The plugin for Rspack. */
const plugin: (typeof reactre)["rspack"] = reactre.rspack;
export default plugin;
