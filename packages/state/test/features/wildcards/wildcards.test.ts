// wildcards: `on: { "*": ..., "pointer.*": ... }`, matched after the exact name, longest prefix first.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { change, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { initial, transition } = await import("@reactre/state");
const { canvasMachine } = await import("./machines.ts");

describe("wildcards", () => {
  optIn("wildcards");

  test("a wildcard key compiles under its name, and wraps the step", () => {
    const code =
      compile(
        "door.ts",
        change(
          withUse(["wildcards"]),
          'open: { on: { close: ({ to }) => to("closed") } }',
          'open: { on: { "*": ({ to }) => to("closed") } }',
        ),
      )?.code ?? "";
    expect(code).toContain('"open": { "*": () => ({ state: "closed", data: __reactreStateNone, version: 0 }) }');
    expect(code).toContain("y: wildcards.y()");
  });

  test("the exact name first, then the longest prefix, then *", () => {
    const idle = initial(canvasMachine, undefined);
    const drawing = transition(canvasMachine, idle, { type: "pointer.down", x: 1 }).snapshot;
    expect(drawing).toEqual({ state: "drawing", data: { last: "down 1" }, version: 0 });
    expect(transition(canvasMachine, drawing, { type: "pointer.move", x: 4 }).snapshot.data).toEqual({
      last: "pointer.move 4",
    });
    expect(transition(canvasMachine, drawing, { type: "pointer.up" }).snapshot).toMatchObject({
      state: "idle",
      data: { last: "up" },
    });
    expect(transition(canvasMachine, drawing, { type: "key.escape" }).snapshot).toMatchObject({
      state: "idle",
      data: { last: "key.escape" },
    });
  });

  test("a wildcard's null declines, as any handler's", () => {
    const idle = initial(canvasMachine, undefined);
    expect(transition(canvasMachine, idle, { type: "pointer.move", x: 2 }).snapshot.data).toEqual({
      last: "pointer.move",
    });
    expect(transition(canvasMachine, idle, { type: "reset" })).toMatchObject({ ok: false, reason: "declined" });
  });
});
