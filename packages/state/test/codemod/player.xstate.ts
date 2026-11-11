// A media player in XState v6: a parallel state whose regions each hold their own part of the
// context, and a transition on the parallel state itself.

import { setup, types } from "xstate6";

export const playerMachine = setup({
  schemas: {
    context: types<{ track: string | null; level: number }>(),
    events: {
      power: types<{}>(),
      play: types<{ track: string }>(),
      stop: types<{}>(),
      mute: types<{}>(),
      unmute: types<{}>(),
      louder: types<{}>(),
    },
  },
}).createMachine({
  context: { track: null, level: 5 },
  initial: "off",
  states: {
    off: { on: { power: { target: "on" } } },
    on: {
      type: "parallel",
      on: { power: { target: "off" } },
      states: {
        playback: {
          initial: "stopped",
          states: {
            stopped: { on: { play: ({ event }) => ({ target: "playing", context: { track: event.track } }) } },
            playing: { on: { stop: { target: "stopped" } } },
          },
        },
        volume: {
          initial: "audible",
          states: {
            audible: {
              on: { mute: { target: "muted" }, louder: ({ context }) => ({ context: { level: context.level + 1 } }) },
            },
            muted: { on: { unmute: { target: "audible" } } },
          },
        },
      },
    },
  },
});
