// @reactre/state's plugin for Rspack.

import { state } from "./index.ts";

export type { StateOptions } from "./index.ts";

/** The plugin for Rspack. */
const plugin: (typeof state)["rspack"] = state.rspack;
export default plugin;
