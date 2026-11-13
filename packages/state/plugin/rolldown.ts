// @reactre/state's plugin for Rolldown.

import { state } from "./index.ts";

export type { StateOptions } from "./index.ts";

/** The plugin for Rolldown. */
const plugin: (typeof state)["rolldown"] = state.rolldown;
export default plugin;
