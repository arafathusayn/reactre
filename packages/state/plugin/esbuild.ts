// @reactre/state's plugin for esbuild.

import { state } from "./index.ts";

export type { StateOptions } from "./index.ts";

/** The plugin for esbuild. */
const plugin: (typeof state)["esbuild"] = state.esbuild;
export default plugin;
