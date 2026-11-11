import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { DOOR, EDITOR, JOB } from "./sources.ts";

function ns(source: string): string {
  return source
    .replaceAll("import { createActor, setup, types }", "import * as S")
    .replaceAll("setup({", "S.setup({")
    .replaceAll("types<", "S.types<")
    .replaceAll("createActor(doorMachine)", "S.createActor(doorMachine)")
    .replaceAll("createActor(jobMachine)", "S.createActor(jobMachine)");
}

describe("immutable metadata", () => {
  test("state names in local constants generate the literal target in both builds", () => {
    const code =
      compile(
        "machine.ts",
        DOOR.replaceAll('to("closed")', "to(CLOSED)").replace(
          "export const doorMachine",
          'const CLOSED = "closed";\nexport const doorMachine',
        ),
      )?.code ?? "";
    expect(code).toContain('state: "closed"');
    expect(code).not.toContain("state: CLOSED");
    expect(code).toContain("const CLOSED");
  });
  test("a version can be a constant", () => {
    const source = JOB.replace("const job = setup({", "const VERSION = 2;\nconst job = setup({ version: VERSION,");
    for (const dev of [false, true]) expect(compile("machine.ts", source, { dev })?.code).toContain("v: 2");
  });
  test("a namespace import still becomes a plain table", () => {
    const code = compile("door.ts", ns(DOOR))?.code ?? "";
    expect(code).toContain('state: "open"');
    expect(code).not.toMatch(/\.setup\(|\.types</);
    expect(code).not.toContain("export const door =");
  });
  test("a feature listed through a namespace import compiles, and its hooks are read from it", () => {
    // `import * as nested from "@reactre/state/nested"` then `use: [nested.nested]`: the member is
    // the feature, and the table reads its hooks from the namespace's local name.
    const source = EDITOR.replace(
      'import { nested } from "@reactre/state/nested";',
      'import * as nested from "@reactre/state/nested";',
    ).replace("use: [nested, history]", "use: [nested.nested, history]");
    const code = compile("editor.ts", source)?.code ?? "";
    // The feature is on: the table carries its hooks, and setup's `use` is gone.
    expect(code).toContain("y: __reactreStateFlatNested");
    expect(code).not.toContain("use: [");
  });
  test("an unknown dynamic state name remains a diagnostic", () => {
    const source = DOOR.replaceAll('to("closed")', "to(CLOSED)").replace(
      "export const doorMachine",
      "declare const CLOSED: string;\nexport const doorMachine",
    );
    expect(() => compile("machine.ts", source)).toThrow("first argument must resolve statically");
  });
});
