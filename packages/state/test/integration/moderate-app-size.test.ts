// The moderate app's production size: the editor (a parent with a timer, history and `back`), the
// app test/fixtures/sizes/nested.ts builds, bundled by esbuild with the plugin (minified,
// production) and gzipped. The bar is the user's: a moderate app under 2 KB.
//
// This is the integration suite's own pin, beside test/sizes.test.ts's per-feature budgets: it
// states the moderate-app gate on its own, so a change that grows the editor past 2 KB fails here
// with the number, whatever the per-feature budgets say.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import esbuildPlugin from "@reactre/state/plugin/esbuild";
import { build } from "esbuild";

import { runEmitted } from "../run-emitted.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** The gzipped size of `entry`'s bundle, as an app ships it. */
async function size(entry: string): Promise<number> {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    logLevel: "silent",
    // @reactre/state's sources, as the repository's own builds resolve them: dist may not be built.
    conditions: ["reactre-source", "module"],
    plugins: [esbuildPlugin({ dev: false })],
  });
  const [file] = r.outputFiles;
  if (file === undefined) throw new Error(`no bundle for ${entry}`);
  // Execute exactly the emitted bytes in a plain Bun, outside this test process's coverage.
  await runEmitted(file.contents);
  return gzipSync(file.contents).length;
}

describe("a moderate app", () => {
  test("the editor (nested and history) ships under 2 KB gzipped", async () => {
    const bytes = await size(join(FIXTURES, "sizes", "nested.ts"));
    console.log("moderate app (editor) gzipped bytes:", bytes);
    expect(bytes).toBeLessThan(2000);
  });
});
