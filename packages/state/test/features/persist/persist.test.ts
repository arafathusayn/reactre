// persist, compiled: the marker that `persist(actor)` checks, and the general lifecycle with the
// runner that saves deadlines. Then the stored JSON, migrations between versions, and one request of
// a backend workflow, on a machine the plugin compiles (./orders.ts). The runtime of saved timers is
// tested on hand-written tables in test/persist.test.ts and test/tasks.test.ts.

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";
import { optIn } from "../opt-in.ts";

const { createActor, restoreActor, StateError } = await import("@reactre/state");
const { migrations, persist, processEvent } = await import("@reactre/state/persist");
const { migrate, orderMachine } = await import("./orders.ts");

describe("persist", () =>
  optIn("persist", {
    door: ['u: { "persist": 1 }', "r: __reactreStateRun([])"],
    job: ['u: { "persist": 1 }', "r: __reactreStateRun([persist.t])"],
  }));

describe("the stored JSON", () => {
  const read = migrations(orderMachine);

  test("what persist(actor) stored reads back, through JSON, as it was", () => {
    const actor = createActor(orderMachine, { input: { id: "o1" }, now: () => 1000 });
    actor.send({ type: "add" });
    const stored: unknown = JSON.parse(JSON.stringify(persist(actor)));
    actor.stop();
    expect(read(stored)).toEqual({
      state: "open",
      data: { id: "o1", items: 1 },
      version: 2,
      run: { open: { t: [3_601_000] } },
    });
    expect(restoreActor(orderMachine, read(stored)).snapshot()).toEqual({
      state: "open",
      data: { id: "o1", items: 1 },
      version: 2,
    });
  });

  test.each([
    ["a string", "x", /snapshot isn't an object with state and data/],
    ["null", JSON.parse("null") as unknown, /snapshot isn't an object with state and data/],
    ["no state", { data: {}, version: 2 }, /snapshot\.state isn't a state's name \(a string\)/],
    ["data that isn't an object", { state: "open", data: 1, version: 2 }, /snapshot\.data isn't an object/],
    ["no version", { state: "open", data: {} }, /snapshot\.version isn't setup's version \(a whole number/],
    ["a Date in data", { state: "open", data: { at: new Date(0) }, version: 2 }, /snapshot\.data\.at is a Date/],
    ["undefined in data", { state: "open", data: { at: undefined }, version: 2 }, /snapshot\.data\.at is undefined/],
    ["NaN in data", { state: "open", data: { n: Number.NaN }, version: 2 }, /snapshot\.data\.n is NaN, which JSON/],
    ["a run that isn't nodes", { state: "open", data: {}, version: 2, run: { open: 1 } }, /snapshot\.run isn't/],
    ["history that isn't leaves", { state: "open", data: {}, version: 2, history: { a: 1 } }, /snapshot\.history\.a/],
  ])("%s is refused as S20, naming the path and the fix", (_, stored, message) => {
    expect(() => read(stored)).toThrow(StateError);
    expect(() => read(stored)).toThrow(message);
    expect(() => read(stored)).toThrow(/S20\].*Save it with JSON\.stringify and read it with JSON\.parse/);
  });

  // JSON.parse keeps "__proto__" as an own data property, so a stored history's "__proto__" is a
  // parent like any other: it must be validated (and refused here), not set as a prototype.
  test("a history's own __proto__ is a parent, checked like any other", () => {
    const stored: unknown = JSON.parse('{"state":"open","data":{},"version":2,"history":{"__proto__":1}}');
    expect(Object.hasOwn(stored as object, "history")).toBe(true);
    expect(() => read(stored)).toThrow(/S20\].*snapshot\.history\.__proto__ isn't an object with state and data/);
  });

  test("a snapshot from a later build is refused as S22", () => {
    expect(() => read({ state: "open", data: {}, version: 3 })).toThrow(
      /S22\] the snapshot is of version 3, newer than the machine's 2: a later build wrote it/,
    );
  });

  test("an older version with no step from it is refused as S21, naming the step to add", () => {
    expect(() => read({ state: "open", data: { id: "a", count: 1 }, version: 1 })).toThrow(
      /S21\] the snapshot is of version 1, and nothing migrates it: migrations\(machine\) has no steps\. Add \.from<1, \{ \.\.\.its states \}>/,
    );
  });

  test("an actor without persist in its use is refused as S11, naming the import", () => {
    const unmarked = { ...orderMachine, u: {} };
    expect(() => migrations(unmarked)).toThrow(/S11\] migrations\(machine\) needs persist in setup's use/);
    expect(() => processEvent(unmarked, undefined, { type: "add" }, { input: { id: "x" } })).toThrow(
      /S11\] processEvent\(machine, stored, event\) needs persist/,
    );
  });

  // M264: a stopped actor's snapshot restores into an actor that runs again, which isn't what the
  // app stopped. Refused in every build (S28): the snapshot would lie about the run, and a store
  // that saved it would resume work the app ended.
  test("M264: a stopped actor is refused as S28, naming the fix", () => {
    const actor = createActor(orderMachine, { input: { id: "o1" }, now: () => 1000 });
    actor.stop();
    expect(() => persist(actor)).toThrow(StateError);
    expect(() => persist(actor)).toThrow(/S28\] persist\(actor\) was given a stopped actor/);
    expect(() => persist(actor)).toThrow(/Save before stop\(\)/);
  });

  test("M264: an actor that ended in a final state is saved, not refused", () => {
    const actor = createActor(orderMachine, { input: { id: "o1" }, now: () => 1000 });
    actor.send({ type: "cancel" });
    expect(actor.status()).toBe("done");
    expect(persist(actor)).toMatchObject({ state: "cancelled", data: { id: "o1" } });
  });
});

describe("migrations", () => {
  test("a version-1 snapshot takes one step, and its timers start anew", () => {
    const old = { state: "open", data: { id: "o1", count: 3 }, version: 1, run: { open: { t: [5] } } };
    expect(migrate(old)).toEqual({ state: "open", data: { id: "o1", items: 3 }, version: 2 });
  });

  test("a version-0 snapshot takes every step, in order", () => {
    expect(migrate({ state: "cart", data: { id: "o1", count: 2 }, version: 0 })).toEqual({
      state: "open",
      data: { id: "o1", items: 2 },
      version: 2,
    });
    expect(migrate({ state: "done", data: { id: "o1" }, version: 0 })).toEqual({
      state: "cancelled",
      data: { id: "o1" },
      version: 2,
    });
  });

  test("a current snapshot goes through as it is, its run included", () => {
    const now = { state: "open", data: { id: "o1", items: 1 }, version: 2, run: { open: { t: [9] } } };
    expect<unknown>(migrate(now)).toEqual(now);
  });

  test("a version older than every step is refused as S21, naming the oldest step", () => {
    const short = migrations(orderMachine).from<1, { open: { id: string; count: number }; closed: { id: string } }>(
      ({ data, to }) => to("cancelled", { id: data.id }),
    );
    expect(() => short({ state: "cart", data: { id: "a", count: 1 }, version: 0 })).toThrow(
      /S21\].*version 0, and nothing migrates it: the steps go from version 1 up to 2/,
    );
  });

  test("restoreActor takes what it returns", () => {
    const actor = restoreActor(orderMachine, migrate({ state: "cart", data: { id: "o1", count: 1 }, version: 0 }));
    expect(actor.send({ type: "pay", receipt: "r1" }).snapshot).toEqual({
      state: "paid",
      data: { id: "o1", items: 1, receipt: "r1" },
      version: 2,
    });
  });
});

describe("processEvent: one request of a backend workflow", () => {
  test("nothing stored: a new actor, from input", () => {
    const { result, saved } = processEvent(orderMachine, undefined, { type: "add" }, { input: { id: "o1" } });
    expect(result).toMatchObject({ ok: true, snapshot: { state: "open", data: { id: "o1", items: 1 } } });
    expect(saved).toMatchObject({ state: "open", data: { id: "o1", items: 1 }, version: 2 });
  });

  test("the stored snapshot, migrated, takes the next event; its timer keeps its deadline", () => {
    let clock = 0;
    const now = () => clock;
    const first = processEvent(orderMachine, null, { type: "add" }, { input: { id: "o1" }, now });
    clock = 10;
    const stored: unknown = JSON.parse(JSON.stringify(first.saved));
    const second = processEvent(orderMachine, stored, { type: "add" }, { input: { id: "o1" }, now, migrate });
    expect(second.saved).toEqual({
      state: "open",
      data: { id: "o1", items: 2 },
      version: 2,
      run: { open: { t: [3_600_000] } },
    });
    const third = processEvent(
      orderMachine,
      { state: "cart", data: { id: "o2", count: 4 }, version: 0 },
      {
        type: "pay",
        receipt: "r",
      },
      { input: { id: "o2" }, migrate },
    );
    expect(third.result).toMatchObject({ ok: true, snapshot: { state: "paid", data: { items: 4, receipt: "r" } } });
  });

  test("a refused event leaves the snapshot as it was, and says why", () => {
    const stored = { state: "cancelled", data: { id: "o1" }, version: 2 };
    const { result, saved } = processEvent(orderMachine, stored, { type: "add" }, { input: { id: "o1" } });
    expect(result).toMatchObject({ ok: false, reason: "inactive" });
    expect<unknown>(saved).toEqual(stored);
  });
});
