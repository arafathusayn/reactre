// Machines with effects, for ./effects.test.ts and the other effects-agent features' tests: the
// preload plugin (../../compiled.ts) compiles them as a build would. What the effects do goes in
// `seen`, so a test can tell what ran, and when.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { delays } from "@reactre/state/delays";
import { effects } from "@reactre/state/effects";
import { emit } from "@reactre/state/emit";
import { nested } from "@reactre/state/nested";
import { persist } from "@reactre/state/persist";
import { provide } from "@reactre/state/provide";
import { timeout } from "@reactre/state/timeout";

/** What the effects did, in order. */
export const seen: string[] = [];

/** An actor outside the machine: `enq.sendTo` sends to it. */
export const outside = {
  send: (event: { readonly type: "ping"; readonly from: string }) => seen.push(`ping ${event.from}`),
};

const door = setup({
  use: [effects],
  states: { closed: types<{}>(), open: types<{ by: string }>(), alarmed: types<{ n: number }>() },
  events: {
    push: types<{ by: string }>(),
    close: types<{}>(),
    arm: types<{}>(),
    wait: types<{}>(),
    disarm: types<{}>(),
    loop: types<{}>(),
  },
  internal: { ring: types<{ n: number }>() },
});

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      entry: ({ enq }) => enq(() => seen.push("enter closed")),
      exit: ({ enq }) => enq(() => seen.push("exit closed")),
      on: {
        push: ({ event, enq, to }) => {
          enq((by: string) => seen.push(`push ${by}`), event.by);
          enq.sendTo(outside, { type: "ping", from: event.by });
          return to("open", { by: event.by });
        },
        // Raised now: handled in the same step, so the actor goes straight to alarmed.
        // The stays are `keep`: closed's entry and exit don't run again (M501).
        arm: ({ enq, keep }) => {
          enq.raise({ type: "ring", n: 1 });
          return keep("closed");
        },
        // Raised later, unless disarm cancels it first. It stays, so a second wait replaces the first.
        wait: ({ enq, keep }) => {
          enq.cancel("later");
          enq.raise({ type: "ring", n: 2 }, { delay: 20, id: "later" });
          return keep("closed");
        },
        disarm: ({ enq, keep }) => {
          enq.cancel("later");
          return keep("closed");
        },
        // A loop through two states, which alarmed's loop closes (one that stays is a build error).
        loop: ({ enq, to }) => {
          enq.raise({ type: "loop" });
          return to("alarmed", { n: 0 });
        },
        ring: ({ event, enq, to }) => {
          enq.log("ring", event.n);
          return to("alarmed", { n: event.n });
        },
      },
    },
    open: {
      // An effect with a cleanup, from entry: it is cleaned up when open exits.
      entry: ({ data, enq }) =>
        enq.effect(() => {
          seen.push(`open by ${data.by}`);
          return () => seen.push(`cleanup ${data.by}`);
        }),
      on: { close: ({ to }) => to("closed") },
    },
    alarmed: {
      on: {
        close: ({ enq, to }) => {
          // An effect with a cleanup, from a handler: it is cleaned up when the actor stops.
          enq.effect(() => () => seen.push("cleanup actor"));
          return to("closed");
        },
        loop: ({ enq, to }) => {
          enq.raise({ type: "loop" });
          return to("closed");
        },
      },
    },
  },
});

const editor = setup({
  use: [nested, effects],
  states: { idle: types<{}>(), "edit.draft": types<{ text: string }>(), "edit.review": types<{ text: string }>() },
  events: { open: types<{}>(), submit: types<{}>(), leave: types<{}>() },
});

export const editorMachine = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      exit: ({ enq }) => enq(() => seen.push("exit idle")),
      on: { open: ({ to }) => to("edit.draft", { text: "" }) },
    },
    edit: {
      entry: ({ state, enq }) => enq(() => seen.push(`enter edit at ${state}`)),
      exit: ({ enq }) => enq(() => seen.push("exit edit")),
      on: { leave: ({ to }) => to("idle") },
    },
    "edit.draft": {
      entry: ({ enq }) => enq(() => seen.push("enter draft")),
      exit: ({ enq }) => enq(() => seen.push("exit draft")),
      on: { submit: ({ data, to }) => to("edit.review", { text: data.text }) },
    },
    "edit.review": { entry: ({ enq }) => enq(() => seen.push("enter review")) },
  },
});

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

const order = setup({
  use: [effects, provide],
  actions: { track: (params: { key: string }) => seen.push(`track ${params.key}`), reset: () => seen.push("reset") },
  guards: { big: (total: number) => total > 100 },
  states: { cart: types<{ total: number }>(), review: types<{ total: number }>() },
  events: { submit: types<{}>(), back: types<{}>() },
});

export const orderMachine = order.machine({
  start: ({ to }) => to("cart", { total: 150 }),
  states: {
    cart: {
      on: {
        submit: ({ data, actions, guards, enq, to }) => {
          if (!guards.big(data.total)) return null;
          enq(actions.track, { key: "big" });
          return to("review", { total: data.total });
        },
      },
    },
    review: {
      entry: ({ actions, enq }) => enq(actions.reset),
      on: { back: ({ data, to }) => to("cart", { total: data.total }) },
    },
  },
});

const tree = setup({
  use: [nested, effects],
  states: { "a.x": types<{}>(), b: types<{}>(), done: types<{}>() },
  events: { go: types<{}>(), end: types<{}>() },
});

/** A leaf that records and declines, under a parent that takes the event: only the parent's effects run. */
export const treeMachine = tree.machine({
  start: ({ to }) => to("a.x"),
  states: {
    a: {
      on: {
        go: ({ enq, to }) => {
          enq(() => seen.push("parent"));
          return to("b");
        },
      },
    },
    "a.x": {
      on: {
        go: ({ enq }) => {
          enq(() => seen.push("leaf"));
          return null;
        },
      },
    },
    b: { on: { end: ({ to }) => to("done") } },
    // A final state's entry runs when the machine ends in it.
    done: { final: true, entry: ({ enq }) => enq(() => seen.push("enter done")) },
  },
});

const bell = setup({
  use: [effects],
  states: { idle: types<{}>(), armed: types<{}>(), ringing: types<{ n: number }>() },
  events: { arm: types<{}>() },
  internal: { ring: types<{ n: number }>() },
});

/** A timer whose handler raises: the raise is handled before the actor's listeners hear of the move. */
export const bellMachine = bell.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { arm: ({ to }) => to("armed") } },
    armed: {
      after: {
        "10ms": ({ enq, keep }) => {
          enq.raise({ type: "ring", n: 1 });
          return keep("armed");
        },
      },
      on: { ring: ({ event, to }) => to("ringing", { n: event.n }) },
    },
    ringing: { on: { arm: ({ to }) => to("armed") } },
  },
});

const kept = setup({
  use: [effects, delays, persist],
  shape: "tmtc6hch",
  delays: { soon: 30 },
  states: { idle: types<{}>(), waiting: types<{}>(), rung: types<{ by: string }>() },
  events: { wait: types<{}>() },
  internal: { ring: types<{ by: string }>() },
});

/** A delayed raise and a named delay's timer, both saved by persist with their deadlines. */
export const keptMachine = kept.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        wait: ({ enq, to }) => {
          enq.raise({ type: "ring", by: "raise" }, { delay: 60 });
          return to("waiting");
        },
      },
    },
    waiting: {
      after: { soon: ({ to }) => to("rung", { by: "timer" }) },
      on: { ring: ({ event, to }) => to("rung", { by: event.by }) },
    },
    rung: { on: { ring: ({ event, to }) => to("rung", { by: `${event.by} after` }) } },
  },
});

const reminder = setup({
  use: [delays, timeout, provide],
  delays: { soon: 40, sla: ({ data }: { data: { ms: number } }) => data.ms },
  states: {
    idle: types<{}>(),
    waiting: types<{ ms: number }>(),
    late: types<{ by: string }>(),
    done: types<{}>(),
  },
  events: { start: types<{ ms: number }>(), answer: types<{}>() },
});

export const reminderMachine = reminder.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: { start: ({ event, to }) => to("waiting", { ms: event.ms }) },
      after: { "PT0.01S": ({ keep }) => keep("idle") },
    },
    waiting: {
      timeout: ({ data }) => data.ms,
      onTimeout: ({ to }) => to("late", { by: "timeout" }),
      after: { sla: ({ to }) => to("late", { by: "sla" }) },
      on: { answer: ({ to }) => to("done") },
    },
    late: { timeout: "soon", onTimeout: ({ to }) => to("done") },
    done: { final: true },
  },
});

const loader = setup({
  use: [effects],
  states: { booting: types<{}>(), ready: types<{}>() },
  events: {},
  internal: { loaded: types<{}>() },
});

/** The start's entry raises: the actor's first move handles it, so it starts in ready. */
export const loaderMachine = loader.machine({
  start: ({ to }) => to("booting"),
  states: {
    booting: { entry: ({ enq }) => enq.raise({ type: "loaded" }), on: { loaded: ({ to }) => to("ready") } },
    ready: { final: true },
  },
});

const echo = setup({
  states: { listening: types<{ heard: string }>() },
  events: { say: types<{ text: string }>() },
});

/** A child that keeps what it was last told. */
export const echoMachine = echo.machine({
  start: ({ to }) => to("listening", { heard: "" }),
  states: { listening: { on: { say: ({ event, to }) => to("listening", { heard: event.text }) } } },
});

const relay = setup({
  use: [children, effects],
  states: { idle: types<{}>(), relaying: types<{}>() },
  events: { open: types<{}>(), say: types<{ text: string }>() },
  children: { echo: echoMachine },
});

/** `enq.sendTo` by a child's name: relaying runs the echo child; idle runs none, so its send is dropped. */
export const relayMachine = relay.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        open: ({ to }) => to("relaying"),
        say: ({ event, enq, to }) => {
          enq.sendTo("echo", { type: "say", text: event.text });
          return to("idle");
        },
      },
    },
    relaying: {
      children: { echo: {} },
      on: {
        say: ({ event, enq, to }) => {
          enq.sendTo("echo", { type: "say", text: event.text });
          return to("relaying");
        },
      },
    },
  },
});
