// The transition helpers of @reactre/state/utils: can, getNextTransitions and isUnhandled, on a
// plain machine, one with effects (nothing runs), and hierarchies.

import { beforeEach, describe, expect, test } from "bun:test";

import "../../compiled.ts";

const { createActor, transition } = await import("@reactre/state");
const { can, getNextTransitions, isUnhandled } = await import("@reactre/state/utils");
const { doorMachine: plainDoor } = await import("../../fixtures/door.ts");
const { doorMachine, editorMachine, seen, treeMachine } = await import("./machines.ts");

const closed = { state: "closed", data: {}, version: 0 } as const;
const locked = { state: "locked", data: { code: "1" }, version: 2 } as const;

beforeEach(() => {
  seen.length = 0;
});

describe("can", () => {
  test("an event that moves can; an unhandled or declined one can't", () => {
    expect(can(plainDoor, locked, { type: "unlock", code: "1" })).toBe(true);
    expect(can(plainDoor, locked, { type: "unlock", code: "2" })).toBe(false);
    expect(can(plainDoor, locked, { type: "push", by: "ann" })).toBe(false);
  });

  test("of an actor's snapshot, false once it isn't active; nothing runs", () => {
    const actor = createActor(doorMachine);
    seen.length = 0;
    expect(can(doorMachine, actor, { type: "push", by: "ann" })).toBe(true);
    expect(can(doorMachine, actor, { type: "close" })).toBe(false);
    expect(seen).toEqual([]);
    actor.stop();
    expect(can(doorMachine, actor, { type: "push", by: "ann" })).toBe(false);
  });

  test("types: the machine's events only", () => {
    // @ts-expect-error An event the machine doesn't have.
    can(plainDoor, locked, { type: "kick" });
    // @ts-expect-error An event without its payload.
    can(plainDoor, locked, { type: "unlock" });
  });
});

describe("getNextTransitions", () => {
  test("each event the snapshot handles, its node and where it goes; nothing runs", () => {
    expect(getNextTransitions(doorMachine, closed, { push: [{ by: "ann" }] })).toEqual([
      { type: "push", sources: ["closed"], targets: ["open"] },
      { type: "arm", sources: ["closed"], targets: ["alarmed"] },
      { type: "wait", sources: ["closed"], targets: ["closed"] },
      { type: "disarm", sources: ["closed"], targets: ["closed"] },
      // A raise loop throws when taken: handled, with no target known.
      { type: "loop", sources: ["closed"], targets: [] },
    ]);
    expect(seen).toEqual([]);
  });

  test("a declined sample adds no target", () => {
    expect(getNextTransitions(plainDoor, locked, { unlock: [{ code: "1" }, { code: "2" }] })).toEqual([
      { type: "unlock", sources: ["locked"], targets: ["closed"] },
    ]);
    expect(getNextTransitions(plainDoor, locked, { unlock: [{ code: "2" }] })).toEqual([
      { type: "unlock", sources: ["locked"], targets: [] },
    ]);
  });

  test("in a hierarchy: the leaf's and its parents' handlers, innermost first", () => {
    const draft = { state: "edit.draft", data: { text: "" }, version: 0 } as const;
    expect(getNextTransitions(editorMachine, draft)).toEqual([
      { type: "submit", sources: ["edit.draft"], targets: ["edit.review"] },
      { type: "leave", sources: ["edit"], targets: ["idle"] },
    ]);
    const x = { state: "a.x", data: {}, version: 0 } as const;
    expect(getNextTransitions(treeMachine, x)).toEqual([{ type: "go", sources: ["a.x", "a"], targets: ["b"] }]);
  });

  test("types: samples of the machine's events, without type", () => {
    // @ts-expect-error A sample with a field the event doesn't have.
    getNextTransitions(plainDoor, locked, { unlock: [{ key: "1" }] });
  });
});

describe("isUnhandled", () => {
  test("no active node handles the event; a declined one, or a move, isn't", () => {
    const actor = createActor(plainDoor);
    const r = actor.send({ type: "close" });
    expect(isUnhandled(r)).toBe(true);
    if (isUnhandled(r)) expect(r.reason).toBe("unhandled");
    expect(isUnhandled(transition(plainDoor, locked, { type: "unlock", code: "2" }))).toBe(false);
    expect(isUnhandled(actor.send({ type: "push", by: "ann" }))).toBe(false);
  });
});
