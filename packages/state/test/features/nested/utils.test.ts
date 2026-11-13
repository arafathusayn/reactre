// The snapshot helpers of @reactre/state/utils: matches, matchesState and mapState.

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";

const { createActor } = await import("@reactre/state");
const { mapState, matches, matchesState } = await import("@reactre/state/utils");
const { formMachine } = await import("../history/machines.ts");
const { studioMachine } = await import("../parallel/machines.ts");

describe("snapshot helpers", () => {
  test("matchesState: a state is in a parent, or is it", () => {
    expect(matchesState("form", "form.details.name")).toBe(true);
    expect(matchesState("form.details", "form.details")).toBe(true);
    expect(matchesState("form", "formal")).toBe(false);
  });

  test("matches: the leaf, a parent of it, or (for a parallel node) a region's unit, all the way down", () => {
    const form = createActor(formMachine);
    form.send({ type: "open" });
    const s = form.snapshot();
    expect([
      matches(s, "form"),
      matches(s, "form.details"),
      matches(s, "form.details.name"),
      matches(s, "idle"),
    ]).toEqual([true, true, true, false]);
    if (matches(s, "form.details.name")) expect(s.data.name).toBe("");

    const studio = createActor(studioMachine);
    studio.send({ type: "power" });
    studio.send({ type: "load" });
    const p = studio.snapshot();
    expect(matches(p, "on.media.player")).toBe(true);
    expect(matches(p, "on.media.player.volume.level")).toBe(true);
    expect(matches(p, "on.chat.open")).toBe(false);
  });

  test("matches: a leaf's own data isn't a region, even when it is shaped like one", () => {
    // A snapshot read back from storage: its state is any string, so any path type-checks.
    const saved: { state: string; data: unknown } = JSON.parse(
      '{ "state": "edit", "data": { "draft": "hi", "meta": { "state": "idle", "data": {} } } }',
    );
    expect([matches(saved, "edit"), matches(saved, "edit.draft"), matches(saved, "edit.meta.idle")]).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("mapState: the results of the paths the snapshot is in, longest first", () => {
    const form = createActor(formMachine);
    form.send({ type: "open" });
    form.send({ type: "next" });
    const labels = mapState(form.snapshot(), {
      form: () => "Form",
      "form.details": () => "Details",
      "form.details.email": (s) => `Email ${s.data.email}`,
      idle: () => "Idle",
    });
    expect(labels).toEqual(["Email a@b", "Details", "Form"]);
  });
});
