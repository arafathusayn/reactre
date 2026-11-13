// A radio in XState v5: a history state brings the player back to the leaf it was in.

import { createMachine } from "./xstate5.ts";

export const radioMachine = createMachine({
  types: {} as {
    events: { type: "play" } | { type: "pause" } | { type: "disconnect" } | { type: "reconnect" };
  },
  initial: "player",
  states: {
    player: {
      initial: "stopped",
      on: { disconnect: "offline" },
      states: {
        stopped: { on: { play: "playing" } },
        playing: { on: { pause: "paused" } },
        paused: { on: { play: "playing" } },
        hist: { type: "history", target: "stopped" },
      },
    },
    offline: { on: { reconnect: "player.hist" } },
  },
});
