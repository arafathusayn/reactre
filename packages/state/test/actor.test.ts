// The runtime, on machines compiled as a build compiles them (./compiled.ts registers the plugin).

import { describe, expect, test } from "bun:test";

import "./compiled.ts";

import type { MachineInfo, Snapshot } from "@reactre/state";

const { createRoot } = await import("@reactre/core/features/owner");
const { __none, createActor, initial, restoreActor, StateError, transition } = await import("@reactre/state");
const { useActor } = await import("@reactre/state/signals");
const { doorMachine } = await import("./fixtures/door.ts");
const { jobMachine, useSave } = await import("./fixtures/job.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));
/** A snapshot read back from JSON, typed as the machine's: restoreActor checks it at runtime. */
type Stored<M> = Snapshot<MachineInfo<M>["shape"]>;
const never = () => new Promise<string>(() => {});

describe("transition (pure)", () => {
  test("walks the machine event by event", () => {
    const s0 = initial(doorMachine, undefined);
    expect(s0).toEqual({ state: "closed", data: {}, version: 2 });
    const s1 = transition(doorMachine, s0, { type: "lock", code: "42" });
    expect(s1).toEqual({ ok: true, snapshot: { state: "locked", data: { code: "42" }, version: 2 } });
    expect(transition(doorMachine, s1.snapshot, { type: "unlock", code: "7" })).toEqual({
      ok: false,
      reason: "declined",
      snapshot: s1.snapshot,
    });
    expect(transition(doorMachine, s1.snapshot, { type: "unlock", code: "42" }).snapshot.state).toBe("closed");
  });

  test("says why an event didn't move the machine", () => {
    const s0 = initial(doorMachine, undefined);
    expect(transition(doorMachine, s0, { type: "close" })).toMatchObject({ ok: false, reason: "unhandled" });
    // An event from outside the types (JSON, another process): refused, not thrown.
    // @ts-expect-error not an event of the shape
    expect(transition(doorMachine, s0, { type: "kick" })).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("a step is its snapshot; states without data share one empty object, frozen in every build", () => {
    const s0 = initial(doorMachine, undefined);
    const s1 = transition(doorMachine, s0, { type: "push", by: "ann" }).snapshot;
    const s2 = transition(doorMachine, s1, { type: "close" }).snapshot;
    expect(Object.keys(s1)).toEqual(["state", "data", "version"]);
    expect(s2).toEqual({ state: "closed", data: {}, version: 2 });
    expect(s2.data).toBe(s0.data);
    expect(s0.data).toBe(__none);
    expect(Object.isFrozen(__none)).toBe(true);
  });

  test("a development build freezes data, so editing it throws", () => {
    const s1 = transition(doorMachine, initial(doorMachine, undefined), { type: "push", by: "ann" });
    expect(Object.isFrozen(s1.snapshot.data)).toBe(true);
    expect(() => {
      // @ts-expect-error data is readonly
      s1.snapshot.data.by = "bob";
    }).toThrow(TypeError);
  });
});

describe("actor", () => {
  test("a task's event moves the state, and a final state ends the actor", async () => {
    let finish!: (id: string) => void;
    useSave(() => new Promise((r) => (finish = r)));
    const actor = createActor(jobMachine);
    const states: string[] = [];
    actor.subscribe((s) => states.push(s.state));
    expect(actor.send({ type: "save", text: "hi" }).ok).toBe(true);
    finish("id-1");
    await tick();
    expect(actor.snapshot()).toEqual({ state: "saved", data: { id: "id-1" }, version: 0 });
    expect(actor.status()).toBe("done");
    expect(states).toEqual(["saving", "saved"]);
    expect(actor.send({ type: "save", text: "again" })).toMatchObject({ ok: false, reason: "inactive" });
  });

  test("leaving a state aborts its task and drops its late result", async () => {
    let finish!: (id: string) => void;
    let signal: AbortSignal | undefined;
    useSave((_, s) => {
      signal = s;
      return new Promise((r) => (finish = r));
    });
    const actor = createActor(jobMachine);
    actor.send({ type: "save", text: "hi" });
    expect(signal?.aborted).toBe(false);
    actor.send({ type: "cancel" });
    expect(signal?.aborted).toBe(true);
    finish("late");
    await tick();
    expect(actor.snapshot().state).toBe("idle");
  });

  test("a task that throws goes where its error handler says", async () => {
    useSave(() => Promise.reject(new Error("disk full")));
    const actor = createActor(jobMachine);
    actor.send({ type: "save", text: "hi" });
    await tick();
    expect(actor.snapshot()).toEqual({ state: "failed", data: { error: "Error: disk full" }, version: 0 });
  });

  test("a timer fires while its state lasts, and is cancelled when it exits", async () => {
    useSave(never);
    const actor = createActor(jobMachine);
    actor.send({ type: "save", text: "hi" });
    await new Promise((r) => setTimeout(r, 40));
    expect(actor.snapshot()).toEqual({ state: "failed", data: { error: "timed out" }, version: 0 });

    actor.send({ type: "retry" });
    actor.send({ type: "save", text: "hi" });
    actor.send({ type: "cancel" });
    await new Promise((r) => setTimeout(r, 40));
    expect(actor.snapshot().state).toBe("idle");
  });

  test("stop aborts the task and refuses events", () => {
    let signal: AbortSignal | undefined;
    useSave((_, s) => {
      signal = s;
      return never();
    });
    const actor = createActor(jobMachine);
    actor.send({ type: "save", text: "hi" });
    actor.stop();
    actor.stop();
    expect(signal?.aborted).toBe(true);
    expect(actor.status()).toBe("stopped");
    expect(actor.send({ type: "cancel" })).toMatchObject({ ok: false, reason: "inactive" });
  });

  test("a listener that sends is told again, in order", () => {
    const actor = createActor(doorMachine);
    const seen: string[] = [];
    actor.subscribe((s) => {
      seen.push(`a:${s.state}`);
      if (s.state === "open") actor.send({ type: "close" });
    });
    const off = actor.subscribe((s) => seen.push(`b:${s.state}`));
    actor.send({ type: "push", by: "ann" });
    expect(seen).toEqual(["a:open", "b:open", "a:closed", "b:closed"]);
    off();
    actor.send({ type: "push", by: "ann" });
    expect(seen.slice(4)).toEqual(["a:open", "a:closed"]);
  });

  test("a listener that throws doesn't stop the others; the first error is thrown after", () => {
    const actor = createActor(doorMachine);
    const seen: string[] = [];
    actor.subscribe(() => {
      throw new Error("first");
    });
    actor.subscribe(() => {
      throw new Error("second");
    });
    actor.subscribe((s) => seen.push(s.state));
    expect(() => actor.send({ type: "push", by: "ann" })).toThrow("first");
    expect(seen).toEqual(["open"]);
    expect(actor.snapshot().state).toBe("open");
    // The round ended cleanly: the next send tells everyone again.
    expect(() => actor.send({ type: "close" })).toThrow("first");
    expect(seen).toEqual(["open", "closed"]);
  });

  test("a listener subscribed in a round is told in it; one unsubscribed in it is told once more", () => {
    const actor = createActor(doorMachine);
    const seen: string[] = [];
    let offB = (): void => {};
    actor.subscribe((s) => {
      seen.push(`a:${s.state}`);
      if (s.state === "open") actor.subscribe((t) => seen.push(`c:${t.state}`));
      offB();
    });
    offB = actor.subscribe((s) => seen.push(`b:${s.state}`));
    actor.send({ type: "push", by: "ann" });
    expect(seen).toEqual(["a:open", "b:open", "c:open"]);
    actor.send({ type: "close" });
    expect(seen.slice(3)).toEqual(["a:closed", "c:closed"]);
  });

  test("a function subscribed twice is told twice, and its unsubscribe removes both", () => {
    const actor = createActor(doorMachine);
    const seen: string[] = [];
    const listener = (s: { readonly state: string }) => seen.push(s.state);
    const off = actor.subscribe(listener);
    actor.subscribe(listener);
    actor.send({ type: "push", by: "ann" });
    expect(seen).toEqual(["open", "open"]);
    off();
    actor.send({ type: "close" });
    expect(seen).toEqual(["open", "open"]);
  });

  test("an internal event sent from outside is refused at runtime too", () => {
    useSave(never);
    const actor = createActor(jobMachine);
    actor.send({ type: "save", text: "hi" });
    // @ts-expect-error internal events aren't sendable
    expect(actor.send({ type: "stored", id: "forged" })).toMatchObject({ ok: false, reason: "unknown" });
    actor.stop();
  });
});

describe("restore", () => {
  test("a saved snapshot restores", () => {
    const saved: Stored<typeof doorMachine> = JSON.parse(
      JSON.stringify({ state: "locked", data: { code: "1" }, version: 2 }),
    );
    const actor = restoreActor(doorMachine, saved);
    expect(actor.snapshot().state).toBe("locked");
    expect(actor.send({ type: "unlock", code: "1" }).ok).toBe(true);
  });

  test("a restored state's task runs again", async () => {
    useSave(async () => "again");
    const actor = restoreActor(jobMachine, { state: "saving", data: { text: "hi" }, version: 0 });
    await tick();
    expect(actor.snapshot()).toEqual({ state: "saved", data: { id: "again" }, version: 0 });
  });

  test("a snapshot of another version is refused, with the fix", () => {
    expect(() => restoreActor(doorMachine, { state: "closed", data: {}, version: 1 })).toThrow(
      /S2\].*version 1.*version 2.*Migrate/,
    );
  });

  test("a snapshot of a state the machine lacks is refused, naming the states", () => {
    const old: Stored<typeof doorMachine> = JSON.parse('{"state":"ajar","data":{},"version":2}');
    expect(() => restoreActor(doorMachine, old)).toThrow(
      new StateError("S1", 'there is no state "ajar". The states are: closed, open, locked.'),
    );
  });
});

describe("children and schemas, compiled", () => {
  test("a node's child runs while it is active, and its done decides where the parent goes", async () => {
    const { child } = await import("@reactre/state/children");
    const { pageMachine } = await import("./fixtures/uploads.ts");
    const actor = createActor(pageMachine);
    expect(child(actor, "upload")).toBeUndefined();
    actor.send({ type: "go" });
    const upload = child(actor, "upload");
    expect(upload?.snapshot()).toEqual({ state: "sending", data: { file: "a.txt" }, version: 0 });
    upload?.send({ type: "ok", url: "/a" });
    expect(actor.snapshot()).toEqual({ state: "uploaded", data: { url: "/a" }, version: 0 });
    expect(upload?.status()).toBe("done");
  });

  test("schemas check input, events and restored data at runtime", async () => {
    const { formMachine } = await import("./fixtures/uploads.ts");
    // Untyped options, which the types refuse (M590): `as never` reaches the runtime's check.
    expect(() => createActor(formMachine, JSON.parse('{"input":{"name":1}}') as never)).toThrow(/S5\].*input\.name/);
    const actor = createActor(formMachine, { input: { name: "ann" } });
    // Untyped code, which the types refuse (M429): `as never` reaches the runtime's check.
    expect(actor.send(JSON.parse('{"type":"rename","name":2}') as never)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(actor.send({ type: "rename", name: "bob" }).snapshot).toEqual({
      state: "editing",
      data: { name: "bob" },
      version: 1,
    });
    const stored: Stored<typeof formMachine> = JSON.parse('{"state":"editing","data":{"name":3},"version":1}');
    expect(() => restoreActor(formMachine, stored)).toThrow(/S7\].*"editing"/);
  });
});

describe("uncompiled", () => {
  test("setup and types in a file the plugin didn't compile throw, naming the plugin", async () => {
    const { setup, types, __shape } = await import("@reactre/state");
    expect(() => setup({ states: {}, events: {} })).toThrow(/S0\].*wasn't compiled.*@reactre\/state\/plugin\/vite/);
    expect(() => types<{}>()).toThrow(/S0\]/);
    expect(() => __shape().machine()).toThrow(/S4\].*another file/);
  });
});

test("useActor: the snapshot is a signal, and the actor stops with its owner", () => {
  let signal: AbortSignal | undefined;
  useSave((_, s) => {
    signal = s;
    return never();
  });
  const states: string[] = [];
  createRoot((dispose) => {
    const [snapshot, actor] = useActor(jobMachine);
    states.push(snapshot().state);
    actor.send({ type: "save", text: "hi" });
    states.push(snapshot().state);
    dispose();
    expect(signal?.aborted).toBe(true);
    expect(actor.status()).toBe("stopped");
  });
  expect(states).toEqual(["idle", "saving"]);
});
