import { setup, types } from "@reactre/state";
import { persist } from "@reactre/state/persist";

import type { Catalog } from "../data.types.ts";

const catalog = setup({
  use: [persist],
  version: 1,
  shape: "su7ou0wj",
  input: types<{ value: Catalog }>(),
  states: { ready: types<{ value: Catalog }>(), closed: types<{}>() },
  events: { replace: types<{ value: Catalog }>(), close: types<{}>() },
});
export const catalogMachine = catalog.machine({
  start: ({ input, to }) => to("ready", { value: input.value }),
  states: {
    ready: {
      on: {
        replace: ({ event, to }) => to("ready", { value: event.value }),
        close: ({ to }) => to("closed"),
      },
    },
    closed: { final: true },
  },
});
