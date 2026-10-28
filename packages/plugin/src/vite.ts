// @reactre/plugin for Vite. Options and modes are in ./index.ts.

import { reactre } from "./index.ts";

export type { CompatOptions, ReactreOptions } from "./index.ts";

/** The plugin for Vite. */
const plugin: (typeof reactre)["vite"] = reactre.vite;
export default plugin;
