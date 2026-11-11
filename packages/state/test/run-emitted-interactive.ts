// Execute the exact bytes a production build emitted, and drive them, in a separate Bun process:
// the emitted module is imported there and a script runs against its exports, so the generated
// bytes never enter this test process's source-coverage report. What is checked is the emitted
// bundle's behavior, not a source-only substitute's.
//
// This is the interactive sibling of ./run-emitted.ts: that one serializes a fixture's exports or
// runs its `run()`, while this one hands the child a script that sends events, waits a turn and
// reads snapshots, so a test can assert on a live actor built from the emitted table.

import { expect } from "bun:test";

import { build } from "esbuild";

const DRIVER = new URL("./run-emitted-interactive-driver.ts", import.meta.url).pathname;

/**
 * Import `code` in a plain Bun process and run `script` against its exports. `script` is the body
 * of an async function with `exports` (the emitted module's) and `createActor` in scope; the
 * returned trace is JSON-serialized back here, typed by `T`.
 */
export async function runEmittedInteractive<T>(code: string, script: string): Promise<T> {
  const child = Bun.spawnSync([process.execPath, DRIVER], {
    stdin: Buffer.from(JSON.stringify({ code, actor: await actorEntry(), script })),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  const output = child.stdout.toString();
  const marker = "\n__reactre-emitted-result__\n";
  const start = output.lastIndexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return (JSON.parse(output.slice(start + marker.length)) as { readonly result: T }).result;
}

/** The ordinary runtime core, outside the parent's preload. The table separately carries dev hooks. */
async function actorEntry(): Promise<{ readonly code: string }> {
  const result = await build({
    stdin: {
      contents: 'export { createActor } from "@reactre/state";',
      resolveDir: import.meta.dir,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    conditions: ["reactre-source", "module"],
    plugins: [],
  });
  const output = result.outputFiles[0];
  expect(output).toBeDefined();
  return { code: output?.text ?? "" };
}
