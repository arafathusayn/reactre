// parallel's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. Cases 47–52, and the opt-in, 59.

import { createActor, type MachineError, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

// @ts-expect-error 59. setup's parallel without parallel in use: the error names the import.
setup({ use: [nested], parallel: ["on"], states: { off: types<{}>(), "on.a.x": types<{}>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof nested];
      parallel: readonly ["on"];
      states: { off: Type<{}>; "on.a.x": Type<{}> };
      events: {};
    }>,
    `setup has "parallel": add parallel to setup's use (import { parallel } from "@reactre/state/parallel")`
  >
>();
// 59. parallel needs nested: its regions are parents.
expect<
  Equal<
    keyof ShapeCheck<{ use: readonly [typeof parallel]; states: { off: Type<{}> }; events: {} }>,
    `parallel needs nested: add nested to setup's use (import { nested } from "@reactre/state/nested")`
  >
>();

// "on" has the regions "playback" and "volume".
const player = setup({
  use: [nested, parallel, history],
  parallel: ["on"],
  states: {
    off: types<{}>(),
    "on.playback.stopped": types<{}>(),
    "on.playback.playing": types<{ track: string }>(),
    "on.volume.audible": types<{ level: number }>(),
    "on.volume.muted": types<{ level: number }>(),
  },
  events: { power: types<{}>(), play: types<{ track: string }>(), stop: types<{}>(), mute: types<{}>() },
});

const outside = player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: {
        power: ({ to }) => to("on.playback.stopped"),
        // @ts-expect-error 47. Entering a parallel node without a step for each region.
        play: ({ to }) => to("on", { playback: to("on.playback.stopped") }),
        // @ts-expect-error 48. back to a region: go back to the parallel node, which keeps all regions.
        stop: ({ back, to }) => back("on.playback", to("off")),
      },
    },
    on: { on: { power: ({ to }) => to("off") } },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { on: { stop: ({ to }) => to("on.playback.stopped") } },
    "on.volume.audible": { on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) } },
    "on.volume.muted": { on: { mute: ({ data, to }) => to("on.volume.audible", { level: data.level }) } },
  },
});
expect<
  Equal<
    typeof outside,
    MachineError<'state "off" goes to "on.playback.stopped", inside parallel node "on": enter "on" with to("on", { [region]: to(leaf, data), ... }), a step for each region'>
  >
>();
// @ts-expect-error 49. A region's leaf targeted from outside its parallel node.
createActor(outside);

const endless = player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: {
        power: ({ to }) =>
          to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", { level: 1 }) }),
      },
    },
    on: { on: { power: ({ to }) => to("off"), stop: ({ to }) => to("off") }, done: ({ to }) => to("off") },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { final: true },
    "on.volume.audible": { on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) } },
    "on.volume.muted": { on: { mute: ({ data, to }) => to("on.volume.audible", { level: data.level }) } },
  },
});
expect<
  Equal<
    typeof endless,
    MachineError<'parallel node "on" has done, but its region "volume" has no final state: mark a leaf in it { final: true }, or remove done'>
  >
>();
// @ts-expect-error 50. A done for a parallel node one of whose regions never ends.
createActor(endless);

const undone = player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: {
        power: ({ to }) =>
          to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", { level: 1 }) }),
      },
    },
    on: { on: { power: ({ to }) => to("off"), stop: ({ to }) => to("off") } },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { final: true },
    "on.volume.audible": { on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) } },
    "on.volume.muted": { final: true },
  },
});
expect<
  Equal<
    typeof undone,
    MachineError<'parallel node "on" ends when every region is in a final state, and has no done: add done: ({ data, to }) => to(...)'>
  >
>();
// @ts-expect-error 51. A parallel node whose regions all end, with no done.
createActor(undone);

// @ts-expect-error 52. A parallel node with no regions, a leaf directly under one, and one inside another's region.
setup({
  use: [nested, parallel],
  parallel: ["on", "x", "on.a"],
  states: { "on.y": types<{}>(), "on.a.b.c": types<{}>() },
  events: {},
});
// 52, the third: a parallel node that is itself a region: the fix puts it inside one.
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof nested, typeof parallel];
      parallel: readonly ["on", "on.a"];
      states: { "on.a.b.c": Type<{}>; "on.a.d.e": Type<{}> };
      events: {};
    }>,
    `parallel node "on.a" is a region of another parallel node: put it inside a region, "<outer>.<region>.<node>", or make its regions the outer node's`
  >
>();

// A parallel node inside another's region is correct: the region's unit is that node, entered with
// a step for each of its regions, and its data is theirs.
const studio = setup({
  use: [nested, parallel],
  parallel: ["on", "on.media.player"],
  states: {
    off: types<{}>(),
    "on.media.player.track.stopped": types<{}>(),
    "on.media.player.volume.level": types<{ level: number }>(),
    "on.media.idle": types<{}>(),
    "on.chat.open": types<{}>(),
  },
  events: { power: types<{}>(), load: types<{}>(), eject: types<{}>() },
});
export const studioOk = studio.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: { power: ({ to }) => to("on", { media: to("on.media.idle"), chat: to("on.chat.open") }) },
    },
    on: { on: { power: ({ to }) => to("off") } },
    "on.media.idle": {
      on: {
        load: ({ to }) =>
          to("on.media.player", {
            track: to("on.media.player.track.stopped"),
            volume: to("on.media.player.volume.level", { level: 1 }),
          }),
      },
    },
    "on.media.player": { on: { eject: ({ to }) => to("on.media.idle") } },
    "on.media.player.track.stopped": {},
    "on.media.player.volume.level": {},
    "on.chat.open": {},
  },
});
const studioActor = createActor(studioOk);
const s = studioActor.snapshot();
if (s.state === "on") {
  const media = s.data.media;
  if (media.state === "on.media.player") {
    const level: number = media.data.volume.data.level;
    void level;
  }
}
studio.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: {
        power: ({ to }) =>
          to("on", {
            // @ts-expect-error A nested parallel node entered without a step for each of its regions.
            media: to("on.media.player", { track: to("on.media.player.track.stopped") }),
            chat: to("on.chat.open"),
          }),
      },
    },
    on: { on: { power: ({ to }) => to("off") } },
    "on.media.idle": {},
    "on.media.player": { on: { eject: ({ to }) => to("on.media.idle") } },
    "on.media.player.track.stopped": {},
    "on.media.player.volume.level": {},
    "on.chat.open": {},
  },
});

// The catalog's rows (../../../compare/MISTAKES.md), by their M#.
player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: {
        power: ({ to }) =>
          to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", { level: 1 }) }),
      },
    },
    on: {
      on: { power: ({ to }) => to("off"), stop: ({ to }) => to("off") },
      // @ts-expect-error M183. A parallel node's done reading its data flat: it is per region, data.playback.
      done: ({ data, to }) => (data.track === "" ? to("off") : to("off")),
    },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { final: true },
    "on.volume.audible": { on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) } },
    "on.volume.muted": { final: true },
  },
});

// The second round's rows, by their M#.
const contested = player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: {
      on: {
        power: ({ to }) =>
          to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", { level: 1 }) }),
      },
    },
    on: { on: { power: ({ to }) => to("off") } },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { on: { stop: ({ to }) => to("off") } },
    "on.volume.audible": { on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) } },
    "on.volume.muted": {
      on: {
        mute: ({ data, to }) => to("on.volume.audible", { level: data.level }),
        stop: ({ data, keep }) => keep("on.volume.muted", data),
      },
    },
  },
});
expect<
  Equal<
    typeof contested,
    MachineError<`"stop" leaves parallel node "on" from one region and is handled in another: handle it on the node`>
  >
>();
// @ts-expect-error M522. One event, two regions' handlers: one leaves the node, the other's is lost.
createActor(contested);
