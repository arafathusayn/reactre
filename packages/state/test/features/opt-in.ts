// What every feature's test pins first: `use: [feature]` compiles, the import stays (the table reads
// the feature's hooks from it), `use` itself is gone, and the table gains exactly what the feature
// adds. For a stub, that is nothing: the table is the one without it.

import { expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { DOOR, JOB, withUse } from "../sources.ts";

/** What `use: [feature]` adds to DOOR's table and to JOB's, as text the output contains. */
export interface Adds {
  readonly door: readonly string[];
  readonly job: readonly string[];
}

/** Registers the opt-in test of `feature`: with `adds` omitted, it adds nothing to either table. */
export function optIn(feature: string, adds?: Adds): void {
  test(`use: [${feature}] compiles, keeps its import, and adds ${adds === undefined ? "nothing to a machine that doesn't use it" : "its fields"}`, () => {
    for (const [base, added] of [
      [DOOR, adds?.door],
      [JOB, adds?.job],
    ] as const) {
      const code = compile(`${feature}.ts`, withUse([feature], base))?.code ?? "";
      const line = `import { ${feature} } from "@reactre/state/${feature}";\n`;
      expect(code).toContain(line);
      expect(code).not.toContain("use:");
      if (added === undefined) expect(code.replace(line, "")).toBe(compile(`${feature}.ts`, base)?.code ?? "");
      else for (const text of added) expect(code).toContain(text);
    }
  });
}
