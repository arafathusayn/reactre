// What emit costs an app that uses it (with effects, which it needs): a player that emits, heard
// through `on` for one type and for all.

import { createActor, setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { emit, on } from "@reactre/state/emit";

const player = setup({
  use: [effects, emit],
  emitted: { played: types<{ track: string }>(), stopped: types<{}>() },
  states: { paused: types<{}>(), playing: types<{ track: string }>() },
  events: { play: types<{ track: string }>(), pause: types<{}>() },
});

export const playerMachine = player.machine({
  start: ({ to }) => to("paused"),
  states: {
    paused: {
      on: {
        play: ({ event, enq, to }) => {
          enq.emit({ type: "played", track: event.track });
          return to("playing", { track: event.track });
        },
      },
    },
    playing: { exit: ({ enq }) => enq.emit({ type: "stopped" }), on: { pause: ({ to }) => to("paused") } },
  },
});

export function run(): string[] {
  const actor = createActor(playerMachine);
  const heard: string[] = [];
  on(actor, "played", (event) => heard.push(event.track));
  on(actor, "*", (event) => heard.push(event.type));
  actor.send({ type: "play", track: "a" });
  actor.send({ type: "pause" });
  actor.stop();
  return heard;
}
