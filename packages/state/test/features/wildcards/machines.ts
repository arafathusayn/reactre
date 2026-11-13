// A machine with wildcard handlers, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { wildcards } from "@reactre/state/wildcards";

const canvas = setup({
  use: [wildcards],
  states: { idle: types<{ last: string }>(), drawing: types<{ last: string }>() },
  events: {
    "pointer.down": types<{ x: number }>(),
    "pointer.move": types<{ x: number }>(),
    "pointer.up": types<{}>(),
    "key.escape": types<{}>(),
    reset: types<{}>(),
  },
});

export const canvasMachine = canvas.machine({
  start: ({ to }) => to("idle", { last: "" }),
  states: {
    idle: {
      on: {
        "pointer.down": ({ event, to }) => to("drawing", { last: `down ${event.x}` }),
        // Every other pointer event: noted, and the machine stays.
        "pointer.*": ({ event, to }) => to("idle", { last: event.type }),
        // Anything else (key.escape, reset): declined.
        "*": () => null,
      },
    },
    drawing: {
      on: {
        "pointer.up": ({ to }) => to("idle", { last: "up" }),
        // The exact key wins, then the longest prefix, then "*".
        "pointer.*": ({ event, data, to }) =>
          to("drawing", { last: "x" in event ? `${event.type} ${event.x}` : data.last }),
        "*": ({ event, to }) => to("idle", { last: event.type }),
      },
    },
  },
});
