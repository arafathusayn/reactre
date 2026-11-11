// A parallel machine with effects, compiled by the plugin as a build compiles it: "on" has the
// regions "playback" and "volume", each with its own entry and exit effects, and the parallel node
// itself has one. What ran goes in `seen`, so a test can tell the order and that each region's
// effects are its own.

import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";

/** What the effects did, in order. */
export const seen: string[] = [];

const player = setup({
  use: [nested, parallel, effects],
  parallel: ["on"],
  states: {
    off: types<{}>(),
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
  },
});

export const playerMachine = player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      entry: ({ enq }) => enq(() => seen.push("enter off")),
      exit: ({ enq }) => enq(() => seen.push("exit off")),
      on: {
        power: ({ enq, to }) => {
          enq(() => seen.push("power"));
          return to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", { level: 5 }) });
        },
      },
    },
    // The parallel node: its own entry and exit, around its regions'.
    on: {
      entry: ({ enq }) => enq(() => seen.push("enter on")),
      exit: ({ enq }) => enq(() => seen.push("exit on")),
      on: { power: ({ to }) => to("off") },
    },
    "on.playback.stopped": {
      entry: ({ enq }) => enq(() => seen.push("enter stopped")),
      exit: ({ enq }) => enq(() => seen.push("exit stopped")),
      on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) },
    },
    "on.playback.playing": {
      entry: ({ data, enq }) =>
        enq.effect(() => {
          seen.push(`play ${data.track}`);
          return () => seen.push(`stop ${data.track}`);
        }),
      on: { stop: ({ to }) => to("on.playback.stopped") },
    },
    "on.volume.audible": {
      entry: ({ enq }) => enq(() => seen.push("enter audible")),
      exit: ({ enq }) => enq(() => seen.push("exit audible")),
      on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) },
    },
    "on.volume.muted": {
      entry: ({ enq }) => enq(() => seen.push("enter muted")),
      exit: ({ enq }) => enq(() => seen.push("exit muted")),
      on: { unmute: ({ data, to }) => to("on.volume.audible", { level: data.level }) },
    },
  },
});
