// A correct machine, as a user writes it: compiled by the tests (the plugin, in an app).

import { setup, types } from "@reactre/state";

export const fetcherShape = setup({
  version: 1,
  input: types<{ url: string }>(),
  states: {
    idle: types<{ url: string }>(),
    loading: types<{ url: string; attempt: number }>(),
    loaded: types<{ url: string; body: string }>(),
    failed: types<{ url: string; attempt: number; error: string }>(),
    gaveUp: types<{ url: string }>(),
  },
  events: {
    fetch: types<{}>(),
    retry: types<{}>(),
    cancel: types<{}>(),
  },
  internal: {
    received: types<{ body: string }>(),
  },
});

export const fetcher = fetcherShape.machine({
  start: ({ input, to }) => to("idle", { url: input.url }),
  states: {
    idle: {
      on: { fetch: ({ data, to }) => to("loading", { url: data.url, attempt: 1 }) },
    },
    loading: {
      task: {
        run: async ({ data, signal }) => {
          const res = await fetch(data.url, { signal });
          // A 404 or 500 page isn't the body: the task's error decides.
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return { type: "received", body: await res.text() };
        },
        error: ({ data, error, to }) => to("failed", { ...data, error: String(error) }),
      },
      on: {
        received: ({ data, event, to }) => to("loaded", { url: data.url, body: event.body }),
        cancel: ({ data, to }) => to("idle", { url: data.url }),
      },
      after: { "10s": ({ data, to }) => to("failed", { ...data, error: "timed out" }) },
    },
    failed: {
      on: {
        retry: ({ data, to }) =>
          data.attempt < 3
            ? to("loading", { url: data.url, attempt: data.attempt + 1 })
            : to("gaveUp", { url: data.url }),
      },
    },
    loaded: { final: true },
    gaveUp: { final: true },
  },
});
