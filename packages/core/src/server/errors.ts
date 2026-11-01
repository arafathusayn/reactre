// @reactre/core/server/errors: @reactre/core/features/errors in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). Everything is the module's own
// but `effect`, which does not run on the server, and `<Errored>`, which, in a render with
// `hydrate: true`, writes a marker before the fallback it shows, with the error's name and
// message: hydration (@reactre/core/hydrate/errors) then shows the fallback, with that error,
// instead of building the children again.

import { type EffectOptions, Errored as errored, type ErroredFallback } from "@reactre/core/features/errors";
import type { Child } from "@reactre/core/jsx-runtime";
import { __ssrErrored } from "@reactre/core/server";

export * from "@reactre/core/features/errors";

/** `effect` from @reactre/core/features/errors, on the server: `fn` never runs. */
export function effect(_fn: () => void, _options?: EffectOptions): void {}

/** `<Errored>` on the server: features/errors' own, with the marker before its fallback. */
export function Errored(props: { fallback: ErroredFallback; children?: Child | (() => Child) }): unknown {
  return errored({
    get children() {
      return props.children;
    },
    fallback: (err: unknown, reset: () => void) => {
      const f = props.fallback;
      return [__ssrErrored(err), typeof f === "function" ? f(err, reset) : f] as Child;
    },
  });
}
