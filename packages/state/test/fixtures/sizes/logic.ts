// What logic costs an app that uses it: a profile that loads its user with async logic (a timeout,
// and an error handler), run as a node's child.

import { createActor, setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { createAsyncLogic, logic } from "@reactre/state/logic";

const load = createAsyncLogic({
  timeout: "5s",
  run: async ({ input }: { input: { id: string }; signal: AbortSignal }) => ({ name: input.id }),
});

const profile = setup({
  use: [children, logic],
  states: { loading: types<{ id: string }>(), ready: types<{ name: string }>(), failed: types<{}>() },
  events: {},
  children: { load },
});

export const profileMachine = profile.machine({
  start: ({ to }) => to("loading", { id: "u1" }),
  states: {
    loading: {
      children: {
        load: {
          input: ({ data }) => ({ id: data.id }),
          done: ({ output, to }) => to("ready", { name: output.name }),
          error: ({ to }) => to("failed"),
        },
      },
    },
    ready: { final: true },
    failed: { final: true },
  },
});

export function run(): string {
  return createActor(profileMachine).snapshot().state;
}
