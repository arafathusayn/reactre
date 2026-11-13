// Child actors (@reactre/state/children), on compiled tables written by hand, as the compiler will
// write them for `use: [children]`. Their shapes are written as types, with the `"~children"` the
// core's `machine` will attach, so `child()` is typed as an app sees it.

import { describe, expect, mock, test } from "bun:test";

import { __actors, child, type children } from "../src/features/children/index.ts";
import { __actorsSaved } from "../src/features/children/saved.ts";
import { createAsyncLogic, createCallbackLogic } from "../src/features/logic/index.ts";
import { migrations, persist } from "../src/features/persist/index.ts";
import { createActor, type Machine, restoreActor, type Type } from "../src/index.ts";
import type { __Compiled, __Event, __Leaf } from "../src/internal.ts";
import { __run } from "../src/run.ts";
import { __lean } from "../src/tasks.ts";
import { assertEvent } from "../src/utils/assertEvent.ts";
import { select } from "../src/utils/select.ts";
import { SimulatedClock } from "../src/utils/SimulatedClock.ts";
import { toPromise } from "../src/utils/toPromise.ts";
import { waitFor } from "../src/utils/waitFor.ts";
import { to } from "./to.ts";

/** What `use: [children, persist]` gives a shape. */
type Uses = { use: readonly [typeof children, typeof persist] };

const tick = () => new Promise((r) => setTimeout(r, 0));
const field = <T>(event: __Event, key: string) => (event as unknown as { [key: string]: T })[key] as T;

// #region The machines

type Up = { file: string; pct: number };
type UploadShape = {
  states: { sending: Type<Up>; sent: Type<{ url: string }> };
  events: { progress: Type<{ pct: number }>; finish: Type<{}> };
};

/** The child: it uploads a file, reports progress, and ends in `sent`. */
const upload: Machine<UploadShape> = {
  v: 1,
  e: { progress: 1, finish: 1 },
  i: (input) => to("sending", { file: (input as { file: string }).file, pct: 0 }, 1),
  o: {
    sending: {
      progress: (data, event) => to("sending", { ...(data as Up), pct: field<number>(event, "pct") }, 1),
      finish: (data) => to("sent", { url: `/${(data as Up).file}` }, 1),
    },
    sent: {},
  },
  f: { sent: 1 },
};

/** A child whose start is already final. */
const instant: Machine<UploadShape> = { ...upload, i: () => to("sent", { url: "/now" }, 1) };

type P = { file: string; pct: number };
type ParentShape = Uses & {
  states: { idle: Type<{}>; uploading: Type<P>; uploaded: Type<{ url: string }> };
  events: { go: Type<{ file: string }>; cancel: Type<{}> };
  "~children": { upload: { machine: Machine<UploadShape> } };
};

const outputs: __Leaf[] = [];

/** The parent: `uploading` runs `upload`, mirrors its progress, and moves on when it's done. */
function parent(m: __Compiled = upload, first?: P): Machine<ParentShape> {
  return {
    v: 0,
    e: { go: 1, cancel: 1 },
    i: () => (first === undefined ? to("idle") : to("uploading", first)),
    o: {
      idle: { go: (_, event) => to("uploading", { file: field<string>(event, "file"), pct: 0 }) },
      uploading: { cancel: () => to("idle") },
      uploaded: {},
    },
    f: { uploaded: 1 },
    c: {
      uploading: {
        upload: {
          m,
          i: (data) => ({ file: (data as P).file }),
          d: (_, output) => (outputs.push(output), to("uploaded", output.data)),
          u: (data, now) => to("uploading", { ...(data as P), pct: (now.data as Up).pct }),
        },
      },
    },
    u: { persist: 1 },
    r: __run([__actorsSaved]),
  };
}

// #endregion

describe("a child", () => {
  test("starts with its node and stops when the node exits", () => {
    const actor = createActor(parent());
    expect(child(actor, "upload")).toBeUndefined();
    actor.send({ type: "go", file: "a" });
    const kid = child(actor, "upload");
    expect(kid?.status()).toBe("active");
    expect(kid?.snapshot()).toEqual({ state: "sending", data: { file: "a", pct: 0 }, version: 1 });
    actor.send({ type: "cancel" });
    expect(child(actor, "upload")).toBeUndefined();
    expect(kid?.status()).toBe("stopped");
  });

  test("stops when its parent stops", () => {
    const actor = createActor(parent());
    actor.send({ type: "go", file: "a" });
    const kid = child(actor, "upload");
    actor.stop();
    expect(kid?.status()).toBe("stopped");
  });

  test("update mirrors its progress, and the node stays: the same child keeps running", () => {
    const actor = createActor(parent());
    actor.send({ type: "go", file: "a" });
    const kid = child(actor, "upload");
    const seen: number[] = [];
    actor.subscribe((s) => s.state === "uploading" && seen.push(s.data.pct));
    kid?.send({ type: "progress", pct: 40 });
    kid?.send({ type: "progress", pct: 90 });
    expect(seen).toEqual([40, 90]);
    expect(child(actor, "upload")).toBe(kid);
  });

  test("done moves the parent, with the child's final state and data as the output", () => {
    outputs.length = 0;
    const actor = createActor(parent());
    actor.send({ type: "go", file: "a.txt" });
    child(actor, "upload")?.send({ type: "finish" });
    expect(outputs).toEqual([{ state: "sent", data: { url: "/a.txt" } }]);
    expect(actor.snapshot()).toEqual({ state: "uploaded", data: { url: "/a.txt" }, version: 0 });
    expect(actor.status()).toBe("done");
  });

  test("a child that is done as it starts reports in a microtask, after the parent's entry", async () => {
    const actor = createActor(parent(instant));
    expect(actor.send({ type: "go", file: "a" }).snapshot.state).toBe("uploading");
    await Promise.resolve();
    expect(actor.snapshot()).toEqual({ state: "uploaded", data: { url: "/now" }, version: 0 });

    // In the parent's start too: the actor isn't even returned yet when the child ends.
    const born = createActor(parent(instant, { file: "b", pct: 0 }));
    expect(born.snapshot().state).toBe("uploading");
    await Promise.resolve();
    expect(born.snapshot().state).toBe("uploaded");
  });

  test("a late report from a child whose node exited is dropped", async () => {
    const actor = createActor(parent(instant));
    actor.send({ type: "go", file: "a" });
    actor.send({ type: "cancel" });
    await tick();
    expect(actor.snapshot().state).toBe("idle");
  });

  test("child() is typed by the parent's children", () => {
    const actor = createActor(parent());
    actor.send({ type: "go", file: "a" });
    const kid = child(actor, "upload");
    // @ts-expect-error not an event of the child
    kid?.send({ type: "go", file: "b" });
    // @ts-expect-error the parent has no child "download"
    expect(child(actor, "download")).toBeUndefined();
    const s = kid?.snapshot();
    if (s?.state === "sending") expect(s.data.pct).toBe(0);
  });
});

describe("keyed children", () => {
  type B = { files: string[]; done: string[] };
  type BatchShape = {
    states: { batch: Type<B> };
    events: { add: Type<{ file: string }>; drop: Type<{ file: string }> };
    "~children": { files: { machine: Machine<UploadShape>; each: unknown } };
  };
  const batch: Machine<BatchShape> = {
    v: 0,
    e: { add: 1, drop: 1 },
    i: () => to("batch", { files: ["a", "b"], done: [] }),
    o: {
      batch: {
        add: (data, event) =>
          to("batch", { ...(data as B), files: [...(data as B).files, field<string>(event, "file")] }),
        drop: (data, event) =>
          to("batch", { ...(data as B), files: (data as B).files.filter((f) => f !== field<string>(event, "file")) }),
      },
    },
    c: {
      batch: {
        files: {
          m: upload,
          k: (data) => (data as B).files.map((file) => [file, { file }] as const),
          // The key is the 4th argument (see the report: `__Child`'s `d` and `u` need it typed).
          d: (data, output, _state, key?: string) =>
            to("batch", {
              files: (data as B).files.filter((f) => f !== key),
              done: [...(data as B).done, `${key}:${(output.data as { url: string }).url}`],
            }),
        },
      },
    },
    r: __run([__actors]),
  };

  test("start per key, and reconcile on each stay: new keys start, missing keys stop", () => {
    const actor = createActor(batch);
    const a = child(actor, "files", "a");
    expect(a?.snapshot().state).toBe("sending");
    expect(child(actor, "files", "b")?.status()).toBe("active");
    expect(child(actor, "files", "c")).toBeUndefined();

    actor.send({ type: "drop", file: "a" });
    expect(child(actor, "files", "a")).toBeUndefined();
    expect(a?.status()).toBe("stopped");
    actor.send({ type: "add", file: "c" });
    expect(child(actor, "files", "c")?.snapshot()).toEqual({
      state: "sending",
      data: { file: "c", pct: 0 },
      version: 1,
    });

    child(actor, "files", "b")?.send({ type: "finish" });
    expect(actor.snapshot().data).toEqual({ files: ["c"], done: ["b:/b"] });
    expect(child(actor, "files", "b")).toBeUndefined();
  });

  test("a keyed child is reached by its key", () => {
    const actor = createActor(batch);
    // @ts-expect-error a keyed collection's child takes its key
    expect(child(actor, "files")).toBeUndefined();
  });
});

describe("persist and restore", () => {
  test("a child's state is saved under its node and restored, not started fresh", () => {
    const actor = createActor(parent());
    actor.send({ type: "go", file: "a" });
    child(actor, "upload")?.send({ type: "progress", pct: 50 });
    const saved = persist(actor);
    expect(saved.run).toEqual({
      uploading: { c: { upload: { "": { state: "sending", data: { file: "a", pct: 50 }, version: 1, run: {} } } } },
    });

    const machine = parent();
    const restored = restoreActor(machine, migrations(machine)(JSON.parse(JSON.stringify(saved))));
    expect(restored.snapshot()).toEqual({ state: "uploading", data: { file: "a", pct: 50 }, version: 0 });
    expect(child(restored, "upload")?.snapshot()).toEqual({
      state: "sending",
      data: { file: "a", pct: 50 },
      version: 1,
    });
    child(restored, "upload")?.send({ type: "finish" });
    expect(restored.snapshot()).toEqual({ state: "uploaded", data: { url: "/a" }, version: 0 });
  });

  test("a plain snapshot starts its children fresh", () => {
    const restored = restoreActor(parent(), { state: "uploading", data: { file: "z", pct: 70 }, version: 0 });
    expect(child(restored, "upload")?.snapshot().data).toEqual({ file: "z", pct: 0 });
  });
});

describe("a child inside a child", () => {
  type MidShape = {
    states: { working: Type<{ file: string }>; finished: Type<{ url: string }> };
    events: {};
    "~children": { leaf: { machine: Machine<UploadShape> } };
  };
  const middle: Machine<MidShape> = {
    v: 0,
    e: {},
    i: (input) => to("working", input),
    o: { working: {}, finished: {} },
    f: { finished: 1 },
    c: { working: { leaf: { m: upload, i: (data) => data, d: (_, output) => to("finished", output.data) } } },
    r: __run([__actorsSaved]),
  };
  type TopShape = Uses & {
    states: { busy: Type<{ file: string }>; over: Type<{ url: string }> };
    events: {};
    "~children": { mid: { machine: Machine<MidShape> } };
  };
  const top: Machine<TopShape> = {
    v: 0,
    e: {},
    i: () => to("busy", { file: "deep" }),
    o: { busy: {}, over: {} },
    f: { over: 1 },
    c: { busy: { mid: { m: middle, i: (data) => data, d: (_, output) => to("over", output.data) } } },
    u: { persist: 1 },
    r: __run([__actorsSaved]),
  };

  test("the grandchild's done ends the child, whose done moves the parent", () => {
    const actor = createActor(top);
    const mid = child(actor, "mid");
    const leaf = mid === undefined ? undefined : child(mid, "leaf");
    expect(leaf?.snapshot().state).toBe("sending");
    leaf?.send({ type: "finish" });
    expect(mid?.status()).toBe("done");
    expect(actor.snapshot()).toEqual({ state: "over", data: { url: "/deep" }, version: 0 });
  });

  test("persist saves the grandchild too, and restore brings it back", () => {
    const actor = createActor(top);
    const mid = child(actor, "mid");
    if (mid !== undefined) child(mid, "leaf")?.send({ type: "progress", pct: 30 });
    const restored = restoreActor(top, migrations(top)(JSON.parse(JSON.stringify(persist(actor)))));
    const again = child(restored, "mid");
    const leaf = again === undefined ? undefined : child(again, "leaf");
    expect(leaf?.snapshot().data).toEqual({ file: "deep", pct: 30 });
    leaf?.send({ type: "finish" });
    expect(restored.snapshot().state).toBe("over");
  });
});

describe("several children, errors and sent events", () => {
  type Ev = { readonly type: string; readonly [k: string]: unknown };
  const broken: __Compiled = {
    v: 0,
    e: {},
    i: () => {
      throw new Error("no start");
    },
    o: { on: {} },
  };
  const ticks = createCallbackLogic<never, undefined, { type: "tick"; n: number }>(({ sendBack }) => {
    sendBack({ type: "tick", n: 1 });
    sendBack({ type: "tick", n: 2 });
    return () => {};
  });
  const errors: unknown[] = [];
  /** `busy` runs the upload, the ticker and (optionally) the broken child, each with its handlers. */
  const busy = (withBroken: boolean, handled = true): __Compiled => ({
    v: 0,
    e: { go: 1 },
    i: () => to("idle"),
    o: {
      idle: { go: () => to("busy", { n: 0 }) },
      busy: {},
      failed: {},
    },
    c: {
      busy: {
        upload: { m: upload, i: () => ({ file: "f" }) },
        ticker: {
          m: ticks,
          o: { tick: (data, event) => to("busy", { n: (data as { n: number }).n + ((event as Ev).n as number) }) },
        },
        ...(withBroken && {
          broken: {
            m: broken,
            ...(handled && { x: (_: unknown, error: unknown) => (errors.push(error), to("failed")) }),
          },
        }),
      },
    },
    r: __run([__actors]),
  });

  type BusyShape = Uses & {
    states: { idle: Type<{}>; busy: Type<{ n: number }>; failed: Type<{}> };
    events: { go: Type<{}> };
    "~children": { upload: { machine: Machine<UploadShape> } };
  };
  // The cast: these tables are written by hand, as the compiler writes them for this shape.
  const run = (m: __Compiled) => createActor(m as Machine<BusyShape>);

  test("a node runs each of its children, and a child's sent events go to its spec's on", async () => {
    const actor = run(busy(false));
    actor.send({ type: "go" });
    expect(child(actor, "upload")?.snapshot().state).toBe("sending");
    await tick();
    expect(actor.snapshot()).toEqual({ state: "busy", data: { n: 3 }, version: 0 });
  });

  test("a child whose start throws goes to its error handler; without one, the throw reaches the sender", async () => {
    const actor = run(busy(true));
    actor.send({ type: "go" });
    await tick();
    expect(actor.snapshot().state).toBe("failed");
    expect(String(errors[0])).toContain("no start");
    const bare = run(busy(true, false));
    expect(() => bare.send({ type: "go" })).toThrow("no start");
  });
});

describe("helpers", () => {
  const light = (): Machine<{
    states: { off: Type<{}>; on: Type<{ n: number }>; gone: Type<{}> };
    events: { flip: Type<{}>; end: Type<{}> };
  }> => ({
    v: 0,
    e: { flip: 1, end: 1 },
    i: () => to("off"),
    o: {
      off: { flip: () => to("on", { n: 1 }), end: () => to("gone") },
      on: { flip: () => to("off") },
      gone: {},
    },
    f: { gone: 1 },
  });

  test("select tells only changes, by compare", () => {
    const actor = createActor(light());
    const state = select(actor, (s) => s.state);
    const seen: string[] = [];
    state.subscribe((v) => seen.push(v));
    actor.send({ type: "flip" });
    actor.send({ type: "flip" });
    expect(state.get()).toBe("off");
    expect(seen).toEqual(["on", "off"]);
    const always = select(
      actor,
      (s) => ({ on: s.state === "on" }),
      (a, b) => a.on === b.on,
    );
    const first = always.get();
    let told = 0;
    always.subscribe(() => told++);
    actor.send({ type: "end" });
    expect(always.get()).toBe(first);
    expect(told).toBe(0);
  });

  test("toPromise resolves with a machine's final snapshot, a logic's output, and rejects with its error", async () => {
    const actor = createActor(light());
    const end = toPromise(actor);
    actor.send({ type: "end" });
    expect(await end).toEqual({ state: "gone", data: {} } as never);
    expect(await toPromise(createActor(createAsyncLogic({ run: async () => 42 })))).toBe(42);
    const failing = createAsyncLogic({
      run: async (): Promise<number> => {
        throw new Error("nope");
      },
    });
    await expect(toPromise(createActor(failing))).rejects.toThrow("nope");
  });

  test("waitFor resolves now or later, and rejects on timeout (S37), on an end without a match (S38), and on abort", async () => {
    const actor = createActor(light());
    expect((await waitFor(actor, (s) => s.state === "off")).state).toBe("off");
    const on = waitFor(actor, (s) => s.state === "on");
    actor.send({ type: "flip" });
    expect((await on).data).toEqual({ n: 1 });
    await expect(waitFor(actor, (s) => s.state === "gone", { timeout: 5 })).rejects.toThrow("S37");
    const never = waitFor(actor, () => false);
    actor.send({ type: "flip" });
    actor.send({ type: "end" });
    await expect(never).rejects.toThrow("S38");
    const controller = new AbortController();
    const aborted = waitFor(createActor(light()), () => false, { signal: controller.signal });
    controller.abort(new Error("left"));
    await expect(aborted).rejects.toThrow("left");
  });

  test("assertEvent narrows, or throws S39 naming the types", () => {
    const event: { type: "a" } | { type: "b"; n: number } = { type: "b", n: 1 };
    assertEvent(event, "b");
    expect(event.n).toBe(1);
    expect(() => assertEvent(event as { type: "a" } | { type: "b"; n: number }, ["a"])).toThrow(
      'S39] expected an event of type "a", and got "b"',
    );
  });
});

describe("react", () => {
  // A minimal renderer, as React's hooks behave for one component: state slots, effects after the
  // render (cleanups on unmount), and an external store that re-renders on change.
  let slots: unknown[] = [];
  let at = 0;
  let effects: (() => void)[] = [];
  let cleanups: (() => void)[] = [];
  let rerender = (): void => {};
  mock.module("react", () => ({
    useState: <T>(init: () => T) => {
      const i = at++;
      if (!(i in slots)) slots[i] = init();
      return [slots[i] as T, (next: T) => ((slots[i] = next), rerender())];
    },
    useRef: <T>(init: T) => {
      const i = at++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useCallback: <F>(fn: F) => fn,
    useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
      const i = at++;
      const was = slots[i] as readonly unknown[] | undefined;
      if (was && was.every((d, j) => d === deps[j])) return;
      slots[i] = deps;
      effects.push(() => {
        const c = fn();
        if (c) cleanups.push(c);
      });
    },
    useSyncExternalStore: <T>(subscribe: (f: () => void) => () => void, get: () => T) => {
      const i = at++;
      if (!(i in slots)) slots[i] = subscribe(() => rerender());
      return get();
    },
  }));

  /** Renders `hook` until it settles; `unmount` runs the cleanups. */
  function render<T>(hook: () => T): {
    readonly current: () => T;
    readonly renders: () => number;
    readonly unmount: () => void;
  } {
    slots = [];
    effects = [];
    cleanups = [];
    let value: T;
    let n = 0;
    rerender = () => {
      at = 0;
      n++;
      value = hook();
      for (const e of effects.splice(0)) e();
    };
    rerender();
    return { current: () => value, renders: () => n, unmount: () => cleanups.splice(0).forEach((c) => c()) };
  }

  const counter = (): Machine<{ states: { at: Type<{ n: number }> }; events: { inc: Type<{}>; same: Type<{}> } }> => ({
    v: 0,
    e: { inc: 1, same: 1 },
    i: () => to("at", { n: 0 }),
    o: {
      at: {
        inc: (d) => to("at", { n: (d as { n: number }).n + 1 }),
        same: (d) => to("at", { n: (d as { n: number }).n }),
      },
    },
  });

  test("useActor renders each move, and stops the actor on unmount", async () => {
    const { useActor } = await import("../src/entries/react.ts");
    const view = render(() => useActor(counter()));
    const [first, actor] = view.current();
    expect(first.data.n).toBe(0);
    actor.send({ type: "inc" });
    expect(view.current()[0].data.n).toBe(1);
    expect(view.current()[1]).toBe(actor);
    view.unmount();
    expect(actor.status()).toBe("stopped");
  });

  test("useSelector re-renders with the same value when the selection doesn't change", async () => {
    const { useActorRef, useSelector } = await import("../src/entries/react.ts");
    const values: number[] = [];
    const view = render(() => {
      const actor = useActorRef(counter());
      const n = useSelector(
        actor,
        (s) => ({ n: s.data.n }),
        (a, b) => a.n === b.n,
      );
      values.push(n.n);
      return [actor, n] as const;
    });
    const [actor, first] = view.current();
    actor.send({ type: "same" });
    expect(view.current()[1]).toBe(first);
    actor.send({ type: "inc" });
    expect(view.current()[1]).toEqual({ n: 1 });
    expect(values).toEqual([0, 0, 1]);
  });

  test("strict mode's second mount gets a new actor", async () => {
    const { useActorRef } = await import("../src/entries/react.ts");
    const view = render(() => useActorRef(counter()));
    const first = view.current();
    view.unmount();
    // React mounts again: the effect runs once more on the same state.
    slots[1] = undefined;
    rerender();
    expect(first.status()).toBe("stopped");
    expect(view.current()).not.toBe(first);
    expect(view.current().status()).toBe("active");
  });

  // A counter whose start has a timer and a task: what a render must not start.
  const busy = (log: string[]): Machine<{ states: { at: Type<{ n: number }> }; events: { inc: Type<{}> } }> =>
    ({
      ...counter(),
      e: { inc: 1 },
      r: __lean,
      a: { at: [[1000, () => to("at", { n: 99 })]] },
      t: {
        at: [
          (_d: unknown, signal: AbortSignal) => (
            log.push("task"),
            new Promise<__Event>((_, reject) => signal.addEventListener("abort", () => (log.push("aborted"), reject())))
          ),
          () => to("at", { n: -1 }),
        ],
      },
    }) as Machine<{ states: { at: Type<{ n: number }> }; events: { inc: Type<{}> } }>;

  test("a render starts nothing: not on the server, nor in a render React throws away", async () => {
    const { useActor } = await import("../src/entries/react.ts");
    const clock = new SimulatedClock();
    try {
      const log: string[] = [];
      // A server render, or one that suspends or that strict mode repeats: no effect ever runs.
      slots = [];
      at = 0;
      const [snapshot, actor] = useActor(busy(log), { now: clock.now });
      effects = [];
      expect(snapshot).toEqual({ state: "at", data: { n: 0 }, version: 0 });
      expect(actor.status()).toBe("active");
      expect(clock.pending()).toBe(0);
      expect(log).toEqual([]);
    } finally {
      clock.uninstall();
    }
  });

  test("the actor starts in the effect and stops in its cleanup", async () => {
    const { useActorRef } = await import("../src/entries/react.ts");
    const clock = new SimulatedClock();
    try {
      const log: string[] = [];
      const view = render(() => useActorRef(busy(log), { now: clock.now }));
      expect(clock.pending()).toBe(1);
      expect(log).toEqual(["task"]);
      view.unmount();
      expect(view.current().status()).toBe("stopped");
      expect(clock.pending()).toBe(0);
      expect(log).toEqual(["task", "aborted"]);
    } finally {
      clock.uninstall();
    }
  });

  test("before its effect, a send starts the actor (a child's effect runs before its parent's)", async () => {
    const { useActorRef } = await import("../src/entries/react.ts");
    const clock = new SimulatedClock();
    try {
      const log: string[] = [];
      slots = [];
      at = 0;
      const actor = useActorRef(busy(log), { now: clock.now });
      const told: number[] = [];
      const off = actor.subscribe((s) => told.push(s.data.n));
      const gone = actor.subscribe(() => told.push(-1));
      gone();
      expect(actor.send({ type: "inc" })).toMatchObject({ ok: true, snapshot: { data: { n: 1 } } });
      expect(told).toEqual([1]);
      // A move to the same leaf stays: its task runs on.
      expect(log).toEqual(["task"]);
      // The parent's effect: the actor is running already, so it isn't started again.
      for (const e of effects.splice(0)) e();
      expect(log).toEqual(["task"]);
      off();
      for (const c of cleanups.splice(0)) c();
      expect(actor.status()).toBe("stopped");
      expect(actor.send({ type: "inc" })).toMatchObject({ ok: false, reason: "inactive" });
    } finally {
      clock.uninstall();
    }
  });

  test("a listener subscribed before the start hears a move the start makes", async () => {
    const { useActorRef } = await import("../src/entries/react.ts");
    // A lifecycle that moves at the start, as effects' raised start events do.
    const moving = {
      ...counter(),
      r: (_m: __Compiled, move: (r: { ok: true; snapshot: __Leaf & { version: number } }) => unknown) => ({
        enter: (s: __Leaf) =>
          void (
            s.state === "at" &&
            (s.data as { n: number }).n === 0 &&
            move({ ok: true, snapshot: to("at", { n: 5 }) })
          ),
        stop: () => {},
      }),
    } as unknown as ReturnType<typeof counter>;
    slots = [];
    at = 0;
    const actor = useActorRef(moving);
    const told: number[] = [];
    actor.subscribe((s) => told.push(s.data.n));
    expect(actor.snapshot().data.n).toBe(0);
    for (const e of effects.splice(0)) e();
    expect(told).toEqual([5]);
    expect(actor.snapshot().data.n).toBe(5);
    // A machine that starts in a final state is done before its effect, and after.
    const ended = useActorRef({ ...counter(), f: { at: 1 } } as ReturnType<typeof counter>);
    expect(ended.status()).toBe("done");
  });

  test("before its effect, a feature reading the actor's runners (child, persist) starts it", async () => {
    const { useActorRef } = await import("../src/entries/react.ts");
    const clock = new SimulatedClock();
    try {
      const log: string[] = [];
      slots = [];
      at = 0;
      const actor = useActorRef(busy(log), { now: clock.now });
      expect(log).toEqual([]);
      expect((actor as unknown as { readonly "~r": unknown })["~r"]).toBeDefined();
      expect(log).toEqual(["task"]);
      actor.stop();
      expect(log).toEqual(["task", "aborted"]);
    } finally {
      clock.uninstall();
    }
  });

  test("a stop before the effect: the actor never starts", async () => {
    const { useActorRef } = await import("../src/entries/react.ts");
    const clock = new SimulatedClock();
    try {
      const log: string[] = [];
      slots = [];
      at = 0;
      const actor = useActorRef(busy(log), { now: clock.now });
      actor.stop();
      expect(actor.status()).toBe("stopped");
      expect(actor.send({ type: "inc" })).toMatchObject({
        ok: false,
        reason: "inactive",
        snapshot: { data: { n: 0 } },
      });
      expect(log).toEqual([]);
      expect(clock.pending()).toBe(0);
    } finally {
      clock.uninstall();
    }
  });
});
