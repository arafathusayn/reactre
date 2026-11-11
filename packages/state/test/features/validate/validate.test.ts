// validate, compiled: the schemas in a constant, and the import's hooks in the table. The runtime
// is tested on hand-written tables in test/validate.test.ts.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { FORM } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

describe("validate", () => {
  optIn("validate");

  test("a machine with schemas reads x, z, i and its step from the import", () => {
    const code = compile("form.ts", FORM)?.code ?? "";
    expect(code).toContain("i: validate.i(__reactreStateSchemas_form.i, ");
    // The states' schemas check the data start makes.
    expect(code).toMatch(/i: validate\.i\(__reactreStateSchemas_form\.i, .*, __reactreStateSchemas_form\.d\)/);
    expect(code).toContain("x: validate.x, z: validate.z, y: validate.v()");
  });

  test("schemas for states alone: start's data is still checked, with no input schema", () => {
    const code = compile(
      "form.ts",
      FORM.replace("  input: object({ name: string() }),\n", "").replace("input.name", '"x"'),
    )?.code;
    expect(code).toContain("i: validate.i(undefined, ");
  });

  const DECIDED = 'import { __decided as __reactreStateDecided } from "@reactre/state/validate/decided";';

  test("a timer's and a task's error handlers are wrapped to check the data they decide", () => {
    const timed = FORM.replace(
      'finish: ({ to }) => to("done") } },',
      'finish: ({ to }) => to("done") }, after: { "5s": ({ data, to }) => to("editing", { name: data.name }) }, task: { run: async ({ data, signal }) => { const res = await fetch("/api/forms", { method: "POST", body: data.name, signal }); if (!res.ok) throw new Error("HTTP"); return { type: "finish" }; }, error: ({ to }) => to("editing", { name: "" }) } },',
    );
    const code = compile("form.ts", timed)?.code ?? "";
    expect(code).toContain(DECIDED);
    expect(code).toContain(
      '__reactreStateDecided((data) => ({ state: "editing", data: { name: data.name }, version: 0 }), __reactreStateSchemas_form.d, "a timer", 1)',
    );
    expect(code).toContain(
      '__reactreStateDecided(() => ({ state: "editing", data: { name: "" }, version: 0 }), __reactreStateSchemas_form.d, "a task\'s error", 2)',
    );
  });

  test("off: a machine without such a handler, or without a state's schema, imports none of it", () => {
    expect(compile("form.ts", FORM)?.code).not.toContain("decided");
    const noStateSchema = FORM.replace(
      "editing: object({ name: string() })",
      "editing: types<{ name: string }>()",
    ).replace(
      'finish: ({ to }) => to("done") } },',
      'finish: ({ to }) => to("done") }, after: { "5s": ({ to }) => to("done") } },',
    );
    expect(compile("form.ts", noStateSchema)?.code).not.toContain("decided");
  });
});
