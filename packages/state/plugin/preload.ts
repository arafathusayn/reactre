// @reactre/state/plugin/preload: registers the runtime plugin (./runtime.ts) with its defaults. In
// bunfig.toml: `preload = ["@reactre/state/plugin/preload"]`. To narrow the files it claims, or
// to turn development output off, register `statePreload(options)` from
// `@reactre/state/plugin/runtime` in a preload of your own instead.

import { statePreload } from "./runtime.ts";

export { statePreload } from "./runtime.ts";

Bun.plugin(statePreload());
