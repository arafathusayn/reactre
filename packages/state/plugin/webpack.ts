// @reactre/state's plugin for webpack.

import { state } from "./index.ts";

export type { StateOptions } from "./index.ts";

/** The plugin for webpack. */
const plugin: (typeof state)["webpack"] = state.webpack;
export default plugin;
