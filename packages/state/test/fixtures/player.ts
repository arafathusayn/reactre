// Machines with parallel nodes: "on" has the regions "playback" and "volume", each in a leaf at
// once; "paying" has regions that end, and its `done` decides where to go when both have.

import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";

const player = setup({
  use: [nested, parallel],
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
      on: {
        power: ({ to }) =>
          to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", { level: 5 }) }),
      },
    },
    // The parallel node: an event no region takes comes here.
    on: { on: { power: ({ to }) => to("off") } },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { on: { stop: ({ to }) => to("on.playback.stopped") } },
    "on.volume.audible": { on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) } },
    "on.volume.muted": { on: { unmute: ({ data, to }) => to("on.volume.audible", { level: data.level }) } },
  },
});

const checkout = setup({
  use: [nested, parallel],
  parallel: ["paying"],
  states: {
    cart: types<{ items: number }>(),
    "paying.card.entering": types<{}>(),
    "paying.card.ok": types<{ last4: string }>(),
    "paying.address.entering": types<{}>(),
    "paying.address.ok": types<{ city: string }>(),
    paid: types<{ last4: string; city: string }>(),
  },
  events: {
    pay: types<{}>(),
    card: types<{ last4: string }>(),
    address: types<{ city: string }>(),
    cancel: types<{}>(),
  },
});

export const checkoutMachine = checkout.machine({
  start: ({ to }) => to("cart", { items: 1 }),
  states: {
    cart: {
      on: {
        pay: ({ to }) => to("paying", { card: to("paying.card.entering"), address: to("paying.address.entering") }),
      },
    },
    paying: {
      on: { cancel: ({ to }) => to("cart", { items: 0 }) },
      // Every region is in a final leaf: `data` is the regions, narrowed by each one's state.
      done: ({ data, to }) =>
        to("paid", {
          last4: data.card.state === "paying.card.ok" ? data.card.data.last4 : "",
          city: data.address.state === "paying.address.ok" ? data.address.data.city : "",
        }),
    },
    "paying.card.entering": { on: { card: ({ event, to }) => to("paying.card.ok", { last4: event.last4 }) } },
    "paying.card.ok": { final: true },
    "paying.address.entering": { on: { address: ({ event, to }) => to("paying.address.ok", { city: event.city }) } },
    "paying.address.ok": { final: true },
    paid: { final: true },
  },
});
