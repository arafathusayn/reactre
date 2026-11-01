// @reactre/core/features/dynamic: `dynamic(source)`, a component whose content is chosen at
// runtime, as `<Dynamic component>` chooses it.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and this is a runtime function. `<Dynamic>` itself stays in the core, as it is
//     compiled away; so do the types both take (`DynamicComponent`, `PropsOf`).
//   - Built from what compiled code calls (`__frag`, `__spread`, `__insert`), so its content is a
//     slot, as `<Dynamic>`'s is, and it brings ownership as a slot does.

import { __frag, __insert, __spread, type DynamicComponent, type PropsOf, untrack } from "@reactre/core";

/**
 * A component that renders what `source` returns: a component, called with the props, or a tag
 * name's element, with the props applied as spread props are; nothing for null, undefined or
 * false. What `source` reads is followed: a new value rebuilds the content. It is
 * `<Dynamic component={source()} />` as a component of its own, to hand on or name.
 *
 * @example
 *   import { dynamic } from "@reactre/core/features/dynamic";
 *
 *   const View = dynamic(() => (editing() ? Editor : Preview));
 *   const App = () => <main><View doc={doc} /></main>;
 */
export function dynamic<C extends DynamicComponent>(
  source: () => C | null | undefined | false,
): (props: PropsOf<C>) => unknown {
  return (props) =>
    __frag([
      () => {
        // The source is the slot's one dependency; what the content reads is its own.
        const c = source();
        return untrack(() => build(c, props as Record<string, unknown>));
      },
    ]);
}

/** What `dynamic`'s content is for one value of its source. */
function build(c: unknown, props: Record<string, unknown>): unknown {
  if (typeof c === "function") return (c as (p: unknown) => unknown)(props);
  if (!c) return null;
  const el = document.createElement(c as string);
  __spread(el, props, undefined);
  if (props["children"] != null) __insert(el.appendChild(document.createTextNode("")), props["children"], null);
  return el;
}
