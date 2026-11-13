// durable, compiled: the marker that `durable(machine, host)` checks; the machine keeps its own
// lifecycle for actors. The runtime is tested on hand-written tables in test/durable.test.ts.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { PAGE, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const KIDS = 'import { __kids as __reactreStateDurableKids } from "@reactre/state/durable/children";';

describe("durable", () => {
  optIn("durable", {
    door: ['u: { "durable": 1 }'],
    job: ['u: { "durable": 1 }', "r: __reactreStateLeanQuick"],
  });

  test("with children, the machine gets the hooks that journal them, from an import of their own", () => {
    const code =
      compile(
        "page.ts",
        PAGE.replace(
          'import { children } from "@reactre/state/children";',
          'import { children } from "@reactre/state/children";\nimport { durable } from "@reactre/state/durable";',
        ).replace("use: [children]", 'use: [durable, children],\n  shape: "x6ja2u07"'),
      )?.code ?? "";
    expect(code).toContain(KIDS);
    expect(code).toContain("dk: __reactreStateDurableKids");
    expect(code.split(KIDS)).toHaveLength(2);
  });

  test("off: without children, a durable machine imports none of the children code", () => {
    const code = compile("door.ts", withUse(["durable"]))?.code ?? "";
    expect(code).not.toContain("durable/children");
    expect(code).not.toContain("dk:");
  });
});
