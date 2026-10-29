// @reactre/preact/core: Preact's API (`preact` and `preact/hooks`) on Preact's semantics.
// Alias `preact` and `preact/hooks` to it. Each part installs itself only when imported, so an
// app pays for the hooks only if it uses one.

export { __block, __template } from "./block.ts";
export {
  cloneElement,
  Component,
  createContext,
  createElement,
  createPortal,
  createRef,
  Fragment,
  createElement as h,
  isValidElement,
  options,
  toChildArray,
} from "./engine.ts";
export { hydrate, render } from "./claim.ts";
export { html } from "./html.ts";
export * from "./hooks.ts";
