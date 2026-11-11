// A radio in XState v5: a history state brings the player back to the leaf it was in.

import { setup, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

const radio = setup({
  use: [nested, history],
  states: {
    "player.stopped": types<{}>(),
    "player.playing": types<{}>(),
    "player.paused": types<{}>(),
    offline: types<{}>(),
  },
  events: { play: types<{}>(), pause: types<{}>(), disconnect: types<{}>(), reconnect: types<{}>() },
});

export const radioMachine = radio.machine({
  start: ({ to }) => to("player.stopped"),
  states: {
    player: { on: { disconnect: ({ to }) => to("offline") } },
    "player.stopped": { on: { play: ({ to }) => to("player.playing") } },
    "player.playing": { on: { pause: ({ to }) => to("player.paused") } },
    "player.paused": { on: { play: ({ to }) => to("player.playing") } },
    offline: { on: { reconnect: ({ to, back }) => back("player", to("player.stopped")) } },
  },
});
