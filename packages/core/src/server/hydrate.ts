// @reactre/core/server/hydrate: @reactre/core/features/hydrate in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode), so code shared by the server
// and the client can import what it needs of hydration from one place. Nothing hydrates on the
// server: `isHydrating` is false and `hydrate` throws; `takeHydrationValue` has nothing to take,
// and `getHydrationWriter` is the render's (@reactre/core/server's); `clientOnly` writes the
// fallback, never loading the component.

export * from "@reactre/core/server";
export type { HydrationValue } from "@reactre/core/features/hydrate";

/** False: nothing claims a page on the server. */
export function isHydrating(): boolean {
  return false;
}

/** Throws: hydration claims a page in the browser, not on the server. */
export function hydrate(_view: () => unknown, _el: unknown): () => void {
  throw new Error("reactre: hydrate claims the server's HTML in the browser; it does not run in a server build");
}
