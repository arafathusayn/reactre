import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { DOOR, JOB } from "./sources.ts";

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
  test("an unknown dynamic state name remains a diagnostic", () => {
    const source = DOOR.replaceAll('to("closed")', "to(CLOSED)").replace(
      "export const doorMachine",
      "declare const CLOSED: string;\nexport const doorMachine",
    );
    expect(() => compile("machine.ts", source)).toThrow("first argument must resolve statically");
  });
});
