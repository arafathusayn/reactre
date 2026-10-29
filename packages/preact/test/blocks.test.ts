// Compiled templates (src/block.ts) and the compiler's output: each scenario in scenarios/*.tsx
// runs on Preact as written and on @reactre/preact compiled by @reactre/preact/compiler, so its
// host JSX renders as blocks. The transcripts must be equal.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileSource } from "../src/compiler.ts";
import { useDom } from "./dom.ts";
import { type Ctx, transcript } from "./same.ts";

useDom();

type Scenarios = Record<string, (t: Ctx) => unknown>;

const src = join(import.meta.dir, "../src");
// The coverage settings skip folders named reactre-plugin-*: compiled scenarios are not sources.
const out = mkdtempSync(join(tmpdir(), "reactre-plugin-preact-"));
mkdirSync(out, { recursive: true });

/** A scenario file compiled for @reactre/preact, its runtime imports pointed at this package's sources. */
async function compiled(file: string, source: "preact" | "react"): Promise<Scenarios> {
  const path = join(import.meta.dir, "scenarios", file);
  const js = compileSource(await Bun.file(path).text(), "tsx", { source });
  const entry = source === "react" ? `${src}/compat.ts` : `${src}/core.ts`;
  const code = js
    .replace(
      /from "(preact|react)\/jsx-runtime"/g,
      source === "react" ? `from "${entry}"` : `from "${src}/jsx-runtime.ts"`,
    )
    .replace(/from "(preact|react)"/g, `from "${entry}"`);
  expect(code).toContain("__hrTemplate(");
  const file2 = join(out, file.replace(/\.tsx$/, ".js"));
  await Bun.write(file2, code);
  return (await import(file2)).scenarios;
}

for (const [file, source] of [
  ["blocks.tsx", "preact"],
  ["compat-blocks.tsx", "react"],
] as const) {
  const want: Scenarios = (await import(`./scenarios/${file}`)).scenarios;
  const got = await compiled(file, source);
  describe(file, () => {
    for (const name of Object.keys(want)) {
      test(name, async () => {
        const expected = await transcript("preact", want[name]!, source === "react");
        const actual = await transcript("ours", got[name]!, source === "react");
        expect(actual).toEqual(expected);
        expect(expected.length).toBeGreaterThan(0);
      });
    }
  });
}
