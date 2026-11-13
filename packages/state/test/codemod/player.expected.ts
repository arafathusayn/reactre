// A media player in XState v6: a parallel state whose regions each hold their own part of the
// context, and a transition on the parallel state itself.

import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";

const player = setup({
  use: [nested, parallel],
  parallel: ["on"],
  states: {
    off: types<{ level: number }>(),
    "on.playback.stopped": types<{}>(),
    "on.playback.playing": types<{ track: string }>(),
    "on.volume.audible": types<{ level: number }>(),
    "on.volume.muted": types<{ level: number }>(),
  },
  events: {
    power: types<{}>(),
    play: types<{ track: string }>(),
    stop: types<{}>(),
    mute: types<{}>(),
    unmute: types<{}>(),
    louder: types<{}>(),
  },
});

export const playerMachine = player.machine({
  start: ({ to }) => to("off", { level: 5 }),
  states: {
    off: {
      on: {
        power: ({ data, to }) =>
          to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", data) }),
      },
    },
    on: { on: { power: ({ data, to }) => to("off", { level: data.volume.data.level }) } },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { on: { stop: ({ to }) => to("on.playback.stopped") } },
    "on.volume.audible": {
      on: {
        mute: ({ data, to }) => to("on.volume.muted", data),
        louder: ({ data, to }) => to("on.volume.audible", { level: data.level + 1 }),
      },
    },
    "on.volume.muted": { on: { unmute: ({ data, to }) => to("on.volume.audible", data) } },
  },
});
