// @reactre/core/server/timing: @reactre/core/features/timing in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). Everything is the module's own
// but `onSettled`: its callback works with the page the browser shows (focus, measure, observe),
// and on the server nothing settles into one, so it never runs, as in Solid 2.0's server.

export * from "@reactre/core/features/timing";

/** `onSettled` from @reactre/core/features/timing, on the server: `fn` never runs. */
export function onSettled(_fn: () => void | (() => void)): void {}
