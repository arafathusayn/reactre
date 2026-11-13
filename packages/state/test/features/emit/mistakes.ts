// emit's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in cases first.

import { createActor, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { emit, on, trigger } from "@reactre/state/emit";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

// @ts-expect-error The opt-in: setup's emitted without emit in use names the import.
setup({ use: [effects], emitted: { played: types<{}>() }, states: { idle: types<{}>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof effects];
      emitted: { played: Type<{}> };
      states: { idle: Type<{}> };
      events: {};
    }>,
    `setup has "emitted": add emit to setup's use (import { emit } from "@reactre/state/emit")`
  >
>();

// @ts-expect-error emit needs effects: it records an effect.
setup({ use: [emit], states: { idle: types<{}>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{ use: readonly [typeof emit]; states: { idle: Type<{}> }; events: {} }>,
    `emit needs effects: add effects to setup's use (import { effects } from "@reactre/state/effects")`
  >
>();

const quiet = setup({
  use: [effects],
  states: { paused: types<{}>(), playing: types<{ track: string }>() },
  events: { play: types<{ track: string }>(), pause: types<{}>() },
});
const quietMachine = quiet.machine({
  start: ({ to }) => to("paused"),
  states: {
    paused: {
      on: {
        play: ({ event, enq, to }) => {
          // @ts-expect-error The opt-in: enq.emit without emit in use is a function whose parameter is the fix.
          enq.emit({ type: "played", track: event.track });
          return to("playing", { track: event.track });
        },
      },
    },
    playing: { on: { pause: ({ to }) => to("paused") } },
  },
});
// @ts-expect-error The opt-in: on(actor, ...) on a machine without emit names the import.
on(createActor(quietMachine), "played", () => {});

const player = setup({
  use: [effects, emit],
  emitted: { played: types<{ track: string }>(), stopped: types<{}>() },
  states: { paused: types<{}>(), playing: types<{ track: string }>() },
  events: { play: types<{ track: string }>(), pause: types<{}>() },
});

// The correct machine, and its listeners.
export const playerOk = player.machine({
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
const actor = createActor(playerOk);
on(actor, "played", (event) => event.track.toUpperCase());
on(actor, "*", (event) => (event.type === "played" ? event.track : event.type));
trigger(actor).play({ track: "a" });
trigger(actor).pause();

player.machine({
  start: ({ to }) => to("paused"),
  states: {
    paused: {
      on: {
        play: ({ event, enq, to }) => {
          // @ts-expect-error An emitted event setup's emitted doesn't declare.
          enq.emit({ type: "skipped" });
          // @ts-expect-error An emitted event without its payload.
          enq.emit({ type: "played" });
          return to("playing", { track: event.track });
        },
      },
    },
    playing: { on: { pause: ({ to }) => to("paused") } },
  },
});

// @ts-expect-error A listener for an event the machine doesn't emit.
on(actor, "skipped", () => {});
// @ts-expect-error A listener reading a field its event doesn't have.
on(actor, "stopped", (event) => event.track);
// @ts-expect-error trigger: an event the machine doesn't take.
trigger(actor).stop();
// @ts-expect-error trigger: an event without its payload.
trigger(actor).play();

// @ts-expect-error An emitted event with a field named type.
setup({ use: [effects, emit], emitted: { x: types<{ type: string }>() }, states: { idle: types<{}>() }, events: {} });
