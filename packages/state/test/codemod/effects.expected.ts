// A music player in XState v5 with effects: entry and exit, named actions (one with params, one
// that reads the context after an assign), an inline action, raise now and later, cancel, log,
// emit, and enqueueActions with a check.

import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { emit } from "@reactre/state/emit";
import { provide } from "@reactre/state/provide";

/** What the effects did, in order. */
export const seen: string[] = [];

const player = setup({
  use: [effects, provide, emit],
  actions: {
    note: (params: { name: string }) => {
      seen.push(`note ${params.name}`);
    },
  },
  emitted: { played: types<{ track: string }>() },
  states: {
    stopped: types<{ track: string; plays: number }>(),
    playing: types<{ track: string; plays: number }>(),
    paused: types<{ track: string; plays: number }>(),
  },
  events: {
    play: types<{ track: string }>(),
    pause: types<{}>(),
    resume: types<{}>(),
    stop: types<{}>(),
    snooze: types<{}>(),
    wake: types<{}>(),
    ended: types<{}>(),
  },
});

export const playerMachine = player.machine({
  start: ({ to }) => to("stopped", { track: "", plays: 0 }),
  states: {
    stopped: {
      entry: ({ actions, enq }) => (enq.log("stopped"), enq(actions.note, { name: "stopped" })),
      on: {
        play: ({ data, event, enq, to }) => (
          enq(() => {
            seen.push(`now playing ${event.track}`);
          }),
          enq.emit({ type: "played", track: event.track }),
          to("playing", { track: event.track, plays: data.plays + 1 })
        ),
        ended: ({ data, enq, keep }) => (enq.log("ended"), keep("stopped", data)),
      },
    },
    playing: {
      entry: ({ enq }) =>
        enq(() => {
          seen.push("enter playing");
        }),
      on: {
        pause: ({ data, to }) => to("paused", data),
        stop: ({ data, enq, to }) => (enq.raise({ type: "ended" }), to("stopped", data)),
        snooze: ({ data, enq, to }) => (enq.raise({ type: "wake" }, { delay: 20, id: "alarm" }), to("paused", data)),
      },
      exit: ({ actions, enq }) => enq(actions.note, { name: "left playing" }),
    },
    paused: {
      on: {
        resume: ({ data, to }) => to("playing", data),
        wake: ({ data, to }) => to("playing", data),
        stop: ({ data, actions, enq, to }) => (
          enq.cancel("alarm"),
          data.plays > 1 ? enq(actions.note, { name: "replayed" }) : enq.log("first play"),
          to("stopped", data)
        ),
      },
    },
  },
});
