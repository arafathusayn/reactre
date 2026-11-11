// history, compiled: `back` becomes a move with the parent's history flag, and `h` lists the parents
// back goes to. The runtime is tested on hand-written tables in test/nested.test.ts.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { EDITOR } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

describe("history", () => {
  optIn("history");

  test("back compiles to the parent, the fallback, and the history flag", () => {
    const code = compile("editor.ts", EDITOR)?.code ?? "";
    expect(code).toContain(
      '"resume": () => ({ b: "edit", t: ({ state: "edit.draft", data: { text: "" }, version: 0 }) })',
    );
    expect(code).toContain('h: { "edit": 1 }');
  });

  describe("deep and shallow", () => {
    const load = async () => {
      await import("../../compiled.ts");
      const { createActor } = await import("@reactre/state");
      const { formMachine } = await import("./machines.ts");
      return createActor(formMachine);
    };

    test("shallow steps compile beside the fallback", async () => {
      const source = await Bun.file(new URL("./machines.ts", import.meta.url)).text();
      const code = compile("form.ts", source)?.code ?? "";
      expect(code).toContain(
        '({ b: "form", t: ({ state: "form.details.name", data: { name: "" }, version: 0 }), s: { "details": ({ state: "form.details.name", data: { name: "again" }, version: 0 }) } })',
      );
      expect(code).toContain(
        'import { __flatGraphShallow as __reactreStateFlatShallow, __flatNested as __reactreStateFlatNested } from "@reactre/state/nested";',
      );
      expect(code).toContain("g: __reactreStateFlatShallow");
    });

    test("deep goes back to the leaf last left, with its data", async () => {
      const actor = await load();
      for (const type of ["open", "next", "leave", "deep"] as const) actor.send({ type });
      expect(actor.snapshot()).toMatchObject({ state: "form.details.email", data: { email: "a@b" } });
    });

    test("shallow re-enters the child last left through its step", async () => {
      const actor = await load();
      for (const type of ["open", "next", "leave", "shallow"] as const) actor.send({ type });
      expect(actor.snapshot()).toMatchObject({ state: "form.details.name", data: { name: "again" } });
    });

    test("shallow keeps a leaf child as it was left", async () => {
      const actor = await load();
      for (const type of ["open", "next", "check", "leave", "shallow"] as const) actor.send({ type });
      expect(actor.snapshot()).toMatchObject({ state: "form.review", data: { ok: true } });
    });

    test("with no history yet, both take the fallback", async () => {
      for (const type of ["deep", "shallow"] as const) {
        const actor = await load();
        actor.send({ type });
        expect(actor.snapshot()).toMatchObject({ state: "form.details.name", data: { name: "" } });
      }
    });
  });
});
