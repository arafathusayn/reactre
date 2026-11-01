// @reactre/core/server/dynamic: @reactre/core/features/dynamic in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). `dynamic(source)` renders what
// `source` returns as the client's does, but for a tag name builds the element's markup.

import type { DynamicComponent, PropsOf } from "@reactre/core";
import { __frag, __ssrElement, untrack } from "@reactre/core/server";

/**
 * `dynamic` from @reactre/core/features/dynamic, on the server: a component, called with the
 * props; a tag name's element, with the props as its attributes and their children; nothing for
 * null, undefined or false.
 */
export function dynamic<C extends DynamicComponent>(
  source: () => C | null | undefined | false,
): (props: PropsOf<C>) => unknown {
  return (props) =>
    __frag([
      () => {
        const c = source();
        return untrack(() =>
          typeof c === "function"
            ? (c as (p: unknown) => unknown)(props)
            : c
              ? __ssrElement(c as string, props as Record<string, unknown>)
              : null,
        );
      },
    ]);
}
