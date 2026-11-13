// The app the installed-tarball dev-React test builds: a machine rendered by @reactre/state/react,
// with a selector that builds a new object each notification and no compare (M315), and an effect
// that sends once on mount to start it (M316). Under StrictMode in a real browser, the dev entry
// warns for both; the production entry warns for neither.

import { setup, types } from "@reactre/state";
import { useActor, useSelector } from "@reactre/state/react";

import { createElement, useEffect } from "./react-shim.ts";

const door = setup({
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>(), close: types<{}>() },
});

/** The erased compiled bundle implements this source machine's runtime table. */
export type DoorMachine = typeof doorMachine;

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});

/** The view: the state's name, and a selector that builds a new object with no compare. */
export function View(): unknown {
  const [snapshot, actor] = useActor(doorMachine);
  // M315: a new object each notification, equal to the last (the version doesn't change), so the
  // component re-renders on every move for nothing.
  const picked = useSelector(actor, (s) => ({ version: s.version }));
  // M316: a send from an effect that runs once, to start the machine. Its result is read, so the
  // compiler's M49 (a dropped send) doesn't fire: the mistake here is the effect's `[]`.
  useEffect(() => {
    const result = actor.send({ type: "push", by: "ann" });
    if (!result.ok) console.info(result.reason);
  }, []);
  return createElement(
    "div",
    { id: "app" },
    createElement("p", { id: "state" }, snapshot.state),
    createElement("p", { id: "picked" }, String(picked.version)),
  );
}
