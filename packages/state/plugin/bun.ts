// @reactre/state's plugin for Bun: `Bun.build({ plugins: [state()] })`, or `Bun.plugin(state())`
// in a preload for `bun run` and `bun test`.

import { state } from "./index.ts";

export type { StateOptions } from "./index.ts";

/** The plugin for Bun. */
const plugin: (typeof state)["bun"] = state.bun;
export default plugin;
