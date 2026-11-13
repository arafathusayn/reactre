import { afterEach, beforeEach, expect, test } from "bun:test";

import { effect } from "@reactre/core";
import { createRoot } from "@reactre/core/features/owner";
import { createActor } from "@reactre/state";
import { useActor } from "@reactre/state/signals";

import "./compiled.ts";

const { requestMachine } = await import("../examples/request.machine.ts");
const { createCachedRequest } = await import("../examples/cached-request.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const originalFetch = globalThis.fetch;
const pending: {
  url: string;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}[] = [];
const cleanups: (() => void)[] = [];

beforeEach(() => {
  // Deliberately ignore abort: even a non-cancellable SDK operation must not publish stale results.
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ url: String(input), signal: init?.signal, resolve, reject });
      }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  pending.length = 0;
  globalThis.fetch = originalFetch;
});

function start() {
  const actor = createActor(requestMachine);
  cleanups.push(() => actor.stop());
  return actor;
}

test("rapid reentry aborts old tasks and ignores late success and rejection", async () => {
  const actor = start();
  actor.send({ type: "load", url: "/first" });
  actor.send({ type: "load", url: "/second" });
  actor.send({ type: "load", url: "/third" });
  expect(pending.map((request) => request.signal?.aborted)).toEqual([true, true, false]);
  pending[0]!.resolve(new Response("stale"));
  pending[1]!.reject(new Error("stale failure"));
  await tick();
  expect(actor.snapshot().state).toBe("loading");
  expect(actor.snapshot().data).toEqual({ url: "/third" });
  pending[2]!.resolve(new Response("current"));
  await tick();
  expect(actor.snapshot().state).toBe("ready");
  expect(actor.snapshot().data).toEqual({ url: "/third", text: "current" });
  actor.send({ type: "clear" });
  expect(actor.snapshot().state).toBe("idle");
  actor.send({ type: "load", url: "/cancel" });
  actor.send({ type: "cancel" });
  expect(pending[3]!.signal?.aborted).toBe(true);
  pending[3]!.resolve(new Response("cancelled"));
  await tick();
  expect(actor.snapshot().state).toBe("idle");
});

test("failure requires explicit retry and permits replacement or clearing", async () => {
  const actor = start();
  actor.send({ type: "load", url: "/retry" });
  pending[0]!.resolve(new Response("unavailable", { status: 503 }));
  await tick();
  expect(actor.snapshot().state).toBe("failed");
  expect(actor.snapshot().data).toEqual({ url: "/retry", message: "Error: HTTP 503" });
  await tick();
  expect(pending).toHaveLength(1);
  actor.send({ type: "retry" });
  expect(pending[1]!.url).toBe("/retry");
  pending[1]!.resolve(new Response("recovered"));
  await tick();
  expect(actor.snapshot().data).toEqual({ url: "/retry", text: "recovered" });
  actor.send({ type: "load", url: "/failure" });
  pending[2]!.reject(new Error("offline"));
  await tick();
  actor.send({ type: "load", url: "/replacement" });
  expect(pending[3]!.url).toBe("/replacement");
  pending[3]!.reject(new Error("offline again"));
  await tick();
  actor.send({ type: "clear" });
  expect(actor.snapshot().state).toBe("idle");
});

test("useActor stops with its view and remount starts an independent actor", async () => {
  function mount() {
    return createRoot((dispose) => {
      cleanups.push(dispose);
      const [snapshot, actor] = useActor(requestMachine);
      const seen: string[] = [];
      effect(() => {
        seen.push(snapshot().state);
      });
      return { actor, snapshot, seen, dispose };
    });
  }
  const first = mount();
  first.actor.send({ type: "load", url: "/old-view" });
  expect(first.seen).toEqual(["idle", "loading"]);
  first.dispose();
  expect(pending[0]!.signal?.aborted).toBe(true);
  const second = mount();
  expect(second.actor).not.toBe(first.actor);
  expect(second.snapshot().state).toBe("idle");
  pending[0]!.resolve(new Response("late"));
  await tick();
  expect(first.seen).toEqual(["idle", "loading"]);
  expect(second.seen).toEqual(["idle"]);
  second.actor.send({ type: "load", url: "/new-view" });
  pending[1]!.resolve(new Response("new"));
  await tick();
  expect(second.seen).toEqual(["idle", "loading", "ready"]);
});

test("cached controllers outlive views and stop only on cache eviction", async () => {
  const firstSeen: string[] = [];
  const first = createRoot((dispose) => {
    cleanups.push(dispose);
    // Even creation under a view's owner does not transfer ownership of the cached controller.
    const controller = createCachedRequest();
    cleanups.push(() => controller.dispose());
    effect(() => {
      firstSeen.push(controller.snapshot().state);
    });
    return { controller, dispose };
  });
  const { controller } = first;
  controller.actor.send({ type: "load", url: "/cached" });
  first.dispose();
  expect(pending[0]!.signal?.aborted).toBe(false);
  const secondSeen: string[] = [];
  const disposeSecond = createRoot((dispose) => {
    cleanups.push(dispose);
    effect(() => {
      secondSeen.push(controller.snapshot().state);
    });
    return dispose;
  });
  pending[0]!.resolve(new Response("cached result"));
  await tick();
  expect(firstSeen).toEqual(["idle", "loading"]);
  expect(secondSeen).toEqual(["loading", "ready"]);
  controller.actor.send({ type: "load", url: "/evict" });
  controller.dispose();
  controller.dispose();
  expect(pending[1]!.signal?.aborted).toBe(true);
  pending[1]!.reject(new Error("after eviction"));
  await tick();
  expect(secondSeen).toEqual(["loading", "ready", "loading"]);
  controller.actor.send({ type: "load", url: "/stopped" });
  expect(pending).toHaveLength(2);
  disposeSecond();
});
