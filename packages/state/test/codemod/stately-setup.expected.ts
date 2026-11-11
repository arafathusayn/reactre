// A traffic light: `setup({ types, actions, actors, guards, delays }).createMachine(...)`, named
// delays, a guard stub returning true, a fromPromise stub, entry and exit by name, and meta.

import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { provide } from "@reactre/state/provide";
import { tags } from "@reactre/state/tags";

// TODO(@reactre/state): guard "isRushHour" is a stub in the export: write its condition in isRushHour, and pass it the fields of data and the event it reads. Until then it is true, as in the export
function isRushHour(): boolean {
  return true;
}

// TODO(@reactre/state): actor "reportOutage" is a stub in the export: write the task in reportOutage (it gets the invoke's input and an abort signal). Until then it finishes at once (its output is null), as in the export
async function reportOutage(_: { input?: unknown; signal: AbortSignal }): Promise<null> {
  return null;
}

const machineShape = setup({
  use: [effects, provide, tags],
  actions: {
    // TODO(@reactre/state): action "logCycle" is a stub in the export: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing, as in the export
    logCycle: () => {},
    // TODO(@reactre/state): action "flashLights" is a stub in the export: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing, as in the export
    flashLights: () => {},
  },
  states: {
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isRushHour, reportOutage) aren't written yet, so the fields each state reads aren't known
    Green: types<{ cycles: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isRushHour, reportOutage) aren't written yet, so the fields each state reads aren't known
    Yellow: types<{ cycles: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isRushHour, reportOutage) aren't written yet, so the fields each state reads aren't known
    Red: types<{ cycles: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isRushHour, reportOutage) aren't written yet, so the fields each state reads aren't known
    Flashing: types<{ cycles: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isRushHour, reportOutage) aren't written yet, so the fields each state reads aren't known
    Reported: types<{ cycles: number }>(),
  },
  events: { timer: types<{}>(), emergency: types<{}>(), clear: types<{}>() },
  internal: { reportOutageDone: types<{ output: Awaited<ReturnType<typeof reportOutage>> }>() },
});

export const machine = machineShape.machine({
  start: ({ to }) => to("Green", { cycles: 0 }),
  states: {
    Green: {
      meta: {
        color: "#00ff00",
      },
      on: {
        timer: ({ data, to, keep }) => (isRushHour() ? to("Yellow", data) : keep("Green", data)),
        emergency: ({ data, to }) => to("Flashing", data),
      },
      after: { "30ms": ({ data, to }) => to("Yellow", data) },
    },
    Yellow: { on: { timer: ({ data, to }) => to("Red", data), emergency: ({ data, to }) => to("Flashing", data) } },
    Red: {
      on: {
        timer: ({ data, actions, enq, to }) => (enq(actions.logCycle), to("Green", data)),
        emergency: ({ data, to }) => to("Flashing", data),
      },
    },
    Flashing: {
      entry: ({ actions, enq }) => enq(actions.flashLights),
      on: { reportOutageDone: ({ data, to }) => to("Reported", data) },
      // TODO(@reactre/state): XState's actor errored when reportOutage failed: say where to go
      task: {
        run: async ({ signal }) => ({ type: "reportOutageDone", output: await reportOutage({ input: {}, signal }) }),
        error: ({ data, keep }) => keep("Flashing", data),
      },
      exit: ({ actions, enq }) => enq(actions.logCycle),
    },
    Reported: { on: { clear: ({ data, to }) => to("Red", data) } },
  },
});
