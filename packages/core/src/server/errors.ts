// @reactre/core/server/errors: @reactre/core/features/errors in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). Everything is the module's own,
// `<Errored>` included, but `effect`, which does not run on the server.

import type { EffectOptions } from "@reactre/core/features/errors";

export * from "@reactre/core/features/errors";

/** `effect` from @reactre/core/features/errors, on the server: `fn` never runs. */
export function effect(_fn: () => void, _options?: EffectOptions): void {}
