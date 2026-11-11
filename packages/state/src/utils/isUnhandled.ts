// @reactre/state/utils/isUnhandled (prototype): a `send` or `transition` result refused because no
// active node has a handler for the event (xstate docs: utilities.md). A handler that returned null
// refuses as "declined", which this isn't: `!result.ok && result.reason === "declined"` asks that.

/** `isUnhandled(actor.send(event))`: no active node handles the event, so it was ignored. */
export function isUnhandled<R extends { readonly ok: boolean }>(
  result: R,
): result is Extract<R, { readonly ok: false }> & { readonly reason: "unhandled" } {
  return !result.ok && (result as { readonly reason?: unknown }).reason === "unhandled";
}
