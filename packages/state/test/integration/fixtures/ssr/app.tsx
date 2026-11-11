// The app the installed-tarball SSR test builds: a machine rendered by @reactre/state/react, with
// a button that sends an event. The server renders it to HTML; the client hydrates the same tree
// under StrictMode and the button's click must move the machine.
//
// The start state has a task, and the task counts its runs in `started`. A server render runs no
// effect, so the actor never starts and the task never runs: the server half asserts `started` is
// 0 after rendering. A render that started the actor would show it as 1.

import { setup, types } from "@reactre/state";
import { useActor } from "@reactre/state/react";
import { createElement } from "react";

/** How many times the start state's task ran: 0 after a server render, 1 once a client starts it. */
export const started: string[] = [];

const door = setup({
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>() },
  internal: { booted: types<{}>() },
});

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      // The task is the side effect a render must not run: it records that it started.
      task: {
        run: async () => {
          started.push("closed");
          return { type: "booted" };
        },
        error: ({ keep }) => keep("closed"),
      },
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        // A stay: the task keeps running with the data it started with.
        booted: ({ keep }) => keep("closed"),
      },
    },
    // The open state is a dead end: it ends the machine.
    open: { final: true },
  },
});

/** The view: the state's name, and a button that pushes the door open. */
export function View(): unknown {
  const [snapshot, actor] = useActor(doorMachine);
  return createElement(
    "div",
    { id: "app" },
    createElement("p", { id: "state" }, snapshot.state),
    createElement("button", { id: "push", onClick: () => actor.send({ type: "push", by: "ann" }) }, "push"),
  );
}
