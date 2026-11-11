// A parallel node inside another's region, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";

const studio = setup({
  use: [nested, parallel],
  parallel: ["on", "on.media.player"],
  states: {
    off: types<{}>(),
    "on.media.idle": types<{}>(),
    "on.media.player.track.stopped": types<{}>(),
    "on.media.player.track.playing": types<{ title: string }>(),
    "on.media.player.track.done": types<{}>(),
    "on.media.player.volume.level": types<{ level: number }>(),
    "on.media.player.volume.muted": types<{}>(),
    "on.media.finished": types<{}>(),
    "on.chat.closed": types<{}>(),
    "on.chat.open": types<{}>(),
  },
  events: {
    power: types<{}>(),
    load: types<{}>(),
    play: types<{ title: string }>(),
    end: types<{}>(),
    mute: types<{}>(),
    eject: types<{}>(),
    chat: types<{}>(),
  },
});

export const studioMachine = studio.machine({
  start: ({ to }) => to("off"),
  states: {
    off: { on: { power: ({ to }) => to("on", { media: to("on.media.idle"), chat: to("on.chat.closed") }) } },
    on: { on: { power: ({ to }) => to("off") } },
    "on.media.idle": {
      on: {
        load: ({ to }) =>
          to("on.media.player", {
            track: to("on.media.player.track.stopped"),
            volume: to("on.media.player.volume.level", { level: 5 }),
          }),
      },
    },
    // The inner parallel node: its own handler, and a done when its track region ends.
    "on.media.player": {
      on: { eject: ({ to }) => to("on.media.idle") },
      done: ({ to }) => to("on.media.finished"),
    },
    "on.media.player.track.stopped": {
      on: { play: ({ event, to }) => to("on.media.player.track.playing", { title: event.title }) },
    },
    "on.media.player.track.playing": { on: { end: ({ to }) => to("on.media.player.track.done") } },
    "on.media.player.track.done": { final: true },
    "on.media.player.volume.level": { on: { mute: ({ to }) => to("on.media.player.volume.muted") } },
    "on.media.player.volume.muted": { final: true },
    "on.media.finished": { on: { load: ({ to }) => to("on.media.idle") } },
    "on.chat.closed": { on: { chat: ({ to }) => to("on.chat.open") } },
    "on.chat.open": { on: { chat: ({ to }) => to("on.chat.closed") } },
  },
});
