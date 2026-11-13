import { setup, types } from "@reactre/state";
import { reenter } from "@reactre/state/reenter";

const request = setup({
  use: [reenter],
  states: {
    idle: types<{}>(),
    loading: types<{ url: string }>(),
    ready: types<{ url: string; text: string }>(),
    failed: types<{ url: string; message: string }>(),
  },
  events: { load: types<{ url: string }>(), cancel: types<{}>(), retry: types<{}>(), clear: types<{}>() },
  internal: { resolved: types<{ text: string }>() },
});

// Define the machine once. Each actor owns its own request and cancellation lifetime.
export const requestMachine = request.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { load: ({ event, to }) => to("loading", { url: event.url }) } },
    loading: {
      task: {
        run: async ({ data, signal }) => {
          const response = await fetch(data.url, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return { type: "resolved", text: await response.text() };
        },
        error: ({ data, error, to }) => to("failed", { url: data.url, message: String(error) }),
      },
      on: {
        load: ({ event, reenter }) => reenter("loading", { url: event.url }),
        cancel: ({ to }) => to("idle"),
        resolved: ({ data, event, to }) => to("ready", { url: data.url, text: event.text }),
      },
    },
    ready: {
      on: {
        load: ({ event, to }) => to("loading", { url: event.url }),
        clear: ({ to }) => to("idle"),
      },
    },
    failed: {
      on: {
        retry: ({ data, to }) => to("loading", { url: data.url }),
        load: ({ event, to }) => to("loading", { url: event.url }),
        clear: ({ to }) => to("idle"),
      },
    },
  },
});
