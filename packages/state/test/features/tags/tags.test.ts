// tags: `tags`, `meta` and `description` on nodes, read with hasTag, getMeta and getStateNodes.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { change, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { initial, transition } = await import("@reactre/state");
const { getMeta, getStateNodes, hasTag } = await import("@reactre/state/utils");
const { jobMachine } = await import("./machines.ts");

describe("tags", () => {
  optIn("tags");

  test("compiles to k: each node's tags, meta and description, trailing ones left out", () => {
    const code =
      compile(
        "door.ts",
        change(
          withUse(["tags"]),
          "open: { on:",
          'open: { tags: ["ajar"], meta: { by: "hand" }, description: "Open", on:',
        ),
      )?.code ?? "";
    expect(code).toContain('k: { "open": [["ajar"], { by: "hand" }, "Open"] }');
    const tagsOnly =
      compile("door.ts", change(withUse(["tags"]), "open: { on:", 'open: { tags: ["ajar"], on:'))?.code ?? "";
    expect(tagsOnly).toContain('k: { "open": [["ajar"]] }');
  });

  test("hasTag reads the leaf's tags and its parents'", () => {
    const idle = initial(jobMachine, undefined);
    const saving = transition(jobMachine, idle, { type: "save", text: "a" }).snapshot;
    const retrying = transition(jobMachine, saving, { type: "fail" }).snapshot;
    expect(hasTag(jobMachine, idle, "busy")).toBe(false);
    expect(hasTag(jobMachine, saving, "busy")).toBe(true);
    expect(hasTag(jobMachine, saving, "writing")).toBe(true);
    expect(hasTag(jobMachine, retrying, "writing")).toBe(false);
    expect(hasTag(jobMachine, retrying, "busy")).toBe(true);
  });

  test("getMeta gives each active node's meta, by node", () => {
    const saving = transition(jobMachine, initial(jobMachine, undefined), { type: "save", text: "a" }).snapshot;
    expect(getMeta(jobMachine, saving)).toEqual({ work: { spinner: true }, "work.saving": { label: "Saving" } });
    expect(getMeta(jobMachine, initial(jobMachine, undefined))).toEqual({});
  });

  test("getStateNodes lists the active nodes, outermost first, with what they carry", () => {
    expect(getStateNodes(jobMachine, initial(jobMachine, undefined))).toEqual([
      { node: "idle", state: "idle", data: {}, tags: [], meta: undefined, description: "Waiting for a save" },
    ]);
    const saving = transition(jobMachine, initial(jobMachine, undefined), { type: "save", text: "a" }).snapshot;
    expect(getStateNodes(jobMachine, saving).map((n) => [n.node, n.tags])).toEqual([
      ["work", ["busy"]],
      ["work.saving", ["writing"]],
    ]);
  });

  test("a final state carries its tags, meta and description too", () => {
    const saving = transition(jobMachine, initial(jobMachine, undefined), { type: "save", text: "a" }).snapshot;
    const saved = transition(jobMachine, saving, { type: "ok" }).snapshot;
    expect(saved.state).toBe("saved");
    expect(hasTag(jobMachine, saved, "done")).toBe(true);
    expect(getMeta(jobMachine, saved)).toEqual({ saved: { label: "Saved" } });
    expect(getStateNodes(jobMachine, saved)).toEqual([
      {
        node: "saved",
        state: "saved",
        data: {},
        tags: ["done"],
        meta: { label: "Saved" },
        description: "The text is saved",
      },
    ]);
  });
});
