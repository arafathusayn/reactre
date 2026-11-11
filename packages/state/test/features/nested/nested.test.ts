// nested, compiled: a machine with parents reads the node graph and the hierarchy's step from the
// import, and gets the general lifecycle; one without (no dotted leaf) gets nothing. The runtime
// itself is tested on hand-written tables in test/nested.test.ts.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { change, EDITOR } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

describe("nested", () => {
  optIn("nested");

  test("a machine with parents reads g and y from the import, and its work outlives leaves' moves", () => {
    const code = compile("editor.ts", EDITOR)?.code ?? "";
    // No parallel node: the flat pair, which carries the hierarchy without the region code.
    expect(code).toContain("g: __reactreStateFlatGraph");
    expect(code).toContain("y: __reactreStateFlatNested");
    const timed = compile(
      "editor.ts",
      change(
        EDITOR,
        'edit: { on: { leave: ({ to }) => to("idle") } },',
        'edit: { after: { "1s": ({ to }) => to("idle") } },',
      ),
    )?.code;
    // A parent's timer runs through its leaves' moves: hierarchy, not lean; no other lifecycle needs.
    expect(timed).toContain("r: __reactreStateRunNested([__reactreStateTasks])");
    expect(timed).toContain('from "@reactre/state/run-nested"');
  });
});
