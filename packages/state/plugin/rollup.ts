// @reactre/state's plugin for Rollup.

import { state } from "./index.ts";

export type { StateOptions } from "./index.ts";

/** The plugin for Rollup. */
const plugin: (typeof state)["rollup"] = state.rollup;
export default plugin;
