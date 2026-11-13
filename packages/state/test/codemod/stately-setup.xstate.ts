// @ts-nocheck: below is Stately Studio's "XState v5, TypeScript" export in its `setup` form, as the editor writes it, with its import pointed at the dev dependency; its stubs leave parameters unused, which this repository's settings refuse.
// A traffic light: `setup({ types, actions, actors, guards, delays }).createMachine(...)`, named
// delays, a guard stub returning true, a fromPromise stub, entry and exit by name, and meta.

import { fromPromise, setup } from "./xstate5.ts";

export const machine = setup({
  types: {
    context: {} as { cycles: number },
    events: {} as { type: "timer" } | { type: "emergency" } | { type: "clear" },
  },
  actions: {
    logCycle: function ({ context, event }, params) {
      // Add your action code here
      // ...
    },
    flashLights: function ({ context, event }, params) {
      // Add your action code here
      // ...
    },
  },
  actors: {
    reportOutage: fromPromise(async ({ input }) => {
      // Add your actor code here
      // ...
    }),
  },
  guards: {
    isRushHour: function ({ context, event }, params) {
      // Add your guard condition here
      return true;
    },
  },
  delays: {
    greenTime: ({ context, event }) => {
      return 30;
    },
  },
}).createMachine({
  context: {
    cycles: 0,
  },
  id: "Traffic light",
  initial: "Green",
  states: {
    Green: {
      on: {
        timer: [
          {
            target: "Yellow",
            guard: {
              type: "isRushHour",
            },
          },
          {
            target: "Green",
          },
        ],
        emergency: {
          target: "Flashing",
        },
      },
      after: {
        greenTime: {
          target: "Yellow",
        },
      },
      meta: {
        color: "#00ff00",
      },
    },
    Yellow: {
      on: {
        timer: {
          target: "Red",
        },
        emergency: {
          target: "Flashing",
        },
      },
    },
    Red: {
      on: {
        timer: {
          target: "Green",
          actions: {
            type: "logCycle",
          },
        },
        emergency: {
          target: "Flashing",
        },
      },
    },
    Flashing: {
      invoke: {
        input: {},
        onDone: {
          target: "Reported",
        },
        src: "reportOutage",
      },
      entry: {
        type: "flashLights",
      },
      exit: [
        {
          type: "logCycle",
        },
      ],
    },
    Reported: {
      on: {
        clear: {
          target: "Red",
        },
      },
    },
  },
});
