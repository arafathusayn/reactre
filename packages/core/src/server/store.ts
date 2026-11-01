// @reactre/core/server/store: @reactre/core/features/store in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode, once the module is compiled, as
// the compiler knows its stores by the client's module). Everything is the module's own but
// `deep`, which is the store itself, as in Solid 2.0's server: nothing there follows a store's
// changes, so there is nothing to subscribe to, and no copy to make.

export * from "@reactre/core/features/store";

/** `deep` from @reactre/core/features/store, on the server: `store` itself. */
export function deep<T>(store: T): T {
  return store;
}
