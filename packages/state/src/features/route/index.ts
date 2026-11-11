// @reactre/state/route (prototype): route states, `setup({ use: [route], ... })`, then
// `checkout: { route: ({ data, to }) => to("checkout", { items: [] }), on: { ... } }` and
// `actor.send({ type: "route", to: "checkout" })` from any state.
//
// Design decisions:
//   - XState marks a state with `id` and `route`, and routes with `{ type: "xstate.route", to: "#id" }`.
//     Here a node's name is its id, so `route` alone marks it, and the event is `{ type: "route",
//     to: "<node>" }`, typed in `send` and `transition` (a node without `route` is a type error there).
//   - The route function is the guard and the resolver at once, as in XState: it gets where the
//     machine is now (`state`, `data`) and returns the step into its node, with that node's data
//     (every state has its own), or null to refuse ("declined").
//   - A node inside a parallel node isn't routable: entering one needs a step for every region, and
//     the parallel node itself is (`to("player", { ... })`).
//   - It runs before the other handlers: a route is no node's event. Its step hook wraps the one
//     before it in the table (`y: route.y(nested.y)`), and setup's events gain "route".

import { __flat, __snap, type Feature } from "../../index.ts";
import type { __StepHook } from "../../internal.ts";

/** Internal: the step for `{ type: "route", to }`, around the step it wraps (the flat one by default). */
export const __route =
  (inner?: __StepHook): __StepHook =>
  (m, from, event, internal) => {
    if (event.type !== "route") return inner ? inner(m, from, event, internal) : __flat(m, from, event);
    const to: unknown = Reflect.get(event, "to");
    const next = m.ro?.[String(to)]?.(from.data, event, from.state);
    return next
      ? { ok: true, snapshot: __snap(m, next, from) }
      : { ok: false, reason: next === null ? "declined" : "unhandled", snapshot: from };
  };

/** The route opt-in: `route: ({ state, data, to }) => to(...)` on a node, and the route event. */
export const route: RouteFeature = { y: __route };

/** The route opt-in's type: an interface, so a type error names it. */
export interface RouteFeature extends Feature<"route"> {
  /** Internal: wraps the step (`y` in the table). */
  readonly y: (inner?: __StepHook) => __StepHook;
}
