// @reactre/plugin for Rolldown. Options and modes are in ./index.ts.

import { reactre } from "./index.ts";

export type { CompatOptions, ReactreOptions } from "./index.ts";

/** The plugin for Rolldown. */
const plugin: (typeof reactre)["rolldown"] = reactre.rolldown;
export default plugin;
