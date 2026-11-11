// The four canonical flows of plans/state/AUTHORING.md, compiled by the preload plugin and run:
// each test pins the behaviour the requirements name, on the machine as written in ./machines.ts.
//
// The clock is a SimulatedClock (deterministic, moved by hand) and a task's promise settles on the
// microtask queue, so `flush()` is awaited after a move that starts or ends a task. No real timer
// is waited on, and no host tick is substituted for a task or timer ordering: the clock's advance
// is what fires a timer, and the flush is what lets a settled task's event land.

import { afterEach, describe, expect, test } from "bun:test";

import { SimulatedClock } from "@reactre/state/utils/SimulatedClock";

import "../compiled.ts";

const { createActor } = await import("@reactre/state");
const { fetcherMachine, formMachine, pollMachine, searchMachine } = await import("./machines.ts");

let clock: SimulatedClock | undefined;
afterEach(() => clock?.uninstall());

/** A settled task's event lands on the microtask queue: two turns let the promise and its handler run. */
const flush = async (): Promise<void> => {
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  await new Promise((r) => queueMicrotask(() => r(undefined)));
};

/** `fetch` replaced for one test, restored after: the requests the machine made, and their signals. */
async function withFetch<T>(
  respond: (url: string, init: RequestInit | undefined) => Promise<Response>,
  body: (calls: { readonly url: string; readonly signal: AbortSignal | undefined }[]) => Promise<T>,
): Promise<T> {
  const calls: { url: string; signal: AbortSignal | undefined }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal ?? undefined });
    return respond(url, init);
  }) as unknown as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = real;
  }
}

/** A response that resolves after `ms` on the simulated clock. */
const later = (ms: number, body: string, status = 200): Promise<Response> =>
  new Promise((resolve) => setTimeout(() => resolve(new Response(body, { status })), ms));

describe("1. typeahead with stale result cancellation", () => {
  test("a new query aborts the request in flight, and only the latest query's result is shown", async () => {
    clock = new SimulatedClock();
    await withFetch(
      (url) => later(50, JSON.stringify([url])),
      async (calls) => {
        const actor = createActor(searchMachine, { now: clock!.now });
        actor.send({ type: "query", q: "a" });
        actor.send({ type: "query", q: "ab" });
        // The first request's signal is aborted by the reentering move; the second is live.
        expect(calls).toHaveLength(2);
        expect(calls[0]?.signal?.aborted).toBe(true);
        expect(calls[1]?.signal?.aborted).toBe(false);
        clock!.advance(50);
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "results", data: { q: "ab" } });
        actor.stop();
      },
    );
  });

  test("a result for a query the state no longer holds is declined, not shown", async () => {
    clock = new SimulatedClock();
    await withFetch(
      () => later(50, JSON.stringify(["x"])),
      async () => {
        const actor = createActor(searchMachine, { now: clock!.now });
        actor.send({ type: "query", q: "a" });
        // The state's data changes under the running task without restarting it: a stale result.
        actor.send({ type: "query", q: "ab" });
        clock!.advance(50);
        await flush();
        // The first task's result (q "a") is declined; the second's (q "ab") is the one shown.
        expect(actor.snapshot()).toMatchObject({ state: "results", data: { q: "ab" } });
        actor.stop();
      },
    );
  });

  test("a failed request goes to failed with the query, and the next query searches again", async () => {
    clock = new SimulatedClock();
    await withFetch(
      () => later(10, "nope", 500),
      async () => {
        const actor = createActor(searchMachine, { now: clock!.now });
        actor.send({ type: "query", q: "a" });
        clock!.advance(10);
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "failed", data: { q: "a", error: "Error: HTTP 500" } });
        actor.send({ type: "query", q: "b" });
        expect(actor.snapshot()).toMatchObject({ state: "searching", data: { q: "b" } });
        actor.stop();
      },
    );
  });
});

describe("2. ordinary fetch with retry and failure statuses", () => {
  test("a 500 is a failure, retry re-enters loading with the attempt counted, and the third gives up", async () => {
    clock = new SimulatedClock();
    await withFetch(
      () => Promise.resolve(new Response("nope", { status: 500 })),
      async () => {
        const actor = createActor(fetcherMachine, { input: { url: "/api" }, now: clock!.now });
        actor.send({ type: "fetch" });
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "failed", data: { attempt: 1, error: "Error: HTTP 500" } });
        actor.send({ type: "retry" });
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "failed", data: { attempt: 2 } });
        actor.send({ type: "retry" });
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "failed", data: { attempt: 3 } });
        actor.send({ type: "retry" });
        expect(actor.snapshot()).toMatchObject({ state: "gaveUp", data: { url: "/api" } });
        actor.stop();
      },
    );
  });

  test("a 200 loads the body, and the state narrows to loaded", async () => {
    clock = new SimulatedClock();
    await withFetch(
      () => Promise.resolve(new Response("hello", { status: 200 })),
      async () => {
        const actor = createActor(fetcherMachine, { input: { url: "/api" }, now: clock!.now });
        actor.send({ type: "fetch" });
        await flush();
        const snapshot = actor.snapshot();
        expect(snapshot).toMatchObject({ state: "loaded", data: { url: "/api", body: "hello" } });
        // The narrowing the README shows: only "loaded" has a body.
        if (snapshot.state === "loaded") expect(snapshot.data.body).toBe("hello");
        actor.stop();
      },
    );
  });

  test("the 10s timer fails the load, and cancel returns to idle with the url", async () => {
    clock = new SimulatedClock();
    await withFetch(
      () => new Promise<Response>(() => {}),
      async () => {
        const actor = createActor(fetcherMachine, { input: { url: "/api" }, now: clock!.now });
        actor.send({ type: "fetch" });
        clock!.advance(10_000);
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "failed", data: { attempt: 1, error: "timed out" } });
        actor.send({ type: "retry" });
        actor.send({ type: "cancel" });
        expect(actor.snapshot()).toMatchObject({ state: "idle", data: { url: "/api" } });
        actor.stop();
      },
    );
  });
});

describe("3. polling re-arming", () => {
  test("each interval re-enters the state, so the timer re-arms from the poll's own entry", () => {
    clock = new SimulatedClock();
    const actor = createActor(pollMachine, { now: clock!.now });
    expect(actor.snapshot()).toMatchObject({ state: "polling", data: { n: 0 } });
    clock!.advance(10);
    expect(actor.snapshot()).toMatchObject({ state: "polling", data: { n: 1 } });
    clock!.advance(9);
    expect(actor.snapshot()).toMatchObject({ state: "polling", data: { n: 1 } });
    clock!.advance(1);
    expect(actor.snapshot()).toMatchObject({ state: "polling", data: { n: 2 } });
    actor.stop();
  });

  test("stop leaves the loop, and no timer fires after it", () => {
    clock = new SimulatedClock();
    const actor = createActor(pollMachine, { now: clock!.now });
    clock!.advance(10);
    actor.send({ type: "stop" });
    expect(actor.snapshot()).toMatchObject({ state: "done" });
    clock!.advance(100);
    expect(actor.snapshot()).toMatchObject({ state: "done" });
    expect(clock!.pending()).toBe(0);
    actor.stop();
  });
});

describe("4. debounced submit", () => {
  test("each keystroke restarts the wait: only a 300ms pause submits", async () => {
    clock = new SimulatedClock();
    await withFetch(
      () => Promise.resolve(new Response("ok", { status: 200 })),
      async () => {
        const actor = createActor(formMachine, { now: clock!.now });
        actor.send({ type: "type", text: "a" });
        clock!.advance(200);
        actor.send({ type: "type", text: "ab" });
        clock!.advance(200);
        expect(actor.snapshot()).toMatchObject({ state: "typing", data: { text: "ab" } });
        clock!.advance(100);
        expect(actor.snapshot()).toMatchObject({ state: "submitting", data: { text: "ab" } });
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "sent" });
        actor.stop();
      },
    );
  });

  test("a failed submit returns to typing with the text kept, and the next pause retries it", async () => {
    clock = new SimulatedClock();
    let status = 500;
    await withFetch(
      () => Promise.resolve(new Response("nope", { status })),
      async () => {
        const actor = createActor(formMachine, { now: clock!.now });
        actor.send({ type: "type", text: "hi" });
        clock!.advance(300);
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "typing", data: { text: "hi" } });
        status = 200;
        clock!.advance(300);
        await flush();
        expect(actor.snapshot()).toMatchObject({ state: "sent" });
        actor.stop();
      },
    );
  });
});
