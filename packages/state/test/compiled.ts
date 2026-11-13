// Registers the runtime plugin, so the fixtures load compiled, as an app's files do in a build.
// Import it, then import the fixtures dynamically (static imports load before it runs).
//
// It claims only this package's files: `bun test` at the repository's root runs every package's
// tests in one process, and a runtime plugin that claims a file keeps the other packages' plugins
// (@reactre/compiler's) from loading it.

import { statePreload } from "@reactre/state/plugin/runtime";

Bun.plugin(statePreload({ filter: /\/packages\/state\/.*\.[cm]?tsx?$/ }));
