// The four canonical flows of plans/state/AUTHORING.md, written with the current API only: no
// builder, no helper, no new runtime. Each is the minimal code the requirements need, and each is
// compiled by the preload plugin (../compiled.ts) as a build would compile it.
//
//   1. typeahead: a query's request is cancelled when the next query arrives (reenter restarts the
//      task, whose signal aborts the old fetch), and a late result is dropped by the data check.
//   2. fetch with retry: a non-2xx status is a failure (the task's error decides), and retry
//      re-enters loading with the attempt counted, up to a limit.
//   3. polling: a timer re-arms itself by re-entering the state, so each poll restarts the wait.
//   4. debounced submit: each keystroke re-enters the state, restarting its timer; only a pause
//      submits, and a failed submit returns to typing with the text kept.

import { setup, types } from "@reactre/state";
import { reenter } from "@reactre/state/reenter";

// #region 1. typeahead

const search = setup({
  use: [reenter],
  states: {
    idle: types<{}>(),
    searching: types<{ q: string }>(),
    results: types<{ q: string; items: string[] }>(),
    failed: types<{ q: string; error: string }>(),
  },
  events: { query: types<{ q: string }>() },
  internal: { found: types<{ q: string; items: string[] }>() },
});

export const searchMachine = search.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { query: ({ event, to }) => to("searching", { q: event.q }) } },
    searching: {
      task: {
        run: async ({ data, signal }) => {
          const res = await fetch(`/api/search?q=${encodeURIComponent(data.q)}`, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body: unknown = await res.json();
          if (!Array.isArray(body) || !body.every((item) => typeof item === "string"))
            throw new Error("the search response isn't a list of strings");
          return { type: "found", q: data.q, items: body };
        },
        error: ({ data, error, to }) => to("failed", { q: data.q, error: String(error) }),
      },
      on: {
        // The next query restarts the task: its signal aborts the request in flight.
        query: ({ event, reenter }) => reenter("searching", { q: event.q }),
        // A result for a query the state no longer holds is declined, not shown.
        found: ({ data, event, to }) => (event.q === data.q ? to("results", { q: event.q, items: event.items }) : null),
      },
    },
    results: { on: { query: ({ event, to }) => to("searching", { q: event.q }) } },
    failed: { on: { query: ({ event, to }) => to("searching", { q: event.q }) } },
  },
});

// #endregion

// #region 2. fetch with retry

const fetcher = setup({
  version: 1,
  input: types<{ url: string }>(),
  states: {
    idle: types<{ url: string }>(),
    loading: types<{ url: string; attempt: number }>(),
    loaded: types<{ url: string; body: string }>(),
    failed: types<{ url: string; attempt: number; error: string }>(),
    gaveUp: types<{ url: string }>(),
  },
  events: { fetch: types<{}>(), retry: types<{}>(), cancel: types<{}>() },
  internal: { received: types<{ body: string }>() },
});

export const fetcherMachine = fetcher.machine({
  start: ({ input, to }) => to("idle", { url: input.url }),
  states: {
    idle: { on: { fetch: ({ data, to }) => to("loading", { url: data.url, attempt: 1 }) } },
    loading: {
      task: {
        run: async ({ data, signal }) => {
          const res = await fetch(data.url, { signal });
          // A 404 or 500 page is a failure: the task's error decides, not the body.
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

// #endregion

// #region 3. polling

const poll = setup({
  use: [reenter],
  states: { polling: types<{ n: number }>(), done: types<{}>() },
  events: { stop: types<{}>() },
});

export const pollMachine = poll.machine({
  start: ({ to }) => to("polling", { n: 0 }),
  states: {
    polling: {
      // Re-entering restarts the timer: each poll waits the interval again, from its own entry.
      after: { "10ms": ({ data, reenter }) => reenter("polling", { n: data.n + 1 }) },
      on: { stop: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});

// #endregion

// #region 4. debounced submit

const form = setup({
  use: [reenter],
  states: { typing: types<{ text: string }>(), submitting: types<{ text: string }>(), sent: types<{}>() },
  // `cancel` is not optional: a state that runs a task needs a public event or timer that leaves it
  // (the type checker says so), so a submit in flight can be abandoned.
  events: { type: types<{ text: string }>(), cancel: types<{}>() },
  internal: { submit: types<{}>() },
});

export const formMachine = form.machine({
  start: ({ to }) => to("typing", { text: "" }),
  states: {
    typing: {
      // Each keystroke restarts the wait: only a pause of 300ms submits.
      on: { type: ({ event, reenter }) => reenter("typing", { text: event.text }) },
      after: { "300ms": ({ data, to }) => to("submitting", { text: data.text }) },
    },
    submitting: {
      task: {
        run: async ({ data, signal }) => {
          const res = await fetch("/api/save", { method: "POST", body: data.text, signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return { type: "submit" };
        },
        // A failed submit goes back to typing with the text kept, so the next pause retries it.
        error: ({ data, to }) => to("typing", { text: data.text }),
      },
      on: { submit: ({ to }) => to("sent"), cancel: ({ data, to }) => to("typing", { text: data.text }) },
    },
    sent: { final: true },
  },
});

// #endregion
