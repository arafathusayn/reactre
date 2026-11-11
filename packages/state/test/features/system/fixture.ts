// A system of machines, compiled as a build compiles them (../../compiled.ts registers the plugin):
// an order whose `paying` node runs a payment child (registered as "payment"), with timers in both.

import { setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";
import { children } from "@reactre/state/children";
import { system } from "@reactre/state/system";

const payment = setup({
  input: types<{ amount: number }>(),
  states: { pending: types<{ amount: number }>(), paid: types<{ amount: number }>(), declined: types<{}>() },
  events: { approve: types<{}>(), decline: types<{}>() },
  internal: { charged: types<{ id: string }>() },
});
export const paymentMachine = payment.machine({
  start: ({ input, to }) => to("pending", { amount: input.amount }),
  states: {
    pending: {
      task: {
        run: async ({ data }) => ({ type: "charged", id: `ch_${data.amount}` }),
        error: ({ to }) => to("declined"),
      },
      on: {
        approve: ({ data, to }) => to("paid", { amount: data.amount }),
        decline: ({ to }) => to("declined"),
        charged: ({ data, to }) => to("paid", { amount: data.amount }),
      },
      after: { "3s": ({ to }) => to("declined") },
    },
    paid: { final: true },
    declined: { final: true },
  },
});

const order = setup({
  use: [children, system],
  states: {
    cart: types<{ total: number }>(),
    paying: types<{ total: number; seen: string }>(),
    placed: types<{ total: number }>(),
    cancelled: types<{}>(),
  },
  events: { checkout: types<{}>(), cancel: types<{}>() },
  children: { payment: paymentMachine },
});
export const orderMachine = order.machine({
  start: ({ to }) => to("cart", { total: 10 }),
  states: {
    cart: { on: { checkout: ({ data, to }) => to("paying", { total: data.total, seen: "" }) } },
    paying: {
      children: {
        payment: {
          registryKey: "payment",
          input: ({ data }) => ({ amount: data.total }),
          done: ({ data, output, to }) =>
            output.state === "paid" ? to("placed", { total: data.total }) : to("cancelled"),
          update: ({ data, child, keep }) => keep("paying", { ...data, seen: child.state }),
        },
      },
      on: { cancel: ({ to }) => to("cancelled") },
      after: { "5s": ({ to }) => to("cancelled") },
    },
    placed: { final: true },
    cancelled: { final: true },
  },
});

const transfer = setup({
  input: types<{ file: string }>(),
  states: { sending: types<{ file: string; pct: number }>(), sent: types<{ file: string }>() },
  events: { progress: types<{ pct: number }>(), finish: types<{}>() },
});
export const transferMachine = transfer.machine({
  start: ({ input, to }) => to("sending", { file: input.file, pct: 0 }),
  states: {
    sending: {
      on: {
        progress: ({ data, event, to }) => to("sending", { file: data.file, pct: event.pct }),
        finish: ({ data, to }) => to("sent", { file: data.file }),
      },
    },
    sent: { final: true },
  },
});

const batch = setup({
  use: [children, system],
  states: { sending: types<{ files: string[]; pct: number }>() },
  events: { add: types<{ file: string }>() },
  children: { transfer: transferMachine },
});
/** A keyed child per file: `add` starts one, a transfer's move updates the batch, its end drops its file. */
export const batchMachine = batch.machine({
  start: ({ to }) => to("sending", { files: ["a"], pct: 0 }),
  states: {
    sending: {
      children: {
        transfer: {
          each: ({ data }) => data.files.map((file) => ({ key: file, input: { file } })),
          update: ({ data, child, to }) =>
            to("sending", { files: data.files, pct: child.state === "sending" ? child.data.pct : data.pct }),
          done: ({ data, output, to }) =>
            to("sending", { files: data.files.filter((f) => f !== output.data.file), pct: data.pct }),
        },
      },
      on: { add: ({ data, event, to }) => to("sending", { files: [...data.files, event.file], pct: data.pct }) },
    },
  },
});

// It ends as it starts: its start state moves on at once (M435: a machine doesn't start final).
const instant = setup({ use: [always], states: { starting: types<{}>(), over: types<{}>() }, events: {} });
export const instantMachine = instant.machine({
  start: ({ to }) => to("starting"),
  states: { starting: { always: ({ to }) => to("over") }, over: { final: true } },
});

const pingPong = setup({
  use: [children, system],
  states: { ping: types<{}>(), pong: types<{}>() },
  events: {},
  children: { instant: instantMachine },
});
/** A loop with no end: each node's child ends as it starts, and its done goes to the other node. */
export const pingPongMachine = pingPong.machine({
  start: ({ to }) => to("ping"),
  states: {
    ping: { children: { instant: { done: ({ to }) => to("pong") } } },
    pong: { children: { instant: { done: ({ to }) => to("ping") } } },
  },
});

const blinker = setup({
  use: [system],
  states: { on: types<{}>(), off: types<{}>() },
  events: {},
});
/** A light that blinks each second, for ever. */
export const blinkerMachine = blinker.machine({
  start: ({ to }) => to("on"),
  states: {
    on: { after: { "1s": ({ to }) => to("off") } },
    off: { after: { "1s": ({ to }) => to("on") } },
  },
});
