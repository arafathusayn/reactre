// Execute the exact bytes emitted by a production build without importing a second, generated copy
// of the runtime into this test process. A separate Bun also keeps those temporary bytes out of the
// repository's source-coverage report. Their behavior, not a source-only substitute, is checked.

import { expect } from "bun:test";

const DRIVER = new URL("./run-emitted-driver.ts", import.meta.url).pathname;
const RESULT = "\n__reactre-emitted-result__\n";

function child(args: string[], input?: Uint8Array): string {
  const result = Bun.spawnSync([process.execPath, DRIVER, ...args], {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString();
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    resultMarker: output.includes(RESULT),
  }).toEqual({ exitCode: 0, stderr: "", resultMarker: true });
  return output;
}

function result<T>(output: string): T {
  return JSON.parse(output.slice(output.lastIndexOf(RESULT) + RESULT.length)) as T;
}

/** Import `code` in a plain Bun process and serialize the requested exports. */
export async function emittedExports<const K extends readonly string[]>(
  code: string | Uint8Array,
  ...names: K
): Promise<{ readonly [N in K[number]]: unknown }> {
  return result(child(["exports", ...names], Buffer.from(code)));
}

/** Execute the exported function of a written bundle in a plain Bun, addressed by its file URL. */
export async function emittedFileExports<T>(file: string, name = "run"): Promise<T> {
  return result(child(["file-exports", file, name]));
}

/** Import the exact emitted `code`, invoke its exported run(), and propagate its completion. */
export async function runEmitted(code: Uint8Array | string): Promise<void> {
  await emittedExports(code, "run");
}
