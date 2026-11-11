// A machine whose retry re-enters its state, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { reenter } from "@reactre/state/reenter";

const fetcher = setup({
  use: [reenter],
  states: { loading: types<{ attempt: number }>(), timedOut: types<{ attempt: number }>() },
  events: { retry: types<{}>(), nudge: types<{}>() },
});

export const fetcherMachine = fetcher.machine({
  start: ({ to }) => to("loading", { attempt: 1 }),
  states: {
    loading: {
      // 30ms in "loading": a retry restarts the timer, a nudge (keep, to the same leaf) doesn't.
      after: { "30ms": ({ data, to }) => to("timedOut", { attempt: data.attempt }) },
      on: {
        retry: ({ data, reenter }) => reenter("loading", { attempt: data.attempt + 1 }),
        nudge: ({ data, keep }) => keep("loading", { attempt: data.attempt }),
      },
    },
    timedOut: { final: true },
  },
});
