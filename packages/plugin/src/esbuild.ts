// @reactre/plugin for esbuild. Options and modes are in ./index.ts.

import { reactre } from "./index.ts";

export type { CompatOptions, ReactreOptions } from "./index.ts";

/** The plugin for esbuild. */
const plugin: (typeof reactre)["esbuild"] = reactre.esbuild;
export default plugin;
