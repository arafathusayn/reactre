// A music player in XState v5 with effects: entry and exit, named actions (one with params, one
// that reads the context after an assign), an inline action, raise now and later, cancel, log,
// emit, and enqueueActions with a check.

import { assign, cancel, emit, enqueueActions, log, raise, setup } from "./xstate5.ts";

/** What the effects did, in order. */
export const seen: string[] = [];

export const playerMachine = setup({
  types: {} as {
    context: { track: string; plays: number };
    events:
      | { type: "play"; track: string }
      | { type: "pause" }
      | { type: "resume" }
      | { type: "stop" }
      | { type: "snooze" }
      | { type: "wake" }
      | { type: "ended" };
  },
  actions: {
    note: (_, params: { name: string }) => {
      seen.push(`note ${params.name}`);
    },
    announce: ({ context }) => {
      seen.push(`now playing ${context.track}`);
    },
  },
}).createMachine({
  context: { track: "", plays: 0 },
  initial: "stopped",
  states: {
    stopped: {
      entry: [log("stopped"), { type: "note", params: { name: "stopped" } }],
      on: {
        play: {
          target: "playing",
          actions: [
            assign({ track: ({ event }) => event.track, plays: ({ context }) => context.plays + 1 }),
            "announce",
            emit(({ event }) => ({ type: "played", track: event.track })),
          ],
        },
        ended: { actions: log("ended") },
      },
    },
    playing: {
      entry: () => {
        seen.push("enter playing");
      },
      exit: { type: "note", params: { name: "left playing" } },
      on: {
        pause: "paused",
        stop: { target: "stopped", actions: raise({ type: "ended" }) },
        snooze: { target: "paused", actions: raise({ type: "wake" }, { delay: 20, id: "alarm" }) },
      },
    },
    paused: {
      on: {
        resume: "playing",
        wake: "playing",
        stop: {
          target: "stopped",
          actions: [
            cancel("alarm"),
            enqueueActions(({ enqueue, check }) => {
              if (check(({ context }) => context.plays > 1)) enqueue({ type: "note", params: { name: "replayed" } });
              else enqueue(log("first play"));
            }),
          ],
        },
      },
    },
  },
});
