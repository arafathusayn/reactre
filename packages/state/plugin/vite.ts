// @reactre/state's plugin for Vite: `plugins: [state(), ...]`, before plugins that strip types.

import { state } from "./index.ts";

export type { StateOptions } from "./index.ts";

/** The plugin for Vite. */
const plugin: (typeof state)["vite"] = state.vite;
export default plugin;
